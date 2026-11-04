import { afterEach, describe, expect, it, vi } from "vitest";
import { isolationUnavailable } from "./runtime/protocol/module-isolation.js";
import type { ModuleFrameOpener } from "./module-execution.js";
import { adaptVM, bindFrameOwner, ownedModuleCommands, ownedModules } from "./vm-adapter.js";
import { record } from "./runtime/decode.js";
import { decodePublicVMOptions } from "./vm-options.js";
import { decodeSHA256 } from "./values.js";
import { VMError } from "./runtime/errors.js";
import { bootedManagedVm, ScriptedWorker } from "./runtime/system-vm.test-support.js";
import type { PipeJSProcessSpec, WorkspaceChange, WorkspaceFileEntry, WorkspaceWatch } from "./contracts.js";
import type { SnapshotInfo } from "./runtime/snapshot-types.js";
import type { ModuleCommandsRequest } from "./runtime/protocol/userspace-module-commands.js";
import { copyKey } from "./runtime/protocol/userspace-module-files.js";
import { tlsPin } from "./wasm/net/tls-file.js";
import { buildRelease, COMMAND_DECLARATION } from "./wasm/runner/fixtures.test-support.js";
import { encodeLaunchArgument } from "./wasm/runner/descriptor.js";
import type { Capability } from "./wasm/capabilities.js";

/** ADR 0028: the module frames a VM opens, faked: each open answers a frame whose loss the test reports. */
const frames = { open: vi.fn<ModuleFrameOpener["open"]>(), lost: [] as (() => void)[] };
const fakeFrames: ModuleFrameOpener = {
  open: (sources, signal) => frames.open(sources, signal),
  sources: () => Promise.resolve({ broker: new Blob(["broker"]), runner: new Blob(["runner"]) }),
  watch: (_frame, lost) => { frames.lost.push(lost); return () => undefined; },
};

const ACCEL = { available: true } as const;
const NOT_APPLICABLE = { available: false, reason: "mode-unsupported" } as const;

afterEach(() => { ScriptedWorker.reset(); vi.unstubAllGlobals(); });

it.each(["system", "userspace"] as const)("advertises native snapshots for %s", async mode => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("navigator", { storage: undefined }); vi.stubGlobal("location", new URL("https://ide.test/"));
  const runtime = await bootedManagedVm();
  const vm = await adaptVM(runtime, decodePublicVMOptions({ mode }),
    { id: "test", version: "1", mode, manifestSHA256: decodeSHA256("a".repeat(64), "test"), cpuProfile: "x86-64-v3", signatureVerified: true, keyId: "test" },
    { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), lazy: () => Promise.reject(new Error("unused")), dispose: vi.fn() }, { tier: "development" }, mode === "system" ? NOT_APPLICABLE : ACCEL, { start: { kind: "booted", reason: "first-start" } });
  try { expect(vm.capabilities.snapshots).toEqual({ available: true }); }
  finally { await vm.dispose(); }
});

it.each([
  { name: "missing StorageManager", storage: undefined, expected: "best-effort" },
  { name: "refused retention query", storage: { persisted: () => Promise.reject(new Error("refused")) }, expected: "best-effort" },
  { name: "granted retention", storage: { persisted: () => Promise.resolve(true) }, expected: "granted" },
])("reports actual durable storage with $name", async ({ storage, expected }) => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("crossOriginIsolated", true); vi.stubGlobal("navigator", { storage });
  vi.stubGlobal("location", new URL("https://ide.example.test/"));
  const runtime = await bootedManagedVm();
  const assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), lazy: () => Promise.reject(new Error("unused")), dispose: vi.fn() };
  try {
    const vm = await adaptVM(runtime, decodePublicVMOptions({ mode: "system", workspaceId: "retention" }), {
      id: "test", version: "1", mode: "system", manifestSHA256: decodeSHA256("a".repeat(64), "test manifest"), cpuProfile: "x86-64-v3", signatureVerified: true, keyId: "test",
    }, assets, { tier: "development" }, NOT_APPLICABLE, { start: { kind: "booted", reason: "first-start" } });
    expect(vm.workspace.persistence).toEqual({ kind: "persistent", backend: "opfs", browserRetention: expected });
    await vm.dispose(); expect(assets.dispose).toHaveBeenCalledOnce();
  } finally { await runtime.dispose(); }
});

