import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserspaceVM } from "../contracts.js";
import type { ModuleCommandProgram } from "../runtime/userspace-command-abi.js";
import type { ModuleCommandsPorts } from "../runtime/workers/js-process/module-commands.js";
import { commandRelease, fakeTable, owner, server, WASM } from "../runtime/workers/js-process/module-commands.test-support.js";
import type * as VMAdapter from "../vm-adapter.js";
import type { OwnedModuleCommands } from "../vm-adapter.js";
import { closeChannels, connect, fakeVM } from "../frame/frame-vm.test-support.js";
import { enableModuleCommands } from "./commands.js";
import { pinsOf, relay } from "./commands.test-support.js";
import { moduleHandle } from "./handle.js";
import { parseLaunchArgument } from "./runner/descriptor.js";
import { buildRelease, COMMAND_DECLARATION, SERVICE_DECLARATION, type Release } from "./runner/fixtures.test-support.js";
import type { Fetcher } from "./runner/pinned.js";
import type { ModuleVM } from "./spawn.js";

/** The VMs `createVM` made, as the owner accessor knows them. Any other object reaches the real accessor. */
const vms = vi.hoisted(() => new WeakMap<object, OwnedModuleCommands>());
vi.mock("../vm-adapter.js", async importOriginal => {
  const actual = await importOriginal<typeof VMAdapter>();
  return { ...actual, ownedModuleCommands: (vm: object) => vms.get(vm) ?? actual.ownedModuleCommands(vm) };
});

afterEach(() => { closeChannels(); });

/** A Userspace VM whose module commands reach a real registration owner, in a cross-origin isolated page with a mounted image unless `overrides` say otherwise. */
function connectedVM(fetch: Fetcher, table = fakeTable(), overrides: Partial<ModuleCommandsPorts> = {}) {
  const { commands: registrations, ports } = owner(fetch, table, overrides), link = relay(registrations);
  const vm: ModuleVM = { spawnJS: () => Promise.reject(new Error("module commands start no JS process of their own")) };
  vms.set(vm, link.owned);
  return { vm, registrations, ports, table, link };
}

/** How JavaScript without types calls it: the run-time checks are for such callers. */
const untyped: { enable(vm: unknown, handle: unknown, options?: unknown): Promise<unknown> } = { enable: enableModuleCommands };

const handleOf = (release: Release) => moduleHandle(release.manifest, pinsOf(release));
const program = (registration: number, name: string): ModuleCommandProgram =>
  ({ kind: "module-command", registration, name, path: `/usr/local/bin/${name}`, terminals: { stdin: false, stdout: true, stderr: true } });
/** A module that programs run as python or python3, with an option that has a default. */
const pythonRelease = () => commandRelease(["python", "python3"], {
  declaration: { ...COMMAND_DECLARATION, id: "py", commands: ["python", "python3"], options: { mode: { type: "enum", values: ["a", "b"], default: "a" } } },
});
const commandsError = { code: "INVALID_ARGUMENT", detail: { reason: "wasm-module-commands" } } as const;
const unavailable = { code: "FEATURE_NOT_AVAILABLE", detail: { reason: "wasm-module-command-unavailable" } } as const;
/** Every cancellation of the call reads the same, wherever it stopped. */
const cancelled = { code: "ABORTED", message: "Turning module commands on was cancelled" } as const;

