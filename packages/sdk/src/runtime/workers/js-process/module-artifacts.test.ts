import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleCommandProgram } from "../../userspace-command-abi.js";
import { encodeLaunchArgument } from "../../../wasm/runner/descriptor.js";
import { buildRelease, COMMAND_DECLARATION } from "../../../wasm/runner/fixtures.test-support.js";
import { pinnedBytes, verifyModuleFiles } from "./module-artifacts.js";
import { commandRelease, enableRequest, fakeTable, live, owner, server, WASM } from "./module-commands.test-support.js";

afterEach(() => { vi.restoreAllMocks(); });

const program = (registration: number, name = "alpha"): ModuleCommandProgram =>
  ({ kind: "module-command", registration, name, path: `/usr/local/bin/${name}`, terminals: { stdin: true, stdout: true, stderr: false } });

async function enabled(commands: ReturnType<typeof owner>["commands"], request: Parameters<ReturnType<typeof owner>["commands"]["request"]>[0]) {
  const result = await commands.request(request, live());
  if (result.operation !== "enable") throw new Error("not an enable result");
  return result;
}

describe("verify-once module files", () => {
  it("fetches each pin once and shares one Module", async () => {
    const release = await commandRelease(), files = server(release);
    const digest = vi.spyOn(crypto.subtle, "digest"), compile = vi.fn((bytes: Uint8Array<ArrayBuffer>) => WebAssembly.compile(bytes));
    const { commands } = owner(files.fetch, fakeTable(), { compile });
    const { registration } = await enabled(commands, enableRequest(release));
    const launches = [program(registration), program(registration, "beta"), program(registration)].map(command => commands.launch(command));
    // The adapter, the Wasm file and the data file: each fetched and hashed once, the Wasm file compiled once.
    expect([...files.fetched].sort()).toEqual([...release.served.keys()].sort());
    expect(digest).toHaveBeenCalledTimes(3);
    expect(compile).toHaveBeenCalledOnce();
    const modules = launches.map(launch => launch?.artifacts["tool.wasm"]?.module);
    expect(modules[0]).toBeInstanceOf(WebAssembly.Module);
    expect(new Set(modules).size).toBe(1);
    expect(launches.map(launch => launch?.artifacts["data.bin"]?.module)).toEqual([null, null, null]);
    expect(new Set(launches.map(launch => launch?.adapter)).size).toBe(1);
  });

  it("a mismatch registers nothing", async () => {
    const release = await commandRelease(["alpha"], { tamper: { "data.bin": Uint8Array.of(1, 2, 3, 5) } }), files = server(release);
    const { commands, table, ports } = owner(files.fetch);
    await expect(commands.request(enableRequest(release), live())).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { reason: "wasm-module-integrity", file: "data.bin" } });
    expect(table.tables).toEqual([]);
    expect(ports.changed).not.toHaveBeenCalled();
    await expect(commands.request({ operation: "status", registration: 1 }, live())).resolves.toEqual({ operation: "status", enabled: false, skipped: [] });
    expect(commands.launch(program(1))).toBeUndefined();
    // Nothing was turned on, so a runtime that replaces this one gets no table either.
    commands.reapply(fakeTable().runtime);
    expect(table.tables).toEqual([]);
  });

  it("a file changed after enable is never seen", async () => {
    const release = await commandRelease(), files = server(release);
    const { commands } = owner(files.fetch);
    const { registration } = await enabled(commands, enableRequest(release));
    const fetched = files.fetched.length;
    for (const url of release.served.keys()) files.served.set(url, Uint8Array.of(9, 9, 9));
    const launch = commands.launch(program(registration));
    expect(new Uint8Array(await launch?.artifacts["data.bin"]?.blob.arrayBuffer() ?? new ArrayBuffer(0))).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(new Uint8Array(await launch?.artifacts["tool.wasm"]?.blob.arrayBuffer() ?? new ArrayBuffer(0))).toEqual(WASM);
    expect(await launch?.adapter.text()).toBe("export default () => ({ main: () => 0 });");
    expect(files.fetched).toHaveLength(fetched);
  });

  it("disable then enable re-verifies", async () => {
    const release = await commandRelease(), files = server(release), digest = vi.spyOn(crypto.subtle, "digest");
    const { commands } = owner(files.fetch);
    const first = await enabled(commands, enableRequest(release));
    const before = commands.launch(program(first.registration))?.artifacts["tool.wasm"]?.module;
    await commands.request({ operation: "disable", registration: first.registration }, live());
    const second = await enabled(commands, enableRequest(release));
    expect(second.registration).toBeGreaterThan(first.registration);
    expect(files.fetched).toHaveLength(2 * release.served.size);
    expect(digest).toHaveBeenCalledTimes(2 * release.served.size);
    const after = commands.launch(program(second.registration))?.artifacts["tool.wasm"]?.module;
    expect(after).toBeInstanceOf(WebAssembly.Module);
    expect(after).not.toBe(before);
  });

  it("budgets yield QUOTA_EXCEEDED", async () => {
    const limit = { code: "QUOTA_EXCEEDED", detail: { reason: "wasm-module-command-limit" } };
    // Sixteen registrations per VM.
    const releases = await Promise.all(Array.from({ length: 17 }, (_, index) => commandRelease([`c${String(index)}`])));
    const all = new Map(releases.flatMap(release => [...release.served]));
    const fetched: string[] = [];
    const { commands, table } = owner(url => { fetched.push(url); const bytes = all.get(url); return Promise.resolve(bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice())); });
    for (const release of releases.slice(0, 16)) await enabled(commands, enableRequest(release));
    const [fetches, tables] = [fetched.length, table.tables.length];
    const last = releases[16];
    if (last === undefined) throw new Error("missing release");
    await expect(commands.request(enableRequest(last), live())).rejects.toMatchObject(limit);
    expect([fetched.length, table.tables.length]).toEqual([fetches, tables]);

    // Sixty-four names per VM: four modules of sixteen fill the table.
    const wide = await Promise.all(Array.from({ length: 5 }, (_, module) => commandRelease(Array.from({ length: module === 4 ? 1 : 16 }, (_, name) => `m${String(module)}n${String(name).padStart(2, "0")}`))));
    const files = new Map(wide.flatMap(release => [...release.served]));
    const named = owner(url => { const bytes = files.get(url); return Promise.resolve(bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice())); });
    for (const release of wide.slice(0, 4)) await enabled(named.commands, enableRequest(release));
    const fifth = wide[4];
    if (fifth === undefined) throw new Error("missing release");
    await expect(named.commands.request(enableRequest(fifth), live())).rejects.toMatchObject(limit);
    expect(named.table.tables.at(-1)).toHaveLength(64);

    // 512 MiB of verified bytes per VM, counted from the pins before anything is fetched.
    const small = await commandRelease(["small"]), smallFiles = server(small);
    const sized = owner(smallFiles.fetch);
    await enabled(sized.commands, enableRequest(small));
    const large = await buildRelease({ adapter: "export default () => ({ main: () => 0 });", declaration: { ...COMMAND_DECLARATION, commands: ["large"] } });
    const huge = 512 * 1024 ** 2 - pinnedBytes(small.descriptor) - large.descriptor.adapter.bytes + 1;
    const claimed = { ...large.descriptor, manifest: { ...large.manifest, artifacts: [{ name: "huge.bin", sha256: "0".repeat(64), bytes: huge }] }, artifacts: { "huge.bin": { url: "https://app.test/modules/huge.bin", sha256: "0".repeat(64), bytes: huge } } };
    const before = smallFiles.fetched.length;
    await expect(sized.commands.request({ operation: "enable", descriptor: encodeLaunchArgument(claimed), commands: ["large"], concurrency: 1 }, live())).rejects.toMatchObject(limit);
    expect(smallFiles.fetched).toHaveLength(before);
  });
});