it("exposes the runtime's own network owner as vm.network", async () => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("crossOriginIsolated", true); vi.stubGlobal("navigator", { storage: undefined });
  vi.stubGlobal("location", new URL("https://ide.example.test/"));
  const runtime = await bootedManagedVm();
  const assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), lazy: () => Promise.reject(new Error("unused")), dispose: vi.fn() };
  try {
    const vm = await adaptVM(runtime, decodePublicVMOptions({ mode: "system", network: { mode: "local" } }), {
      id: "test", version: "1", mode: "system", manifestSHA256: decodeSHA256("a".repeat(64), "test manifest"), cpuProfile: "x86-64-v3", signatureVerified: true, keyId: "test",
    }, assets, { tier: "development" }, NOT_APPLICABLE, { start: { kind: "booted", reason: "first-start" } });
    expect(vm.network).toBe(runtime.network);
    expect(vm.network).toBe(vm.network);
    expect(vm.network.state).toEqual({ kind: "off" });
    await vm.dispose();
    // The disposed owner itself refuses new connections; the public VM adds no mirror.
    await expect(vm.network.connect({ kind: "personal" })).rejects.toMatchObject({ code: "ABORTED" });
    expect(vm.network).toBe(runtime.network);
  } finally { await runtime.dispose(); }
});

it("exposes the runtime workspace's own file methods on vm.workspace and refuses them after disposal", async () => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("crossOriginIsolated", true); vi.stubGlobal("navigator", { storage: undefined });
  vi.stubGlobal("location", new URL("https://ide.example.test/"));
  const runtime = await bootedManagedVm();
  const assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), lazy: () => Promise.reject(new Error("unused")), dispose: vi.fn() };
  const entry: WorkspaceFileEntry = { kind: "file", link: null, name: "a.txt", path: "/a.txt", size: 2, version: "0".repeat(48) };
  const watch: WorkspaceWatch = { done: Promise.resolve(), setDirectories: () => Promise.resolve() };
  const runtimeWorkspace = runtime.workspace;
  const entries = vi.spyOn(runtimeWorkspace, "entries").mockResolvedValue([entry]);
  const stat = vi.spyOn(runtimeWorkspace, "stat").mockResolvedValue(entry);
  const read = vi.spyOn(runtimeWorkspace, "read").mockResolvedValue({ entry, data: new Uint8Array([104, 105]) });
  const write = vi.spyOn(runtimeWorkspace, "write").mockResolvedValue(entry);
  const createDirectory = vi.spyOn(runtimeWorkspace, "createDirectory").mockResolvedValue();
  const rename = vi.spyOn(runtimeWorkspace, "rename").mockResolvedValue();
  const watching = vi.spyOn(runtimeWorkspace, "watch").mockReturnValue(watch);
  try {
    const vm = await adaptVM(runtime, decodePublicVMOptions({ mode: "system", workspaceId: "files" }), {
      id: "test", version: "1", mode: "system", manifestSHA256: decodeSHA256("a".repeat(64), "test manifest"), cpuProfile: "x86-64-v3", signatureVerified: true, keyId: "test",
    }, assets, { tier: "development" }, NOT_APPLICABLE, { start: { kind: "booted", reason: "first-start" } });
    const signal = new AbortController().signal;
    const bytes = new Uint8Array([1]);
    const onChange = vi.fn<(changes: readonly WorkspaceChange[]) => void>();
    expect(await vm.workspace.entries("/src", signal)).toEqual([entry]);
    expect(await vm.workspace.stat("/a.txt", signal)).toBe(entry);
    expect(await vm.workspace.read("/a.txt", { maxBytes: 10, signal })).toEqual({ entry, data: new Uint8Array([104, 105]) });
    expect(await vm.workspace.write("/a.txt", bytes, { ifVersion: null, signal })).toBe(entry);
    await vm.workspace.createDirectory("/dir", { signal });
    await vm.workspace.rename("/a.txt", "/b.txt", { signal });
    expect(vm.workspace.watch(onChange, { signal })).toBe(watch);
    expect(entries).toHaveBeenCalledWith("/src", signal);
    expect(stat).toHaveBeenCalledWith("/a.txt", signal);
    expect(read).toHaveBeenCalledWith("/a.txt", { maxBytes: 10, signal });
    expect(write).toHaveBeenCalledWith("/a.txt", bytes, { ifVersion: null, signal });
    expect(createDirectory).toHaveBeenCalledWith("/dir", { signal });
    expect(rename).toHaveBeenCalledWith("/a.txt", "/b.txt", { signal });
    expect(watching).toHaveBeenCalledWith(onChange, { signal });
    await vm.dispose();
    await expect(vm.workspace.stat("/a.txt")).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    let refused: unknown;
    try { vm.workspace.watch(onChange, { signal }); } catch (error) { refused = error; }
    expect(refused).toMatchObject({ code: "PROTOCOL_ERROR" });
  } finally { await runtime.dispose(); }
});