describe("turning commands on", () => {
  it("turns every declared command on by default, with the path of each stub, four runs at a time", async () => {
    const release = await pythonRelease(), files = server(release), { vm, table, link } = connectedVM(files.fetch);
    const commands = await enableModuleCommands(vm, handleOf(release));
    expect(commands.commands).toEqual(["python", "python3"]);
    expect(commands.paths).toEqual({ python: "/usr/local/bin/python", python3: "/usr/local/bin/python3" });
    expect(Object.isFrozen(commands) && Object.isFrozen(commands.paths) && Object.isFrozen(commands.commands)).toBe(true);
    expect(link.requests.map(request => request.operation === "enable" ? [request.commands, request.concurrency] : [])).toEqual([[["python", "python3"], 4]]);
    expect(table.tables).toEqual([[{ registration: 1, concurrency: 4, name: "python" }, { registration: 1, concurrency: 4, name: "python3" }]]);
    expect(table.stubs).toEqual(new Set(["python", "python3"]));
    // Turning them on fetched and checked each pinned file once.
    expect([...files.fetched].sort()).toEqual([...release.served.keys()].sort());
    await expect(commands.status()).resolves.toEqual({ enabled: true, skipped: [] });
  });

  it("turns on only the commands it names, in the manifest's order, with the concurrency it names", async () => {
    const release = await pythonRelease(), { vm, table } = connectedVM(server(release).fetch);
    const one = await enableModuleCommands(vm, handleOf(release), { commands: ["python3"], concurrency: 2 });
    expect([one.commands, one.paths]).toEqual([["python3"], { python3: "/usr/local/bin/python3" }]);
    expect(table.tables.at(-1)).toEqual([{ registration: 1, concurrency: 2, name: "python3" }]);
    expect(table.stubs).toEqual(new Set(["python3"]));
    await one.disable();
    const both = await enableModuleCommands(vm, handleOf(release), { commands: ["python3", "python"], concurrency: 32 });
    expect(both.commands).toEqual(["python", "python3"]);
    expect(table.tables.at(-1)).toEqual([{ registration: 2, concurrency: 32, name: "python" }, { registration: 2, concurrency: 32, name: "python3" }]);
  });

  it("refuses an empty, repeated or undeclared list of commands, a concurrency outside 1 to 32 and other fields before fetching anything", async () => {
    const release = await pythonRelease(), files = server(release), { vm, link, table } = connectedVM(files.fetch);
    const refused: readonly unknown[] = [
      { commands: [] }, { commands: ["python", "python"] }, { commands: ["node"] }, { commands: ["python", "node"] }, { commands: "python" }, { commands: [7] },
      { concurrency: 0 }, { concurrency: 33 }, { concurrency: 2.5 }, { concurrency: "4" }, { concurrency: Number.NaN },
      // A program that runs a command supplies these itself.
      { args: ["x.py"] }, { cwd: "/tmp" }, { env: { HOME: "/root" } }, { workspaceId: "w" },
      { signal: "abort" }, "python", null, [],
    ];
    for (const options of refused) await expect(untyped.enable(vm, handleOf(release), options), JSON.stringify(options)).rejects.toMatchObject(commandsError);
    expect([files.fetched, link.requests, table.tables]).toEqual([[], [], []]);
  });

  it("refuses a service, a module that declares no commands and a handle that is not one before fetching anything", async () => {
    const service = await buildRelease({ adapter: "export default () => ({ protocols: {} });", declaration: SERVICE_DECLARATION });
    const plain = await commandRelease(undefined, { declaration: COMMAND_DECLARATION });
    const release = await commandRelease(), files = server(release), { vm, link } = connectedVM(files.fetch);
    await expect(untyped.enable(vm, handleOf(service))).rejects.toMatchObject({ ...commandsError, message: expect.stringContaining("service") as unknown });
    await expect(untyped.enable(vm, handleOf(plain))).rejects.toMatchObject({ ...commandsError, message: "tool declares no commands" });
    const invalid = { code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" } };
    const forged = moduleHandle(release.manifest, { ...pinsOf(release), adapter: { ...release.descriptor.adapter, sha256: "0".repeat(64) } });
    for (const handle of [null, "tool", {}, { manifest: release.manifest }, { manifest: {}, pins: pinsOf(release) }, forged]) {
      await expect(untyped.enable(vm, handle), JSON.stringify(handle)).rejects.toMatchObject(invalid);
    }
    expect([files.fetched, link.requests]).toEqual([[], []]);
  });

  it("fixes the options once, defaults included, and refuses bad ones before fetching anything", async () => {
    const release = await pythonRelease(), files = server(release), { vm, registrations, link } = connectedVM(files.fetch);
    const options: { mode: "a" | "b" } = { mode: "b" };
    const commands = await enableModuleCommands(vm, handleOf(release), { options });
    // Every run of the commands starts with the options of this call, whatever the caller does with its object later.
    options.mode = "a";
    const sent = link.requests[0], launch = registrations.launch(program(1, "python"));
    expect(sent?.operation === "enable" ? parseLaunchArgument(sent.descriptor).options : undefined).toEqual({ mode: "b" });
    expect(parseLaunchArgument(launch?.descriptor).options).toEqual({ mode: "b" });
    await commands.disable();
    // Without options the module's defaults are written into the description: a run never resolves them again.
    await enableModuleCommands(vm, handleOf(release));
    expect(parseLaunchArgument(registrations.launch(program(2, "python"))?.descriptor).options).toEqual({ mode: "a" });
    const fetched = files.fetched.length, requests = link.requests.length;
    const optionsError = { code: "INVALID_ARGUMENT", detail: { reason: "wasm-module-options" } };
    await expect(untyped.enable(vm, handleOf(release), { options: { mode: "c" } })).rejects.toMatchObject(optionsError);
    await expect(untyped.enable(vm, handleOf(release), { options: { other: 1 } })).rejects.toMatchObject(optionsError);
    const required = await commandRelease(["tool"], { declaration: { ...COMMAND_DECLARATION, commands: ["tool"], options: { dataDir: { type: "string", maxLength: 64 } } } });
    await expect(untyped.enable(vm, handleOf(required))).rejects.toMatchObject({ ...optionsError, message: expect.stringContaining("dataDir is required") as unknown });
    expect([files.fetched.length, link.requests.length]).toEqual([fetched, requests]);
  });
});

describe("the checked files", () => {
  it("fails with wasm-module-integrity naming a file that does not match its pin, and turns nothing on", async () => {
    const tampered = await commandRelease(undefined, { tamper: { "tool.wasm": Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 1) } });
    const files = server(tampered), { vm, table, registrations } = connectedVM(files.fetch);
    await expect(enableModuleCommands(vm, handleOf(tampered))).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { reason: "wasm-module-integrity", file: "tool.wasm" } });
    expect([table.tables, registrations.launch(program(1, "alpha"))]).toEqual([[], undefined]);
    // Nothing holds the names: once the served file matches its pin again, the same call turns them on.
    files.served.set(tampered.descriptor.artifacts["tool.wasm"]?.url ?? "", WASM);
    await expect(enableModuleCommands(vm, handleOf(tampered))).resolves.toMatchObject({ commands: ["alpha", "beta"] });
  });

  it("fails with wasm-module-artifact naming a file that cannot be fetched, and turns nothing on", async () => {
    const release = await commandRelease(), files = server(release), { vm, table } = connectedVM(files.fetch);
    files.served.delete(release.descriptor.artifacts["data.bin"]?.url ?? "");
    await expect(enableModuleCommands(vm, handleOf(release))).rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { reason: "wasm-module-artifact", file: "data.bin" } });
    expect(table.tables).toEqual([]);
  });

  it("never sees a file that changed after the commands were turned on, and checks every file again when they are turned off and on", async () => {
    const release = await commandRelease(), files = server(release), { vm, registrations } = connectedVM(files.fetch);
    const url = release.descriptor.artifacts["data.bin"]?.url ?? "", original = files.served.get(url);
    const commands = await enableModuleCommands(vm, handleOf(release));
    expect(files.fetched).toHaveLength(3);
    // A new deployment changes the served file: runs keep using the copy checked when the commands were turned on.
    files.served.set(url, Uint8Array.of(9, 9, 9, 9));
    expect(await registrations.launch(program(1, "alpha"))?.artifacts["data.bin"]?.blob.arrayBuffer()).toEqual(Uint8Array.of(1, 2, 3, 4).buffer);
    expect(files.fetched).toHaveLength(3);
    // Off and on again fetches and checks every file again, so the changed one is refused.
    await commands.disable();
    await expect(enableModuleCommands(vm, handleOf(release))).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { reason: "wasm-module-integrity", file: "data.bin" } });
    if (original !== undefined) files.served.set(url, original);
    await expect(enableModuleCommands(vm, handleOf(release))).resolves.toMatchObject({ commands: ["alpha", "beta"] });
    expect(files.fetched).toHaveLength(9);
    expect(files.fetched.filter(fetched => fetched === url)).toHaveLength(3);
  });
});

