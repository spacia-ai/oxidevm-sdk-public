import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleCommandProgram } from "../../userspace-command-abi.js";
import { buildRelease, SERVICE_DECLARATION } from "../../../wasm/runner/fixtures.test-support.js";
import { encodeLaunchArgument } from "../../../wasm/runner/descriptor.js";
import { commandRelease, enableRequest, fakeTable, gatedAdapter, live, owner } from "./module-commands.test-support.js";
import type { ModuleCommands } from "./module-commands.js";

afterEach(() => { vi.restoreAllMocks(); });

const program = (registration: number, name: string): ModuleCommandProgram =>
  ({ kind: "module-command", registration, name, path: `/usr/local/bin/${name}`, terminals: { stdin: false, stdout: true, stderr: true } });

async function enable(commands: ModuleCommands, request: Parameters<ModuleCommands["request"]>[0], signal = live()) {
  const result = await commands.request(request, signal);
  if (result.operation !== "enable") throw new Error("not an enable result");
  return result;
}
const status = (commands: ModuleCommands, registration: number) => commands.request({ operation: "status", registration }, live());
const disable = (commands: ModuleCommands, registration: number) => commands.request({ operation: "disable", registration }, live());

/** The bodies of the worker's top-level functions, by name, from its source. */
function workerFunctions(): ReadonlyMap<string, string> {
  const source = readFileSync(new URL("../userspace.worker.ts", import.meta.url), "utf8");
  const starts = [...source.matchAll(/^(?:async )?function (\w+)\(/gmu)];
  return new Map(starts.map((start, index) => [start[1] ?? "", source.slice(start.index, starts[index + 1]?.index ?? source.length)]));
}

describe("re-applying the table", () => {
  it("applies at the three replacement sites only", () => {
    const functions = workerFunctions(), calls = (body: string | undefined) => [...(body ?? "").matchAll(/moduleCommands\.reapply\(/gu)].map(match => match.index);
    const source = [...functions.values()].join("");
    expect(calls(source)).toHaveLength(3);
    // Never where a runtime is mounted: that runs before persisted /usr/local is imported, and for scaffold remounts.
    expect(calls(functions.get("mountRuntimeRootfs"))).toEqual([]);
    // A fresh runtime started from files: once its root and workspace files are imported, before it becomes the runtime.
    const mounted = functions.get("createMountedRuntime") ?? "";
    const [fresh] = calls(mounted);
    expect(fresh).toBeGreaterThan(mounted.indexOf("workspacePersistence?.initialize("));
    expect(fresh).toBeLessThan(mounted.indexOf("runtimeState = runtime;"));
    expect(mounted.slice(mounted.lastIndexOf("if (startup === \"files\")", fresh), fresh)).not.toContain("}\n");
    // A cold start once it is published, and a restore once its runtime is the VM's.
    const checkpoints = functions.get("configureCheckpoints") ?? "", sites = calls(checkpoints);
    expect(sites).toHaveLength(2);
    const [cold, restored] = sites;
    expect(cold).toBeGreaterThan(checkpoints.indexOf("coldPublished: () => {"));
    expect(cold).toBeLessThan(checkpoints.indexOf("coldFailed: async () => {"));
    const publish = checkpoints.indexOf("publish: () => {");
    expect(restored).toBeGreaterThan(checkpoints.indexOf("runtimeState = replacement;", publish));
    expect(restored).toBeLessThan(checkpoints.indexOf("prepared.publish();", publish));
  });

  it("never applies before this VM's first enable, then applies the whole table to every replacement runtime", async () => {
    const release = await commandRelease(), table = fakeTable();
    const { commands } = owner(table);
    // VM start and runtime replacements before the first enable leave a stub of an earlier session in place.
    const earlier = fakeTable();
    commands.reapply(earlier.runtime); commands.reapply(earlier.runtime);
    expect(earlier.tables).toEqual([]);
    const { registration } = await enable(commands, enableRequest(release, ["alpha"]));
    const replacement = fakeTable();
    commands.reapply(replacement.runtime);
    expect(replacement.tables).toEqual([[{ registration, concurrency: 4, reach: "none", name: "alpha" }]]);
    expect(replacement.stubs).toEqual(new Set(["alpha"]));
    // After the last disable a replacement runtime still gets the (empty) table, so its stubs go away.
    await disable(commands, registration);
    commands.reapply(replacement.runtime);
    expect(replacement.tables.at(-1)).toEqual([]);
    expect(replacement.stubs).toEqual(new Set());
  });

  it("an occupied path is skipped and reported", async () => {
    const release = await commandRelease(), table = fakeTable(["beta"]);
    const { commands } = owner(table);
    const enabled = await enable(commands, enableRequest(release));
    expect(enabled).toMatchObject({ commands: ["alpha", "beta"], skipped: [{ name: "beta", reason: "occupied" }] });
    await expect(status(commands, enabled.registration)).resolves.toEqual({ operation: "status", enabled: true, skipped: [{ name: "beta", reason: "occupied" }] });
    // A restore that frees the path: the next application places the stub and the report clears.
    table.files.delete("beta");
    commands.reapply(table.runtime);
    await expect(status(commands, enabled.registration)).resolves.toEqual({ operation: "status", enabled: true, skipped: [] });
    expect(table.stubs).toEqual(new Set(["alpha", "beta"]));
    // An application that fails at a replacement site does not fail the replacement; every name reports it.
    table.state.refuse = { outcome: 6 };
    expect(() => { commands.reapply(table.runtime); }).not.toThrow();
    await expect(status(commands, enabled.registration)).resolves.toEqual({ operation: "status", enabled: true, skipped: [{ name: "alpha", reason: "unavailable" }, { name: "beta", reason: "unavailable" }] });
  });
});

describe("registrations", () => {
  it("reservations, duplicates and stale ids", async () => {
    const release = await commandRelease(), other = await commandRelease(["beta", "gamma"]);
    const gate = Promise.withResolvers<undefined>(), reads: string[] = [];
    const { commands, table } = owner();
    const conflict = { code: "INVALID_ARGUMENT", detail: { reason: "wasm-module-command-conflict" } };
    // The first enable reserves its names while its files are checked; a second one naming beta fails at once, reading nothing.
    const first = enable(commands, enableRequest(release, undefined, undefined, gatedAdapter(release, gate.promise, () => { reads.push("adapter"); })));
    await vi.waitFor(() => { expect(reads).toHaveLength(1); });
    const hash = vi.spyOn(crypto.subtle, "digest");
    await expect(commands.request(enableRequest(other), live())).rejects.toMatchObject(conflict);
    expect([reads, hash.mock.calls]).toEqual([["adapter"], []]);
    gate.resolve(undefined);
    const { registration } = await first;
    // All or nothing: gamma is free, beta is not, so nothing of the second module is turned on.
    await expect(commands.request(enableRequest(other), live())).rejects.toMatchObject(conflict);
    expect(table.tables).toHaveLength(1);
    await expect(commands.request({ ...enableRequest(release), commands: ["alpha", "alpha"] }, live())).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-module-commands" } });
    // A launch, status or disable naming an id this VM never issued or already retired is refused or ignored.
    expect(commands.launch(program(registration + 1, "alpha"))).toBeUndefined();
    expect(commands.launch(program(registration, "gamma"))).toBeUndefined();
    await expect(status(commands, registration + 1)).resolves.toEqual({ operation: "status", enabled: false, skipped: [] });
    await disable(commands, registration);
    await disable(commands, registration);
    expect(commands.launch(program(registration, "alpha"))).toBeUndefined();
    // Ids are never reused, and the released names can be enabled again.
    const again = await enable(commands, enableRequest(other));
    expect(again.registration).toBe(registration + 1);
  });

  it("disable re-applies before dropping copies", async () => {
    const release = await commandRelease(), table = fakeTable();
    const { commands } = owner(table);
    const { registration } = await enable(commands, enableRequest(release));
    const running = commands.launch(program(registration, "alpha"));
    const seen: unknown[] = [];
    const apply = table.runtime.applyTable.bind(table.runtime);
    table.runtime.applyTable = request => { seen.push(commands.launch(program(registration, "alpha"))); return apply(request); };
    // A refused application changes nothing: the registration and its copies stay.
    table.state.refuse = { outcome: 9, errno: 28 };
    await expect(disable(commands, registration)).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { outcome: "filesystem", errno: 28 } });
    expect(commands.launch(program(registration, "alpha"))).toBeDefined();
    table.state.refuse = undefined;
    await disable(commands, registration);
    // Rust no longer admits the stubs before the copies go, so nothing new can start between the two steps.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeDefined();
    expect(table.tables.at(-1)).toEqual([]);
    expect(commands.launch(program(registration, "alpha"))).toBeUndefined();
    // A run that started before keeps its copies.
    expect(await running?.artifacts["data.bin"]?.blob.arrayBuffer()).toEqual(Uint8Array.of(1, 2, 3, 4).buffer);
  });

  it("hands a launch the registration's verified copies, its invocation and the caller's terminals", async () => {
    const release = await commandRelease();
    const { commands, ports } = owner();
    const { registration } = await enable(commands, enableRequest(release, ["beta"], 2));
    expect(ports.changed).toHaveBeenCalledOnce();
    const launch = commands.launch(program(registration, "beta"));
    expect(launch).toMatchObject({ kind: "module-command", invocation: { name: "beta", path: "/usr/local/bin/beta" }, terminals: { stdin: false, stdout: true, stderr: true }, descriptor: encodeLaunchArgument(release.descriptor) });
    expect(Object.keys(launch?.artifacts ?? {}).sort()).toEqual(["data.bin", "tool.wasm"]);
    // alpha is declared but was not turned on.
    expect(commands.launch(program(registration, "alpha"))).toBeUndefined();
    expect(commands.launch({ ...program(registration, "beta"), path: "/usr/local/bin/alpha" })).toBeUndefined();
  });
});