it("reports how a Userspace VM's saved /workspace met its image, in-sync without a report", async () => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("crossOriginIsolated", true); vi.stubGlobal("navigator", { storage: undefined });
  vi.stubGlobal("location", new URL("https://ide.example.test/"));
  const runtime = await bootedManagedVm();
  const assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), lazy: () => Promise.reject(new Error("unused")), dispose: vi.fn() };
  const image = { id: "test", version: "1", mode: "userspace" as const, manifestSHA256: decodeSHA256("a".repeat(64), "test manifest"), cpuProfile: "x86-64-v3" as const, signatureVerified: true as const, keyId: "test" };
  const workspace = { state: "conflict-preserved" as const, conflicts: [{ reason: "changed-in-both" as const, path: "/workspace/app.ts" }], omittedConflicts: 0 };
  try {
    const reported = await adaptVM(runtime, decodePublicVMOptions({ mode: "userspace", workspaceId: "userspace" }), image, assets, { tier: "development" }, ACCEL, { workspace });
    expect(reported.start).toEqual({ kind: "booted", reason:"first-start", workspaceDetails:workspace });
    const quiet = await adaptVM(runtime, decodePublicVMOptions({ mode: "userspace", workspaceId: "userspace" }), image, assets, { tier: "development" }, ACCEL);
    expect(quiet.start).toEqual({ kind: "booted", reason:"first-start", workspaceDetails: { state: "in-sync", conflicts: [], omittedConflicts: 0 } });
  } finally { await runtime.dispose(); }
});

it("delivers holder handoff before ending its subscription and retires public resources",async()=>{
 vi.stubGlobal("Worker",ScriptedWorker);vi.stubGlobal("crossOriginIsolated",true);vi.stubGlobal("navigator",{storage:undefined});vi.stubGlobal("location",new URL("https://ide.test/"));
 const runtime=await bootedManagedVm(),assets={urls:new Map<string,string>(),compile:()=>Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))),lazy:()=>Promise.reject(new Error("unused")),dispose:vi.fn()},register=vi.spyOn(runtime,"allowWorkspaceHandoff").mockImplementation(()=>{});
 const vm=await adaptVM(runtime,decodePublicVMOptions({mode:"system"}),{id:"test",version:"1",mode:"system",manifestSHA256:decodeSHA256("a".repeat(64),"test"),cpuProfile:"x86-64-v3",signatureVerified:true,keyId:"test"},assets,{tier:"development"},NOT_APPLICABLE,{start:{kind:"booted",reason:"first-start"}});
 const order:string[]=[],subscription=vm.allowWorkspaceHandoff(()=>order.push("moved"),{signal:new AbortController().signal}).then(()=>order.push("ended"));
 const call=register.mock.calls[0];if(call===undefined)throw new Error("missing holder listener");call[0]({saved:true});await subscription;
 expect(order).toEqual(["moved","ended"]);await vm.dispose();expect(assets.dispose).toHaveBeenCalledOnce();
});