describe("registrations of one VM", () => {
  it("refuses a name another call turned on, all or nothing", async () => {
    const release = await commandRelease(), other = await commandRelease(["beta", "gamma"], { declaration: { ...COMMAND_DECLARATION, id: "other", commands: ["beta", "gamma"] } });
    const files = server(release), { vm, table } = connectedVM(files.fetch);
    await enableModuleCommands(vm, handleOf(release));
    const fetched = files.fetched.length;
    await expect(enableModuleCommands(vm, handleOf(other))).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-module-command-conflict" } });
    // gamma is free, but nothing of the second module is turned on, and none of its files was fetched.
    expect([table.tables.length, [...table.stubs].sort(), files.fetched.length]).toEqual([1, ["alpha", "beta"], fetched]);
    await expect(enableModuleCommands(vm, handleOf(other), { commands: ["gamma"] })).resolves.toMatchObject({ commands: ["gamma"] });
  });

  it("reports a command whose path another file holds as skipped and keeps the others on", async () => {
    const release = await commandRelease(), { vm, table } = connectedVM(server(release).fetch, fakeTable(["beta"]));
    const commands = await enableModuleCommands(vm, handleOf(release));
    expect([commands.commands, commands.paths]).toEqual([["alpha", "beta"], { alpha: "/usr/local/bin/alpha", beta: "/usr/local/bin/beta" }]);
    await expect(commands.status()).resolves.toEqual({ enabled: true, skipped: [{ name: "beta", reason: "occupied" }] });
    expect([...table.stubs]).toEqual(["alpha"]);
  });
});

