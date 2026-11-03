import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleCommandProgram } from "../../userspace-command-abi.js";
import { encodeLaunchArgument, type LaunchDescriptor } from "../../../wasm/runner/descriptor.js";
import { buildRelease, COMMAND_DECLARATION } from "../../../wasm/runner/fixtures.test-support.js";
import { copyKey } from "../../protocol/userspace-module-files.js";
import { holdModuleFiles, moduleFileRequests, prepareModuleStart, suppliedFiles } from "./module-artifacts.js";
import { ModuleCopies } from "./module-copies.js";
import { commandRelease, enableRequest, fakeTable, live, owner, suppliedOf, WASM } from "./module-commands.test-support.js";

afterEach(() => { vi.restoreAllMocks(); });

const program = (registration: number, name = "alpha"): ModuleCommandProgram =>
  ({ kind: "module-command", registration, name, path: `/usr/local/bin/${name}`, terminals: { stdin: true, stdout: true, stderr: false } });

async function enabled(commands: ReturnType<typeof owner>["commands"], request: Parameters<ReturnType<typeof owner>["commands"]["request"]>[0]) {
  const result = await commands.request(request, live());
  if (result.operation !== "enable") throw new Error("not an enable result");
  return result;
}

const pinnedBytes = (descriptor: LaunchDescriptor): number => moduleFileRequests(descriptor).reduce((total, request) => total + request.pin.bytes, 0);