describe("verifyModuleFiles", () => {
  it("types the copies for their blob: URLs, compiles only core modules and keeps a module that does not compile as bytes", async () => {
    const component = Uint8Array.of(0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0), broken = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff);
    const release = await buildRelease({ adapter: "export default () => ({ main: () => 0 });", artifacts: { "lib.wasm": WASM, "component.wasm": component, "broken.wasm": broken, "loader.mjs": new TextEncoder().encode("export {};"), "data.bin": Uint8Array.of(1) }, declaration: { ...COMMAND_DECLARATION, commands: ["tool"] } });
    const files = await verifyModuleFiles(release.descriptor, { fetch: server(release).fetch }, live());
    expect(files.adapter.type).toBe("text/javascript");
    expect(Object.fromEntries(Object.entries(files.artifacts).map(([name, file]) => [name, [file.blob.type, file.module === null ? "bytes" : "module"]]))).toEqual({
      "lib.wasm": ["application/wasm", "module"], "component.wasm": ["application/wasm", "bytes"], "broken.wasm": ["application/wasm", "bytes"],
      "loader.mjs": ["text/javascript", "bytes"], "data.bin": ["", "bytes"],
    });
    expect(files.bytes).toBe(pinnedBytes(release.descriptor));
    expect(Object.isFrozen(files.artifacts)).toBe(true);
  });

  it("names a file that cannot be fetched and passes cancellation through unchanged", async () => {
    const release = await commandRelease(), missing = server(release);
    missing.served.delete(release.descriptor.artifacts["tool.wasm"]?.url ?? "");
    await expect(verifyModuleFiles(release.descriptor, { fetch: missing.fetch }, live())).rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { reason: "wasm-module-artifact", file: "tool.wasm" } });
    const offline = server(release);
    await expect(verifyModuleFiles(release.descriptor, { fetch: url => url === release.descriptor.adapter.url ? offline.fetch(url, { signal: live() }) : Promise.reject(new TypeError("Failed to fetch")) }, live()))
      .rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { reason: "wasm-module-artifact", file: "tool.wasm" } });
    const forged = server(release);
    forged.served.set(release.descriptor.adapter.url, new TextEncoder().encode("export default () => ({ main: () => 1 });"));
    await expect(verifyModuleFiles(release.descriptor, { fetch: forged.fetch }, live())).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { reason: "wasm-module-integrity", file: "adapter.mjs" } });
    const controller = new AbortController();
    const pending = verifyModuleFiles(release.descriptor, { fetch: (_url, init) => new Promise<Response>((_resolve, reject) => { init.signal.addEventListener("abort", () => { reject(new Error("stopped")); }); }) }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("stopped");
  });
});