it.each(["system", "userspace"] as const)("rejects malformed %s handoff registrations before registering a holder", async mode => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("navigator", { storage: undefined }); vi.stubGlobal("location", new URL("https://ide.test/"));
  const runtime = await bootedManagedVm(), assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), lazy: () => Promise.reject(new Error("unused")), dispose: vi.fn() };
  const register = vi.spyOn(runtime, "allowWorkspaceHandoff").mockImplementation(() => {});
  const vm = await adaptVM(runtime, decodePublicVMOptions({ mode }),
    { id: "test", version: "1", mode, manifestSHA256: decodeSHA256("a".repeat(64), "test"), cpuProfile: "x86-64-v3", signatureVerified: true, keyId: "test" },
    assets, { tier: "development" }, mode === "system" ? NOT_APPLICABLE : ACCEL, { start: { kind: "booted", reason: "first-start" } });
  const untyped: { allowWorkspaceHandoff(listener: unknown, options?: unknown): Promise<void> } = vm;
  try {
    const cases: readonly [unknown, (signal: AbortSignal) => unknown][] = [
      [null, signal => ({ signal })], [42, signal => ({ signal })],
      [() => {}, () => undefined], [() => {}, () => null], [() => {}, () => ({})],
      [() => {}, () => ({ signal: {} })], [() => {}, signal => ({ signal, unexpected: true })],
    ];
    for (const [listener, options] of cases) {
      const controller = new AbortController();
      const rejection = expect(untyped.allowWorkspaceHandoff(listener, options(controller.signal))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      controller.abort();
      await rejection;
      expect(register).not.toHaveBeenCalled();
      expect(assets.dispose).not.toHaveBeenCalled();
    }
  } finally { await vm.dispose(); }
});

it("ends valid local handoff subscriptions on abort and disposal", async () => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("navigator", { storage: undefined }); vi.stubGlobal("location", new URL("https://ide.test/"));
  const runtime = await bootedManagedVm(), assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), lazy: () => Promise.reject(new Error("unused")), dispose: vi.fn() };
  const register = vi.spyOn(runtime, "allowWorkspaceHandoff").mockImplementation(() => {});
  const vm = await adaptVM(runtime, decodePublicVMOptions({ mode: "system" }),
    { id: "test", version: "1", mode: "system", manifestSHA256: decodeSHA256("a".repeat(64), "test"), cpuProfile: "x86-64-v3", signatureVerified: true, keyId: "test" }, assets, { tier: "development" }, NOT_APPLICABLE, { start: { kind: "booted", reason: "first-start" } });
  const moved = vi.fn(), controller = new AbortController();
  register.mockImplementationOnce(() => { throw new VMError("FEATURE_NOT_AVAILABLE", "handoff owner is unavailable"); });
  await expect(vm.allowWorkspaceHandoff(moved, { signal: controller.signal })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
  expect(assets.dispose).not.toHaveBeenCalled();
  const revoked = vm.allowWorkspaceHandoff(moved, { signal: controller.signal });
  controller.abort(); await revoked;
  expect(assets.dispose).not.toHaveBeenCalled();
  const disposed = vm.allowWorkspaceHandoff(moved, { signal: new AbortController().signal });
  await vm.dispose(); await disposed;
  expect(moved).not.toHaveBeenCalled();
  expect(register.mock.calls.slice(1).every(call => call[1].signal.aborted)).toBe(true);
});

it.each(["system", "userspace"] as const)("%s keeps the requested update offer coherent after restoring another image", async mode => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("navigator", { storage: undefined }); vi.stubGlobal("location", new URL("https://ide.test/"));
  const runtime = await bootedManagedVm(), assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), lazy: () => Promise.reject(new Error("unused")), dispose: vi.fn() };
  const old = { id: "test", version: "old", mode, manifestSHA256: decodeSHA256("a".repeat(64), "test"), cpuProfile: "x86-64-v3" as const, signatureVerified: true as const, keyId: "test" };
  let running = old;
  vi.spyOn(runtime, "imageIdentity", "get").mockImplementation(() => running);
  const point: SnapshotInfo = { mode, ref: { id: "123e4567-e89b-42d3-a456-426614174101", createdAt: "2026-10-13T12:00:00.000Z" },
    kind: "named", capturedAtUnixMs: 0, profile: null, bytes: { ram: 0, disk: 0, unique: 0 }, resumable: true };
  const restoring = vi.spyOn(runtime.snapshots, "restore").mockResolvedValue({ start: { kind: "resumed", snapshot: point, appData: null, terminals: [], workspace: "in-sync", newerFilesDropped: false } });
  const vm = await adaptVM(runtime, decodePublicVMOptions({ mode }), old, assets, { tier: "development" }, mode === "system" ? NOT_APPLICABLE : ACCEL,
    { start: { kind: "booted", reason: "restart" }, update: { id: "test", version: "new" } });
  try {
    expect((await vm.snapshots.restore(point.ref)).start.update).toEqual({ id: "test", version: "new" });
    running = { ...old, version: "new" };
    restoring.mockResolvedValue({ start: { kind: "resumed", snapshot: point, appData: null, terminals: [], workspace: "in-sync", newerFilesDropped: false,
      update: { id: "test", version: "old" } } });
    expect((await vm.snapshots.restore(point.ref)).start.update).toBeUndefined();
    expect(vm.image.version).toBe("new");
  } finally { await vm.dispose(); }
});