describe("verify-once module files", () => {
  it("checks each pin once and shares one copy, compiling nothing in the Userspace worker", async () => {
    const release = await commandRelease();
    const digest = vi.spyOn(crypto.subtle, "digest"), compile = vi.spyOn(WebAssembly, "compile");
    const { commands } = owner(fakeTable());
    const { registration } = await enabled(commands, enableRequest(release));
    const launches = [program(registration), program(registration, "beta"), program(registration)].map(command => commands.launch(command));
    // The adapter, the Wasm file and the data file: each hashed once. Compiled modules never cross the module frame
    // boundary, so its broker compiles them (ADR 0028).
    expect(digest).toHaveBeenCalledTimes(3);
    expect(compile).not.toHaveBeenCalled();
    expect(launches.map(launch => launch?.artifacts["tool.wasm"]?.module)).toEqual([null, null, null]);
    expect(new Set(launches.map(launch => launch?.artifacts["tool.wasm"]?.blob)).size).toBe(1);
    expect(new Set(launches.map(launch => launch?.adapter)).size).toBe(1);
  });

  it("a mismatch registers nothing", async () => {
    const release = await commandRelease(["alpha"], { tamper: { "data.bin": Uint8Array.of(1, 2, 3, 5) } });
    const { commands, table, ports } = owner();
    await expect(commands.request(enableRequest(release), live())).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { reason: "wasm-module-integrity", file: "data.bin" } });
    expect(table.tables).toEqual([]);
    expect(ports.changed).not.toHaveBeenCalled();
    await expect(commands.request({ operation: "status", registration: 1 }, live())).resolves.toEqual({ operation: "status", enabled: false, skipped: [] });
    expect(commands.launch(program(1))).toBeUndefined();
    // Nothing was kept: the next enable must supply every file again.
    expect(ports.copies.bytes).toBe(0);
    commands.reapply(fakeTable().runtime);
    expect(table.tables).toEqual([]);
  });

  it("a file the page supplies again is ignored once the VM holds it", async () => {
    const release = await commandRelease(["alpha"]), other = await commandRelease(["beta"]);
    const { commands } = owner();
    const { registration } = await enabled(commands, enableRequest(release));
    // Another registration of the same bytes: whatever the page sends for a held key is never read or kept.
    const altered = Object.fromEntries(Object.keys(suppliedOf(other)).map(key => [key, new Blob([Uint8Array.of(9, 9, 9)])]));
    const second = await enabled(commands, enableRequest(other, ["beta"], 4, altered));
    const launch = commands.launch(program(second.registration, "beta"));
    expect(new Uint8Array(await launch?.artifacts["data.bin"]?.blob.arrayBuffer() ?? new ArrayBuffer(0))).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(new Uint8Array(await launch?.artifacts["tool.wasm"]?.blob.arrayBuffer() ?? new ArrayBuffer(0))).toEqual(WASM);
    expect(await commands.launch(program(registration))?.adapter.text()).toBe("export default () => ({ main: () => 0 });");
  });

  it("disable then enable re-verifies", async () => {
    const release = await commandRelease(), digest = vi.spyOn(crypto.subtle, "digest");
    const { commands } = owner();
    const first = await enabled(commands, enableRequest(release));
    const before = commands.launch(program(first.registration))?.artifacts["tool.wasm"]?.blob;
    await commands.request({ operation: "disable", registration: first.registration }, live());
    const second = await enabled(commands, enableRequest(release));
    expect(second.registration).toBeGreaterThan(first.registration);
    expect(digest).toHaveBeenCalledTimes(2 * release.served.size);
    const after = commands.launch(program(second.registration))?.artifacts["tool.wasm"]?.blob;
    expect(after).toBeInstanceOf(Blob);
    expect(after).not.toBe(before);
  });

  it("budgets yield QUOTA_EXCEEDED", async () => {
    const limit = { code: "QUOTA_EXCEEDED", detail: { reason: "wasm-module-command-limit" } };
    // Sixteen registrations per VM.
    const releases = await Promise.all(Array.from({ length: 17 }, (_, index) => commandRelease([`c${String(index)}`])));
    const { commands, table } = owner();
    for (const release of releases.slice(0, 16)) await enabled(commands, enableRequest(release));
    const tables = table.tables.length, digest = vi.spyOn(crypto.subtle, "digest");
    const last = releases[16];
    if (last === undefined) throw new Error("missing release");
    await expect(commands.request(enableRequest(last), live())).rejects.toMatchObject(limit);
    expect([digest.mock.calls.length, table.tables.length]).toEqual([0, tables]);
    digest.mockRestore();

    // Sixty-four names per VM: four modules of sixteen fill the table.
    const wide = await Promise.all(Array.from({ length: 5 }, (_, module) => commandRelease(Array.from({ length: module === 4 ? 1 : 16 }, (_, name) => `m${String(module)}n${String(name).padStart(2, "0")}`))));
    const named = owner();
    for (const release of wide.slice(0, 4)) await enabled(named.commands, enableRequest(release));
    const fifth = wide[4];
    if (fifth === undefined) throw new Error("missing release");
    await expect(named.commands.request(enableRequest(fifth), live())).rejects.toMatchObject(limit);
    expect(named.table.tables.at(-1)).toHaveLength(64);

    // 512 MiB of verified bytes per VM, in the VM's copy store, counted from the pins before anything is read.
    const small = await commandRelease(["small"]);
    const sized = owner();
    await enabled(sized.commands, enableRequest(small));
    const large = await buildRelease({ adapter: "export default () => ({ main: () => 0 });", declaration: { ...COMMAND_DECLARATION, commands: ["large"] } });
    // Both adapters have the same bytes, so the store holds that copy once and counts it once.
    expect(large.descriptor.adapter).toMatchObject({ sha256: small.descriptor.adapter.sha256 });
    const huge = 512 * 1024 ** 2 - pinnedBytes(small.descriptor) + 1;
    const copyLimit = { code: "QUOTA_EXCEEDED", detail: { reason: "wasm-module-copy-limit" } };
    const claimed = { ...large.descriptor, manifest: { ...large.manifest, artifacts: [{ name: "huge.bin", sha256: "0".repeat(64), bytes: huge }] }, artifacts: { "huge.bin": { url: "https://app.test/modules/huge.bin", sha256: "0".repeat(64), bytes: huge } } };
    const unread = new Blob([]), read = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
    Reflect.set(unread, "arrayBuffer", read);
    await expect(sized.commands.request({ operation: "enable", descriptor: encodeLaunchArgument(claimed), commands: ["large"], concurrency: 1, files: { [copyKey(claimed.artifacts["huge.bin"])]: unread } }, live())).rejects.toMatchObject(copyLimit);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("holdModuleFiles", () => {
  it("types the copies for their blob: URLs and leaves compiling to the module frame's broker", async () => {
    const component = Uint8Array.of(0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0), broken = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff);
    const release = await buildRelease({ adapter: "export default () => ({ main: () => 0 });", artifacts: { "lib.wasm": WASM, "component.wasm": component, "broken.wasm": broken, "loader.mjs": new TextEncoder().encode("export {};"), "data.bin": Uint8Array.of(1) }, declaration: { ...COMMAND_DECLARATION, commands: ["tool"] } });
    const files = await holdModuleFiles(release.descriptor, { kind: "spawn" }, { copies: new ModuleCopies(), supply: suppliedFiles(suppliedOf(release)) }, live());
    expect(files.adapter.type).toBe("text/javascript");
    expect(Object.fromEntries(Object.entries(files.artifacts).map(([name, file]) => [name, [file.blob.type, file.module === null ? "bytes" : "module"]]))).toEqual({
      "lib.wasm": ["application/wasm", "bytes"], "component.wasm": ["application/wasm", "bytes"], "broken.wasm": ["application/wasm", "bytes"],
      "loader.mjs": ["text/javascript", "bytes"], "data.bin": ["", "bytes"],
    });
    expect(Object.isFrozen(files.artifacts)).toBe(true);
  });

  it("asks the supply only for what the store lacks, and names a file that differs from its pin", async () => {
    const release = await commandRelease(), copies = new ModuleCopies(), asked: string[][] = [];
    const supply = (files: readonly { readonly file: string }[]) => { asked.push(files.map(file => file.file)); return Promise.resolve(new Map(Object.entries(suppliedOf(release)))); };
    await holdModuleFiles(release.descriptor, { kind: "spawn" }, { copies, supply }, live());
    await holdModuleFiles(release.descriptor, { kind: "registration", id: 1 }, { copies, supply }, live());
    expect(asked).toEqual([["adapter.mjs", "tool.wasm", "data.bin"], []]);
    const forged = await commandRelease(undefined, { tamper: { "adapter.mjs": new TextEncoder().encode("export default () => ({ main: () => 1 });") } });
    await expect(holdModuleFiles(forged.descriptor, { kind: "spawn" }, { copies: new ModuleCopies(), supply: suppliedFiles(suppliedOf(forged)) }, live()))
      .rejects.toMatchObject({ code: "GUEST_CRASH", detail: { reason: "wasm-module-integrity", file: "adapter.mjs" } });
  });
});

describe("prepareModuleStart", () => {
  it("holds spawnModule's copies for the VM, so the next start supplies nothing", async () => {
    const release = await commandRelease(), copies = new ModuleCopies(), descriptor = encodeLaunchArgument(release.descriptor);
    const { launch, lease } = await prepareModuleStart(descriptor, suppliedOf(release), { copies, locks: undefined }, live());
    expect(lease).toBeUndefined();
    expect(launch).toMatchObject({ kind: "host", descriptor });
    expect(Object.keys(launch.artifacts).sort()).toEqual(["data.bin", "tool.wasm"]);
    expect(copies.missing(moduleFileRequests(release.descriptor).map(request => request.pin))).toEqual([]);
    const { launch: again } = await prepareModuleStart(descriptor, {}, { copies, locks: undefined }, live());
    expect(await again.artifacts["data.bin"]?.blob.arrayBuffer()).toEqual(Uint8Array.of(1, 2, 3, 4).buffer);
    await expect(prepareModuleStart("{}", {}, { copies, locks: undefined }, live())).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" } });
  });
});