describe("enable refusals", () => {
  it("refuses a VM that cannot run commands before reading anything", async () => {
    const release = await commandRelease(), hash = vi.spyOn(crypto.subtle, "digest"), unavailable = { code: "FEATURE_NOT_AVAILABLE", detail: { reason: "wasm-module-command-unavailable" } };
    for (const overrides of [
      { environment: () => ({ crossOriginIsolated: false, initialUser: "user" as const }) },
      { environment: () => ({ crossOriginIsolated: true, initialUser: "root" as const }) },
      { runtime: () => undefined },
    ]) await expect(owner(fakeTable(), overrides).commands.request(enableRequest(release), live())).rejects.toMatchObject(unavailable);
    expect(hash).not.toHaveBeenCalled();
  });

  it("refuses a service, a module without commands, an undeclared name and bad options before reading anything", async () => {
    const service = await buildRelease({ adapter: "export default () => ({ protocols: {} });", declaration: { ...SERVICE_DECLARATION, requires: { host: ["files.sync"] } } });
    const plain = await commandRelease(undefined, { declaration: { id: "tool", version: "1.0.0", abi: "bindgen", process: { kind: "command" }, requires: { host: ["files.sync"] }, license: { spdx: "MIT" } } });
    const release = await commandRelease(), optioned = await commandRelease(["alpha"], { declaration: { id: "tool", version: "1.0.0", abi: "bindgen", process: { kind: "command" }, commands: ["alpha"], requires: { host: ["files.sync"] }, license: { spdx: "MIT" }, options: { mode: { type: "enum", values: ["a", "b"] } } } });
    const hash = vi.spyOn(crypto.subtle, "digest");
    const { commands, table } = owner();
    const commandsError = { code: "INVALID_ARGUMENT", detail: { reason: "wasm-module-commands" } };
    await expect(commands.request({ operation: "enable", descriptor: encodeLaunchArgument(service.descriptor), commands: ["alpha"], concurrency: 4, files: {} }, live())).rejects.toMatchObject(commandsError);
    await expect(commands.request({ operation: "enable", descriptor: encodeLaunchArgument(plain.descriptor), commands: ["alpha"], concurrency: 4, files: {} }, live())).rejects.toMatchObject(commandsError);
    await expect(commands.request(enableRequest(release, ["gamma"]), live())).rejects.toMatchObject(commandsError);
    await expect(commands.request(enableRequest(release, []), live())).rejects.toMatchObject(commandsError);
    await expect(commands.request(enableRequest(optioned), live())).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-module-options" } });
    await expect(commands.request({ ...enableRequest(release), descriptor: "{}" }, live())).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" } });
    expect([hash.mock.calls, table.tables]).toEqual([[], []]);
  });

  it("maps a refused application to a typed error and registers nothing", async () => {
    const release = await commandRelease();
    for (const [refusal, expected] of [
      [{ outcome: 7 }, { code: "STORAGE_ERROR", detail: { outcome: "busy" } }],
      [{ outcome: 6 }, { code: "STORAGE_ERROR", detail: { outcome: "directory-unavailable" } }],
      [{ outcome: 9, errno: 28, entry: 0, changed: true }, { code: "STORAGE_ERROR", detail: { outcome: "filesystem", errno: 28, command: "alpha" } }],
      [{ outcome: 8 }, { code: "FEATURE_NOT_AVAILABLE", detail: { reason: "wasm-module-command-unavailable" } }],
      [{ outcome: 2, entry: 0 }, { code: "PROTOCOL_ERROR" }],
    ] as const) {
      const table = fakeTable();
      table.state.refuse = refusal;
      const { commands, ports } = owner(table);
      await expect(commands.request(enableRequest(release), live()), JSON.stringify(refusal)).rejects.toMatchObject(expected);
      expect(commands.launch(program(1, "alpha"))).toBeUndefined();
      expect(ports.changed).toHaveBeenCalledTimes("changed" in refusal ? 1 : 0);
      // Nothing was turned on, so the next runtime gets no table.
      const next = fakeTable();
      commands.reapply(next.runtime);
      expect(next.tables).toEqual([]);
    }
  });

  it("registers nothing when the enable is cancelled or the VM is disposed", async () => {
    const release = await commandRelease(), table = fakeTable();
    const { commands } = owner(table), controller = new AbortController();
    controller.abort(new Error("cancelled by the page"));
    await expect(commands.request(enableRequest(release), controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
    // Cancelled while a file is being checked.
    const checking = new AbortController(), slow = owner(table);
    const pending = slow.commands.request(enableRequest(release, undefined, undefined, gatedAdapter(release, new Promise<never>(() => undefined))), checking.signal);
    checking.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(table.tables).toEqual([]);
    const { registration } = await enable(commands, enableRequest(release));
    commands.dispose();
    expect(commands.launch(program(registration, "alpha"))).toBeUndefined();
    await expect(status(commands, registration)).resolves.toEqual({ operation: "status", enabled: false, skipped: [] });
  });
});