describe("VMs that cannot run module commands", () => {
  it("refuses a hosted frame's VM, a VM this SDK did not create, a root initial user, a page without cross-origin isolation and a VM without an image", async () => {
    const release = await commandRelease(), files = server(release);
    const { vm: frame } = fakeVM();
    const hosted: UserspaceVM = { ...frame, mode: "userspace", image: { ...frame.image, mode: "userspace" }, spawnJS: (): Promise<never> => Promise.reject(new Error("unused")) };
    const { client } = await connect(hosted);
    if (client.mode !== "userspace") throw new Error("Expected a Userspace frame client");
    await expect(enableModuleCommands(client, handleOf(release))).rejects.toMatchObject({ ...unavailable, message: expect.stringContaining("hosted runtime frame") as unknown });
    const foreign: ModuleVM = { spawnJS: () => Promise.reject(new Error("unused")) };
    await expect(enableModuleCommands(foreign, handleOf(release))).rejects.toMatchObject({ ...unavailable, message: expect.stringContaining("not created by this copy of the SDK") as unknown });
    for (const overrides of [
      { environment: () => ({ crossOriginIsolated: true, initialUser: "root" as const }) },
      { environment: () => ({ crossOriginIsolated: false, initialUser: "user" as const }) },
      { runtime: () => undefined },
    ] satisfies Partial<ModuleCommandsPorts>[]) {
      const { vm, table } = connectedVM(files.fetch, fakeTable(), overrides);
      await expect(enableModuleCommands(vm, handleOf(release))).rejects.toMatchObject(unavailable);
      expect(table.tables).toEqual([]);
    }
    expect(files.fetched).toEqual([]);
    await client.dispose();
  });
});

describe("cancelling the call", () => {
  it("turns nothing on when the call is cancelled before it starts or while the files are fetched", async () => {
    const release = await commandRelease(), files = server(release), { vm, link, table } = connectedVM(files.fetch);
    await expect(enableModuleCommands(vm, handleOf(release), { signal: AbortSignal.abort() })).rejects.toMatchObject(cancelled);
    expect([files.fetched, link.requests]).toEqual([[], []]);
    const fetching = Promise.withResolvers<undefined>();
    const slow = connectedVM((_url, init) => { fetching.resolve(undefined); return new Promise<Response>((_resolve, reject) => { init.signal.addEventListener("abort", () => { reject(new Error("fetch stopped")); }, { once: true }); }); }, table);
    const controller = new AbortController(), pending = enableModuleCommands(slow.vm, handleOf(release), { signal: controller.signal });
    await fetching.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject(cancelled);
    expect(table.tables).toEqual([]);
    expect(slow.registrations.launch(program(1, "alpha"))).toBeUndefined();
  });

  it("turns the commands off again when the cancellation reaches the VM after it registered them", async () => {
    const release = await commandRelease(), table = fakeTable(), { vm, registrations } = connectedVM(server(release).fetch, table);
    const controller = new AbortController(), apply = table.runtime.applyTable.bind(table.runtime);
    // The cancellation arrives while Rust applies the table: past the owner's last check, so it registers and answers.
    table.runtime.applyTable = request => { controller.abort(); return apply(request); };
    await expect(enableModuleCommands(vm, handleOf(release), { signal: controller.signal })).rejects.toMatchObject(cancelled);
    expect(table.tables).toEqual([[{ registration: 1, concurrency: 4, name: "alpha" }, { registration: 1, concurrency: 4, name: "beta" }], []]);
    expect([table.stubs, registrations.launch(program(1, "alpha"))]).toEqual([new Set(), undefined]);
    // When turning them off fails too, the cancellation says so: the commands stay on until disabled.
    const second = new AbortController();
    table.runtime.applyTable = request => { const answer = apply(request); second.abort(); table.state.refuse = { outcome: 7 }; return answer; };
    await expect(enableModuleCommands(vm, handleOf(release), { signal: second.signal })).rejects.toMatchObject({ code: "ABORTED", detail: { cleanupFailed: true, cleanupError: { code: "STORAGE_ERROR", detail: { outcome: "busy" } } } });
    expect(registrations.launch(program(2, "alpha"))).toBeDefined();
  });
});