it("starts spawnModule's runner from the VM's copies through the VM's owner record, and refuses VMs that cannot run it", async () => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("crossOriginIsolated", true); vi.stubGlobal("navigator", { storage: undefined });
  vi.stubGlobal("location", new URL("https://ide.example.test/"));
  const runtime = await bootedManagedVm(), started: unknown[] = [], asked: unknown[] = [];
  runtime.spawnModule = spec => { started.push(spec); return Promise.reject(new VMError("ABORTED", "the test runtime starts nothing")); };
  runtime.moduleFiles = (pins, options) => { asked.push([pins, options]); return Promise.resolve([]); };
  runtime.attachModuleFrame = () => Promise.resolve();
  frames.open.mockImplementation(() => Promise.resolve({ port: new MessageChannel().port1, dispose: () => undefined }));
  const assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), lazy: () => Promise.reject(new Error("unused")), dispose: vi.fn() };
  const image = { id: "test", version: "1", manifestSHA256: decodeSHA256("a".repeat(64), "test"), cpuProfile: "x86-64-v3", signatureVerified: true, keyId: "test" } as const;
  const vm = await adaptVM(runtime, decodePublicVMOptions({ mode: "userspace" }), { ...image, mode: "userspace" }, assets, { tier: "development" }, ACCEL, { start: { kind: "booted", reason: "first-start" }, moduleFrames: fakeFrames });
  const system = await adaptVM(runtime, decodePublicVMOptions({ mode: "system" }), { ...image, mode: "system" }, assets, { tier: "development" }, NOT_APPLICABLE, { start: { kind: "booted", reason: "first-start" } });
  if (vm.mode !== "userspace") throw new Error("Expected a Userspace VM");
  const start = { descriptor: "{\"v\":1}", files: {} } as const, pin = { sha256: "a".repeat(64), bytes: 4 };
  try {
    const modules = ownedModules(vm);
    await expect(modules.spawn({ args: ["in.md"] }, start)).rejects.toMatchObject({ code: "ABORTED" });
    // The runtime chooses the runner: the page names none, and the description travels beside argv, never in it.
    expect(started).toEqual([expect.objectContaining({ args: ["in.md"], descriptor: start.descriptor, files: {} })]);
    expect(record(started[0], "module start")["worker"]).toBeUndefined();
    // Without a cwd the module starts in /workspace, as spawnModule did before ADR 0028 (0.0.9 and earlier); a cwd is kept.
    expect(record(started[0], "module start")["cwd"]).toBe("/workspace");
    await expect(modules.spawn({ args: [], cwd: "/tmp" }, start)).rejects.toMatchObject({ code: "ABORTED" });
    expect(record(started[1], "module start")["cwd"]).toBe("/tmp");
    await expect(modules.missing([pin], undefined)).resolves.toEqual([]);
    expect(asked).toEqual([[[pin], {}]]);
    // Another object with a spawnJS, a System VM and a hosted frame's VM have no runner to start.
    const refusal = (vmLike: object): unknown => { try { ownedModules(vmLike); return undefined; } catch (error: unknown) { return error; } };
    expect(refusal({ spawnJS: (spec: PipeJSProcessSpec) => vm.spawnJS(spec) })).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(refusal(system)).toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
    const hosted = { ...vm };
    bindFrameOwner(hosted, { diagnostics: { readJSProcessTrace: () => Promise.reject(new Error("unused")), watchAccelerationNotices: () => Promise.reject(new Error("unused")) } });
    expect(refusal(hosted)).toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
    // A disposed VM starts nothing.
    await vm.dispose();
    await expect(modules.spawn({}, start)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await expect(modules.missing([pin], undefined)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(started).toHaveLength(2);
  } finally { await system.dispose(); await runtime.dispose(); }
});

