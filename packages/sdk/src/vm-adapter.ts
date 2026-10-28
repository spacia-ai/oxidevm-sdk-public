import type { BootProgress, FeatureSupport, LicenseStatus } from "./contracts.js";
import type { RuntimeMode } from "./values.js";
import type { ExecSpec, VMSnapshots, VMStart, PipeSpawnSpec, ProcessHandle, TerminalHandle, TerminalSpawnSpec, VM, Workspace, WorkspacePersistence } from "./contracts.js";
import type { ImageInfo } from "./image.js";
import type { ValidatedVMOptions } from "./vm-options.js";
import type { LoadedEngineAssets } from "./engine-assets.js";
import type { ManagedStart, StartProgress } from "./runtime/snapshot-types.js";
import type { ManagedImageInfo, RuntimeVM } from "./runtime/vm-types.js";
import { IN_SYNC_WORKSPACE } from "./runtime/protocol/workspace-start.js";
import { GuestProcessTransport } from "./runtime/guest-process.js";
import { VMError } from "./runtime/errors.js";
import { validateSpawnSpec } from "./runtime/vm-options.js";
import { exactKeys, integer, record } from "./runtime/decode.js";
import { abortIfRequested } from "./engine-assets.js";
import { adaptProcess, execProcess } from "./process.js";
import { PreviewRoutes } from "./preview-routes.js";
import { readBrowserQuota } from "./runtime/workers/browser-quota.js";
import { validateHandoffRegistration } from "./runtime/workspace-handoff.js";
import { checkForImageUpdate, imageUpdateSignal } from "./image-update.js";
import { defaultImage } from "./default-image.js";
import { validateJSProcessSpec } from "./js-process-options.js";
import type { PipeJSProcessSpec, TerminalJSProcessSpec } from "./contracts.js";
import type { AccelerationNotice } from "./runtime/js-process/late-failure.js";

/** Public startup progress follows the managed runtime's cold/resume decision. */
export function toBootProgress(mode: RuntimeMode, progress: StartProgress): BootProgress {
  switch (progress.step) {
    case "boot": return { phase: "boot", mode };
    case "prepare": return mode==="userspace"?{phase:"prepare-image",stage:progress.stage??"verify",completedBytes:progress.completedBytes,totalBytes:progress.totalBytes}
      : progress.stage === undefined ? {phase:"download",asset:"image",completedBytes:progress.completedBytes,totalBytes:progress.totalBytes}
        : {phase:"prepare-image",stage:progress.stage,completedBytes:progress.completedBytes,totalBytes:progress.totalBytes};
    case "download": return { phase: "download", asset: "restore-point", completedBytes: progress.completedBytes, totalBytes: progress.totalBytes };
    case "open": return { phase: "restore", step: "open", completedBytes: progress.completedBytes, totalBytes: progress.totalBytes };
    case "wake":
    case "reconnect": return { phase: "restore", step: progress.step };
  }
}

/** The Userspace diagnostics a hosted frame serves for its client VM. */
export interface FrameDiagnostics {
  readonly readJSProcessTrace: (capacity?: number) => Promise<Uint8Array>;
  readonly watchAccelerationNotices: (listener: (notice: AccelerationNotice) => void, signal: AbortSignal) => Promise<void>;
}
type VMOwner = { readonly runtime: RuntimeVM } | FrameDiagnostics;
const ownedVMs = new WeakMap<object, VMOwner>();

/** Hosted VMs retain the same private ownership boundary as local VMs. */
export function bindFrameDiagnostics(vm: VM, diagnostics: FrameDiagnostics): void {
  ownedVMs.set(vm, diagnostics);
}

function userspaceOwner(vm: VM, feature: string): VMOwner {
  const owner = ownedVMs.get(vm);
  if (owner === undefined) throw new VMError("INVALID_ARGUMENT", "VM was not created by this SDK instance");
  if (vm.mode !== "userspace") throw new VMError("FEATURE_NOT_AVAILABLE", `${feature} requires Userspace`);
  return owner;
}