describe("answers from the VM", () => {
  it("refuses an answer that names other commands than the call turned on", async () => {
    const release = await commandRelease(), disposed = new AbortController().signal;
    const answering = (answer: Awaited<ReturnType<OwnedModuleCommands["request"]>>) => {
      const vm: ModuleVM = { spawnJS: () => Promise.reject(new Error("unused")) };
      vms.set(vm, { request: request => Promise.resolve(request.operation === "enable" ? { operation: "enable", registration: 1, commands: ["alpha", "beta"], skipped: [] } : answer), disposed });
      return vm;
    };
    const protocol = { code: "PROTOCOL_ERROR" };
    await expect(enableModuleCommands(answering({ operation: "disable" }), handleOf(release), { commands: ["alpha"] })).rejects.toMatchObject(protocol);
    const commands = await enableModuleCommands(answering({ operation: "status", enabled: true, skipped: [{ name: "gamma", reason: "occupied" }] }), handleOf(release));
    await expect(commands.status()).rejects.toMatchObject(protocol);
    await expect(commands.disable()).rejects.toMatchObject(protocol);
  });
});

describe("turning commands off", () => {
  it("removes the stubs once, and does nothing when called again or once the VM is disposed", async () => {
    const release = await commandRelease(), { vm, table, link, registrations } = connectedVM(server(release).fetch);
    const commands = await enableModuleCommands(vm, handleOf(release));
    await commands.disable();
    expect([table.tables.at(-1), table.stubs, registrations.launch(program(1, "alpha"))]).toEqual([[], new Set(), undefined]);
    await expect(commands.status()).resolves.toEqual({ enabled: false, skipped: [] });
    const applications = table.tables.length;
    await commands.disable();
    expect(table.tables).toHaveLength(applications);
    // Once the VM is disposed its worker, and every registration, is gone: nothing is sent and nothing fails.
    const later = await enableModuleCommands(vm, handleOf(release)), requests = link.requests.length;
    link.dispose();
    await later.disable();
    await expect(later.status()).resolves.toEqual({ enabled: false, skipped: [] });
    expect(link.requests).toHaveLength(requests);
  });

  it("resolves a disable that was on its way when the VM was disposed", async () => {
    const release = await commandRelease(), { vm, link } = connectedVM(server(release).fetch);
    const commands = await enableModuleCommands(vm, handleOf(release)), gate = Promise.withResolvers<undefined>();
    link.hold(gate.promise);
    const disabling = commands.disable(), asking = commands.status();
    link.dispose();
    await expect(disabling).resolves.toBeUndefined();
    await expect(asking).resolves.toEqual({ enabled: false, skipped: [] });
    gate.resolve(undefined);
  });

  it("keeps the commands on when turning them off fails, so the call can be repeated", async () => {
    const release = await commandRelease(), { vm, table, registrations } = connectedVM(server(release).fetch);
    const commands = await enableModuleCommands(vm, handleOf(release));
    table.state.refuse = { outcome: 7 };
    await expect(commands.disable()).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { outcome: "busy" } });
    await expect(commands.status()).resolves.toEqual({ enabled: true, skipped: [] });
    expect(registrations.launch(program(1, "alpha"))).toBeDefined();
    table.state.refuse = undefined;
    await commands.disable();
    expect(table.stubs).toEqual(new Set());
  });
});