// Engine ADR 0027: enableModuleCommands reaches a VM's module commands only through its owner record.
it("sends module-command requests through a Userspace VM's owner record until the VM is disposed, and refuses VMs that cannot run them", async () => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("crossOriginIsolated", true); vi.stubGlobal("navigator", { storage: undefined });
  vi.stubGlobal("location", new URL("https://ide.example.test/"));
  const runtime = await bootedManagedVm();
  const assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), lazy: () => Promise.reject(new Error("unused")), dispose: vi.fn() };
  const image = { id: "test", version: "1", manifestSHA256: decodeSHA256("a".repeat(64), "test"), cpuProfile: "x86-64-v3", signatureVerified: true, keyId: "test" } as const;
  const vm = await adaptVM(runtime, decodePublicVMOptions({ mode: "userspace" }), { ...image, mode: "userspace" }, assets, { tier: "development" }, ACCEL, { start: { kind: "booted", reason: "first-start" } });
  const system = await adaptVM(runtime, decodePublicVMOptions({ mode: "system" }), { ...image, mode: "system" }, assets, { tier: "development" }, NOT_APPLICABLE, { start: { kind: "booted", reason: "first-start" } });
  const refusal = (vmLike: object): unknown => { try { ownedModuleCommands(vmLike); return undefined; } catch (error: unknown) { return error; } };
  const unavailable = { code: "FEATURE_NOT_AVAILABLE", detail: { reason: "wasm-module-command-unavailable" } };
  const status: ModuleCommandsRequest = { operation: "status", registration: 1 };
  try {
    const owned = ownedModuleCommands(vm);
    // A runtime without a module-command owner refuses the request itself.
    await expect(owned.request(status)).rejects.toMatchObject(unavailable);
    const received: unknown[] = [];
    runtime.moduleCommands = (request, options) => { received.push([request, options]); return Promise.resolve({ operation: "status", enabled: true, skipped: [] }); };
    const signal = new AbortController().signal;
    await expect(owned.request(status, signal)).resolves.toEqual({ operation: "status", enabled: true, skipped: [] });
    await expect(owned.request(status)).resolves.toMatchObject({ enabled: true });
    expect(received).toEqual([[status, { signal }], [status, {}]]);
    // Another object, a System VM and a hosted frame's VM have none.
    expect(refusal({ spawnJS: (): Promise<never> => Promise.reject(new Error("unused")) })).toMatchObject({ ...unavailable, message: expect.stringContaining("not created by this copy of the SDK") as unknown });
    expect(refusal(system)).toMatchObject({ ...unavailable, message: expect.stringContaining("Userspace VM") as unknown });
    const hosted = { ...vm };
    bindFrameOwner(hosted, { diagnostics: { readJSProcessTrace: () => Promise.reject(new Error("unused")), watchAccelerationNotices: () => Promise.reject(new Error("unused")) } });
    // A hosted VM reaches module commands through frame protocol 17 (ADR 0028); one bound without them has none.
    expect(refusal(hosted)).toMatchObject({ ...unavailable, message: expect.stringContaining("Userspace VM") as unknown });
    // Disposal ends the VM's lifetime: nothing more is sent.
    expect(owned.disposed.aborted).toBe(false);
    await vm.dispose();
    expect(owned.disposed.aborted).toBe(true);
    await expect(owned.request(status)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(received).toHaveLength(2);
  } finally { await system.dispose(); await runtime.dispose(); }
});