export async function readOwnedJSProcessTrace(vm: VM, capacity?: number): Promise<Uint8Array> {
  const owner = userspaceOwner(vm, "JS service tracing");
  if ("runtime" in owner) {
    if (owner.runtime.readJSProcessTrace === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "JS service tracing is unavailable");
    return owner.runtime.readJSProcessTrace(capacity);
  }
  return owner.readJSProcessTrace(capacity);
}

export async function watchOwnedAccelerationNotices(vm: VM, listener: (notice: AccelerationNotice) => void, signal: AbortSignal): Promise<void> {
  const owner = userspaceOwner(vm, "Fast-path notices");
  if ("runtime" in owner) {
    if (owner.runtime.watchAccelerationNotices === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Fast-path notices are unavailable");
    return owner.runtime.watchAccelerationNotices(listener, { signal });
  }
  return owner.watchAccelerationNotices(listener, signal);
}
export function ownedRuntime(vm: VM): RuntimeVM {
  const runtime = ownedVMs.get(vm);
  if (runtime === undefined) throw new VMError("INVALID_ARGUMENT", "VM was not created by this SDK instance");
  if (!("runtime" in runtime)) throw new VMError("FEATURE_NOT_AVAILABLE", "This diagnostic requires a local runtime");
  return runtime.runtime;
}

export async function adaptVM(runtime: RuntimeVM, options: ValidatedVMOptions, image: ImageInfo, assets: LoadedEngineAssets, license: LicenseStatus, commandAcceleration: FeatureSupport, booted: Pick<ManagedImageInfo, "start" | "workspace" | "update"> = {}): Promise<VM> {
  if (runtime.storagePersistence === undefined) throw new VMError("PROTOCOL_ERROR", "runtime has no durable storage identity");
  const backend = await runtime.storagePersistence();
  const retention = await readBrowserQuota(navigator.storage);
  const persistence: WorkspacePersistence = options.ephemeral ? { kind: "ephemeral" } : { kind: "persistent", backend, browserRetention: retention.persisted === true ? "granted" : "best-effort" };
  let disposal: Promise<void> | undefined;
  const lifetime=new AbortController();
  const previews = new PreviewRoutes(runtime, options.preview?.isolation ?? "per-session");
  const active = () => { if (disposal !== undefined) throw new VMError("PROTOCOL_ERROR", "VM has been disposed"); };
  const workspace: Workspace = {
    id: options.workspaceId, persistence,
    readFile: async (path, signal) => { active(); return runtime.workspace.readFile(path, signal); },
    readText: async (path, signal) => { active(); return runtime.workspace.readText(path, signal); },
    writeFile: async (path, bytes, signal) => { active(); return runtime.workspace.writeFile(path, bytes, signal); },
    writeText: async (path, text, signal) => { active(); return runtime.workspace.writeText(path, text, signal); },
    list: async (path = "/", signal) => { active(); return (await runtime.workspace.entries(path, signal)).map(entry => ({ kind: entry.kind, name: entry.name, path: entry.path })); },
    remove: async (path, removal) => { active(); return runtime.workspace.remove(path, removal); },
    // The runtime workspace's own file owner; the diagnostics surface calls the same methods.
    entries: async (path, signal) => { active(); return runtime.workspace.entries(path, signal); },
    stat: async (path, signal) => { active(); return runtime.workspace.stat(path, signal); },
    read: async (path, request) => { active(); return runtime.workspace.read(path, request); },
    write: async (path, bytes, request) => { active(); return runtime.workspace.write(path, bytes, request); },
    createDirectory: async (path, request) => { active(); return runtime.workspace.createDirectory(path, request); },
    rename: async (from, to, request) => { active(); return runtime.workspace.rename(from, to, request); },
    watch: (onChange, request) => { active(); return runtime.workspace.watch(onChange, request); },
  };
  async function spawn(spec: TerminalSpawnSpec): Promise<TerminalHandle>;
  async function spawn(spec: PipeSpawnSpec): Promise<ProcessHandle>;
  async function spawn(spec: PipeSpawnSpec | TerminalSpawnSpec): Promise<ProcessHandle | TerminalHandle> {
    active();
    const decoded = validateSpawnSpec({ ...spec, cwd: spec.cwd ?? "/workspace" }, true);
    abortIfRequested(decoded.signal);
    const creating = new AbortController(); const abort = () => creating.abort();
    decoded.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (runtime.spawnGuest === undefined) throw new VMError("PROTOCOL_ERROR", "runtime has no native guest-path process owner");
      const process = await runtime.spawnGuest({ ...decoded, signal: creating.signal });
      if (decoded.signal?.aborted === true) {
        const handle = adaptProcess(process, false);
        await handle.kill("SIGKILL", { scope: "process-group" }); await handle.exit;
        throw new VMError("ABORTED", "process creation cancelled");
      }
      return adaptProcess(process, decoded.terminal !== undefined);
    } catch (error) {
      if (error instanceof VMError && error.code === "PROTOCOL_ERROR") throw new VMError("INVALID_ARGUMENT", error.message);
      throw error;
    } finally { decoded.signal?.removeEventListener("abort", abort); }
  }
  async function spawnJS(spec: TerminalJSProcessSpec): Promise<TerminalHandle>;
  async function spawnJS(spec: PipeJSProcessSpec): Promise<ProcessHandle>;
  async function spawnJS(spec: PipeJSProcessSpec | TerminalJSProcessSpec): Promise<ProcessHandle | TerminalHandle> {
    active(); const decoded = validateJSProcessSpec(spec); abortIfRequested(decoded.signal);
    if (runtime.spawnJS === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "This runtime does not support JS processes");
    const creating = new AbortController(), abort = () => creating.abort(); decoded.signal?.addEventListener("abort", abort, { once: true });
    try {
      const process = await runtime.spawnJS({ ...decoded, signal: creating.signal });
      if (decoded.signal?.aborted === true) { const handle = adaptProcess(process, false); await handle.kill("SIGKILL", { scope: "process-group" }); await handle.exit; throw new VMError("ABORTED", "process creation cancelled"); }
      return adaptProcess(process, decoded.terminal !== undefined);
    } finally { decoded.signal?.removeEventListener("abort", abort); }
  }
  const base = {
    prepareImage: (request?: { readonly signal?: AbortSignal }) => {
      active(); const signal = imageUpdateSignal(request); return runtime.prepareImage(signal === undefined ? {} : { signal });
    },
    checkForUpdate: (request?: { readonly signal?: AbortSignal }) => {
      active();
      const signal=imageUpdateSignal(request);
      const configured = options.image ?? defaultImage(options.mode);
      return checkForImageUpdate(configured, () => runtime.imageIdentity ?? image, location.href,
        AbortSignal.any([lifetime.signal, ...(signal === undefined ? [] : [signal])]));
    },
    workspace,
    license,
    // The runtime's relay owner itself: its state, revocation and disposal stay in one place.
    network: runtime.network,
    capabilities: {
      previews: options.preview === undefined ? { available: false, reason: "not-configured" } as const : { available: true } as const,
      snapshots: { available: true } as const,
      maximumVcpus: 1 as const,
      commandAcceleration,
      crossOriginIsolated: globalThis.crossOriginIsolated,
    },
    spawn,
    snapshots: adaptSnapshots(runtime, booted.update ?? { id: image.id, version: image.version }),
    allowWorkspaceHandoff:async(listener:Parameters<VM["allowWorkspaceHandoff"]>[0],request:Parameters<VM["allowWorkspaceHandoff"]>[1])=>{
      const requestedSignal=validateHandoffRegistration(listener,request);
      active(); const signal=AbortSignal.any([requestedSignal,lifetime.signal]);
      runtime.allowWorkspaceHandoff(moved=>{const disposing=base.dispose();listener(moved);void disposing.catch(()=>{});},{signal});
      await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener("abort",()=>resolve(),{once:true});});
    },
    suspend: async (request: { readonly label: string; readonly signal?: AbortSignal }) => { active(); const snapshot = await runtime.suspend(request); await base.dispose(); return snapshot; },
    exec: async (spec: ExecSpec) => {
      active(); const value = record(spec, "exec spec"); exactKeys(value, ["command"], ["args", "cwd", "env", "stdin", "maxOutputBytes", "signal"]);
      const limit = integer(value["maxOutputBytes"] ?? 1024 ** 2, "maxOutputBytes", 1, 64 * 1024 ** 2);
      if (spec.stdin !== undefined && !(spec.stdin instanceof Uint8Array)) throw new VMError("INVALID_ARGUMENT", "stdin must be bytes");
      const process = await spawn({ command: spec.command, ...(spec.args === undefined ? {} : { args: spec.args }), ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }), ...(spec.env === undefined ? {} : { env: spec.env }), ...(spec.signal === undefined ? {} : { signal: spec.signal }) });
      return execProcess(process, { ...spec, maxOutputBytes: limit });
    },
    exposePort: async (port: number, request?: { readonly signal?: AbortSignal }) => {
      active(); abortIfRequested(request?.signal);
      if (options.preview === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "preview infrastructure is not configured", { reason: "not-configured" });
      return previews.expose(port, request?.signal);
    },
    listeningPorts: (request?: { readonly signal?: AbortSignal }) => { active(); return runtime.listeningPorts(request); },
    watchListeningPorts: (listener: Parameters<VM["watchListeningPorts"]>[0], request: Parameters<VM["watchListeningPorts"]>[1]) => { active(); return runtime.watchListeningPorts(listener, request); },
    dispose: () => { lifetime.abort(); disposal ??= previews.dispose().finally(() => runtime.dispose()).finally(() => assets.dispose()); return disposal; },
  };
  const vm: VM = options.mode === "userspace" ? { ...base, spawnJS, mode: "userspace", get image(){const actual=runtime.imageIdentity??image;if(actual.mode!=="userspace")throw new VMError("PROTOCOL_ERROR","Actual image mode changed");return {...actual,mode:"userspace" as const};}, start: { ...adaptStart(booted.start ?? { kind: "booted", reason: "first-start" }), workspaceDetails: booted.workspace ?? booted.start?.workspaceDetails ?? IN_SYNC_WORKSPACE,...(booted.update===undefined?{}:{update:booted.update}) } } : {
    ...base, mode: "system", get image(){const actual=runtime.imageIdentity??image;if(actual.mode!=="system")throw new VMError("PROTOCOL_ERROR","Actual image mode changed");return {...actual,mode:"system" as const};}, start: {...adaptStart(booted.start),...(booted.update===undefined?{}:{update:booted.update})},
  };
  ownedVMs.set(vm, { runtime }); return vm;
}

