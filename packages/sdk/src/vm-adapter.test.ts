import { afterEach, expect, it, vi } from "vitest";
import { adaptVM } from "./vm-adapter.js";
import { decodePublicVMOptions } from "./vm-options.js";
import { decodeSHA256 } from "./values.js";
import { VMError } from "./runtime/errors.js";
import { bootedManagedVm, ScriptedWorker } from "./runtime/system-vm.test-support.js";
import type { WorkspaceChange, WorkspaceFileEntry, WorkspaceWatch } from "./contracts.js";
import type { SnapshotInfo } from "./runtime/snapshot-types.js";

const ACCEL = { available: true } as const;
const NOT_APPLICABLE = { available: false, reason: "mode-unsupported" } as const;

afterEach(() => { ScriptedWorker.reset(); vi.unstubAllGlobals(); });

it.each(["system", "userspace"] as const)("advertises native snapshots for %s", async mode => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("navigator", { storage: undefined }); vi.stubGlobal("location", new URL("https://ide.test/"));
  const runtime = await bootedManagedVm();
  const vm = await adaptVM(runtime, decodePublicVMOptions({ mode }),
    { id: "test", version: "1", mode, manifestSHA256: decodeSHA256("a".repeat(64), "test"), cpuProfile: "x86-64-v3", signatureVerified: true, keyId: "test" },
    { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), dispose: vi.fn() }, { tier: "development" }, mode === "system" ? NOT_APPLICABLE : ACCEL, { start: { kind: "booted", reason: "first-start" } });
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
  const assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), dispose: vi.fn() };
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
  const assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), dispose: vi.fn() };
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
  const assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), dispose: vi.fn() };
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
  const assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), dispose: vi.fn() };
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
 const runtime=await bootedManagedVm(),assets={urls:new Map<string,string>(),compile:()=>Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))),dispose:vi.fn()},register=vi.spyOn(runtime,"allowWorkspaceHandoff").mockImplementation(()=>{});
 const vm=await adaptVM(runtime,decodePublicVMOptions({mode:"system"}),{id:"test",version:"1",mode:"system",manifestSHA256:decodeSHA256("a".repeat(64),"test"),cpuProfile:"x86-64-v3",signatureVerified:true,keyId:"test"},assets,{tier:"development"},NOT_APPLICABLE,{start:{kind:"booted",reason:"first-start"}});
 const order:string[]=[],subscription=vm.allowWorkspaceHandoff(()=>order.push("moved"),{signal:new AbortController().signal}).then(()=>order.push("ended"));
 const call=register.mock.calls[0];if(call===undefined)throw new Error("missing holder listener");call[0]({saved:true});await subscription;
 expect(order).toEqual(["moved","ended"]);await vm.dispose();expect(assets.dispose).toHaveBeenCalledOnce();
});

it.each(["system", "userspace"] as const)("rejects malformed %s handoff registrations before registering a holder", async mode => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("navigator", { storage: undefined }); vi.stubGlobal("location", new URL("https://ide.test/"));
  const runtime = await bootedManagedVm(), assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), dispose: vi.fn() };
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
  const runtime = await bootedManagedVm(), assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), dispose: vi.fn() };
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
  const runtime = await bootedManagedVm(), assets = { urls: new Map<string, string>(), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), dispose: vi.fn() };
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