describe("the VM's module frame (ADR 0028)", () => {
  async function moduleVM() {
    vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("crossOriginIsolated", true); vi.stubGlobal("navigator", { storage: undefined });
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
    frames.open.mockReset(); frames.lost.length = 0;
    const runtime = await bootedManagedVm(), events: string[] = [], attached: MessagePort[] = [];
    runtime.attachModuleFrame = port => { events.push("attach"); attached.push(port); return Promise.resolve(); };
    runtime.detachModuleFrame = () => { events.push("detach"); return Promise.resolve(); };
    runtime.spawnModule = () => { events.push("spawn"); return Promise.reject(new VMError("ABORTED", "the test runtime starts nothing")); };
    runtime.moduleFiles = () => Promise.resolve([]);
    const dispose = runtime.dispose.bind(runtime);
    runtime.dispose = async () => { events.push("runtime-dispose"); await dispose(); };
    frames.open.mockImplementation(() => Promise.resolve({ port: new MessageChannel().port1, dispose: () => { events.push("frame-dispose"); } }));
    const lazy = vi.fn((name: string) => Promise.resolve(new TextEncoder().encode(name)));
    const assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), lazy, dispose: vi.fn() };
    const image = { id: "test", version: "1", manifestSHA256: decodeSHA256("a".repeat(64), "test"), cpuProfile: "x86-64-v3", signatureVerified: true, keyId: "test" } as const;
    const vm = await adaptVM(runtime, decodePublicVMOptions({ mode: "userspace" }), { ...image, mode: "userspace" }, assets, { tier: "development" }, ACCEL, { start: { kind: "booted", reason: "first-start" }, moduleFrames: fakeFrames });
    return { vm, runtime, events, attached, lazy, modules: ownedModules(vm) };
  }
  const start = { descriptor: "{\"v\":1}", files: {} } as const;

  it("one frame per VM, removed after dispose", async () => {
    const { vm, events, attached, modules } = await moduleVM();
    await expect(modules.spawn({}, start)).rejects.toMatchObject({ code: "ABORTED" });
    await expect(modules.spawn({}, start)).rejects.toMatchObject({ code: "ABORTED" });
    await ownedModuleCommands(vm).request({ operation: "status", registration: 1 }).catch(() => undefined);
    expect(frames.open).toHaveBeenCalledOnce();
    expect([events, attached.length]).toEqual([["attach", "spawn", "spawn"], 1]);
    await vm.dispose();
    // The VM's worker, and with it the verified-copy store, goes first; then the frame.
    expect(events.slice(-2)).toEqual(["runtime-dispose", "frame-dispose"]);
  });

  it("a failed probe gives the typed capability and starts no worker", async () => {
    const { vm, events, modules } = await moduleVM();
    frames.open.mockImplementation(() => Promise.reject(isolationUnavailable("blob-workers", "This browser cannot isolate WebAssembly modules (blob-workers)")));
    const refusal = { code: "FEATURE_NOT_AVAILABLE", detail: { reason: "wasm-module-isolation-unavailable", capability: "blob-workers" } };
    await expect(modules.spawn({}, start)).rejects.toMatchObject(refusal);
    await expect(ownedModuleCommands(vm).request({ operation: "enable", descriptor: "{}", commands: ["a"], concurrency: 1, files: {} })).rejects.toMatchObject(refusal);
    expect(events).toEqual([]);
    await vm.dispose();
  });

  it("a module with a network reach starts with the engine's TLS module, fetched only when the VM lacks it (ADR 0029)", async () => {
    const { vm, runtime, lazy, modules } = await moduleVM(), sent: (readonly string[])[] = [];
    let held = false;
    runtime.moduleFiles = pins => Promise.resolve(held ? [] : pins.map(pin => copyKey(pin)));
    runtime.spawnModule = request => { sent.push(Object.keys(request.files)); held ||= Object.keys(request.files).length > 0; return Promise.reject(new VMError("ABORTED", "the test runtime starts nothing")); };
    const describe = async (host: readonly Capability[]) => encodeLaunchArgument((await buildRelease({ adapter: "export default () => ({ main: () => 0 });", declaration: { ...COMMAND_DECLARATION, requires: { host: [...host] } } })).descriptor);
    await modules.spawn({}, { descriptor: await describe(["files.sync"]), files: {} }).catch(() => undefined);
    expect([lazy.mock.calls.length, sent]).toEqual([0, [[]]]);
    await modules.spawn({}, { descriptor: await describe(["net.internet"]), files: {} }).catch(() => undefined);
    expect(lazy.mock.calls.map(call => call[0])).toEqual(["oxidevm_tls.wasm"]);
    expect(sent[1]).toEqual([copyKey(tlsPin())]);
    // Once the VM's store holds it, later starts send and fetch nothing.
    await modules.spawn({}, { descriptor: await describe(["net.vm"]), files: {} }).catch(() => undefined);
    expect([lazy.mock.calls.length, sent[2]]).toEqual([1, []]);
    await vm.dispose();
  });

  it("a lost frame ends processes with 125 and the next call reopens it", async () => {
    const { vm, events, modules } = await moduleVM();
    await modules.spawn({}, start).catch(() => undefined);
    expect(frames.lost).toHaveLength(1);
    frames.lost[0]?.();
    // The Userspace worker ends the module processes with status 125 (driver.moduleFrameLost) once told.
    await vi.waitFor(() => { expect(events).toEqual(["attach", "spawn", "frame-dispose", "detach"]); });
    await modules.spawn({}, start).catch(() => undefined);
    expect(frames.open).toHaveBeenCalledTimes(2);
    expect(events.slice(4)).toEqual(["attach", "spawn"]);
    await vm.dispose();
  });
});