function adaptStart(start?: ManagedStart): VMStart {
  if (start === undefined) throw new VMError("PROTOCOL_ERROR", "System boot did not return a start result");
  if (start.kind === "booted") return start;
  return { ...start, terminals: start.terminals.map(terminal => terminal.source === "console" ? terminal : {
    ...terminal,
    attach: async (options?: { readonly signal?: AbortSignal }) => {
      const process = await terminal.attach(options);
      if (!(process instanceof GuestProcessTransport)) throw new VMError("PROTOCOL_ERROR", "resumed process has no guest transport");
      return adaptProcess(process, process.terminal);
    },
  }) };
}

function adaptSnapshots(runtime: RuntimeVM, requested: { readonly id: string; readonly version: string }): VMSnapshots {
  const snapshots = runtime.snapshots;
  return {
    list: options => snapshots.list(options), capture: options => snapshots.capture(options),
    restore: async (snapshot, options) => {
      const restored = await snapshots.restore(snapshot, options); const start = adaptStart(restored.start);
      if (start.kind !== "resumed") throw new VMError("PROTOCOL_ERROR", "restore did not resume a snapshot");
      const { update, ...resumed } = start, actual = runtime.imageIdentity;
      const offered = actual === undefined ? update : actual.id === requested.id && actual.version === requested.version ? undefined : requested;
      return { ...restored, start: { ...resumed, ...(offered === undefined ? {} : { update: offered }) } };
    },
    rename: (snapshot, label, options) => snapshots.rename(snapshot, label, options),
    delete: (snapshot, options) => snapshots.delete(snapshot, options), usage: options => snapshots.usage(options),
    setAppData: data => snapshots.setAppData(data), observe: (listener, options) => snapshots.observe(listener, options),
    autoSave: { configure: (policy, options) => snapshots.autoSave.configure(policy, options), hint: hint => snapshots.autoSave.hint(hint) },
    export: (snapshot, options) => snapshots.export(snapshot, options), inspect: (file, options) => snapshots.inspect(file, options), import: (file, options) => snapshots.import(file, options),
  };
}
