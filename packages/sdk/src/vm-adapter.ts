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
import { decodeExposeOptions, PreviewRoutes } from "./preview-routes.js";
import { readBrowserQuota } from "./runtime/workers/browser-quota.js";
import { validateHandoffRegistration } from "./runtime/workspace-handoff.js";
import { checkForImageUpdate, imageUpdateSignal } from "./image-update.js";
import { defaultImage } from "./default-image.js";
import { validateJSProcessSpec } from "./js-process-options.js";
import type { PipeJSProcessSpec, TerminalJSProcessSpec } from "./contracts.js";
import type { AccelerationNotice } from "./runtime/js-process/late-failure.js";
import { copyKey, type CopyKey, type ModulePin } from "./runtime/protocol/userspace-module-files.js";
import { ModuleExecution, type ModuleFrameOpener } from "./module-execution.js";
import type { ModuleStart } from "./runtime/vm-types.js";
import { MODULE_COMMAND_REASONS, type ModuleCommandsRequest, type ModuleCommandsResult } from "./runtime/protocol/userspace-module-commands.js";
import { parseLaunchArgument } from "./wasm/runner/descriptor.js";
import { moduleReach } from "./wasm/reach.js";
import { startsWithTls, TLS_FILE, tlsPin } from "./wasm/net/tls-file.js";

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
/** A local Userspace VM's module commands (ADR 0027): its Userspace worker's registration owner and the VM's lifetime. */
export interface OwnedModuleCommands {
  /** One request to the registration owner; a cancelled one is still answered (the runtime's `moduleCommands`). */
  readonly request: (request: ModuleCommandsRequest, signal?: AbortSignal) => Promise<ModuleCommandsResult>;
  /** Aborts when the VM is disposed: its Userspace worker, and every registration it held, is gone. */
  readonly disposed: AbortSignal;
  /** ADR 0028: which pins the VM's verified-copy store lacks, so the page sends only those. */
  readonly missing: (pins: readonly ModulePin[], signal: AbortSignal | undefined) => Promise<readonly CopyKey[]>;
}
/** What `spawnModule` gives a module's process: its own arguments, directory and environment, never a worker. */
export interface ModuleSpawnSpec {
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}
/** A local Userspace VM's module starts (ADR 0028): the store's missing files and the start itself. */
export interface OwnedModules {
  readonly missing: (pins: readonly ModulePin[], signal: AbortSignal | undefined) => Promise<readonly CopyKey[]>;
  readonly spawn: (spec: ModuleSpawnSpec, start: ModuleStart) => Promise<ProcessHandle>;
}
/** A VM's private owner record: a local VM's runtime, or a hosted frame's diagnostics. A Userspace VM's also starts
 * `spawnModule`'s runner from the VM's verified copies and reaches the VM's module commands (ADR 0027 and ADR 0028), in
 * the hosted frame too (frame protocol 17), which no public member of the VM can do. */
interface ModuleOwner { readonly modules?: OwnedModules; readonly moduleCommands?: OwnedModuleCommands }
type VMOwner = ({ readonly runtime: RuntimeVM } | { readonly diagnostics: FrameDiagnostics }) & ModuleOwner;
const ownedVMs = new WeakMap<object, VMOwner>();

/** Hosted VMs retain the same private ownership boundary as local VMs: their diagnostics, and their modules. */
export function bindFrameOwner(vm: VM, owner: { readonly diagnostics: FrameDiagnostics } & ModuleOwner): void {
  ownedVMs.set(vm, owner);
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
  return owner.diagnostics.readJSProcessTrace(capacity);
}

export async function watchOwnedAccelerationNotices(vm: VM, listener: (notice: AccelerationNotice) => void, signal: AbortSignal): Promise<void> {
  const owner = userspaceOwner(vm, "Fast-path notices");
  if ("runtime" in owner) {
    if (owner.runtime.watchAccelerationNotices === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Fast-path notices are unavailable");
    return owner.runtime.watchAccelerationNotices(listener, { signal });
  }
  return owner.diagnostics.watchAccelerationNotices(listener, signal);
}
/**
 * `spawnModule`'s access to a VM (engine ADR 0027 and ADR 0028): the Userspace worker starts the module process, whose
 * runner runs in the VM's module frame, with the launch description in its start message, so the process's argv, and
 * `/proc/<pid>/cmdline`, hold only the caller's arguments, and with the copies its store verified. A local Userspace VM
 * and a hosted frame's Userspace VM (frame protocol 17, `bindFrameOwner`) have modules. A VM this SDK did not create is
 * INVALID_ARGUMENT; a System VM, which runs no JS processes, is FEATURE_NOT_AVAILABLE.
 */
export function ownedModules(vm: object): OwnedModules {
  const owner = ownedVMs.get(vm);
  if (owner === undefined) throw new VMError("INVALID_ARGUMENT", "VM was not created by this SDK instance");
  if (owner.modules === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "WebAssembly modules require Userspace");
  return owner.modules;
}

/**
 * `enableModuleCommands`'s access to a VM (engine ADR 0027 and ADR 0028). A Userspace VM this SDK created, local or in
 * the hosted runtime frame, has module commands: any other object and a System VM are FEATURE_NOT_AVAILABLE
 * `wasm-module-command-unavailable`.
 */
export function ownedModuleCommands(vm: object): OwnedModuleCommands {
  const owner = ownedVMs.get(vm);
  const unavailable = (why: string) => new VMError("FEATURE_NOT_AVAILABLE", `Module commands are unavailable: ${why}`, { reason: MODULE_COMMAND_REASONS.unavailable });
  if (owner === undefined) throw unavailable("the VM was not created by this copy of the SDK");
  if (owner.moduleCommands === undefined) throw unavailable("they need a Userspace VM");
  return owner.moduleCommands;
}

export function ownedRuntime(vm: VM): RuntimeVM {
  const runtime = ownedVMs.get(vm);
  if (runtime === undefined) throw new VMError("INVALID_ARGUMENT", "VM was not created by this SDK instance");
  if (!("runtime" in runtime)) throw new VMError("FEATURE_NOT_AVAILABLE", "This diagnostic requires a local runtime");
  return runtime.runtime;
}

export async function adaptVM(runtime: RuntimeVM, options: ValidatedVMOptions, image: ImageInfo, assets: LoadedEngineAssets, license: LicenseStatus, commandAcceleration: FeatureSupport, booted: Pick<ManagedImageInfo, "start" | "workspace" | "update"> & { readonly moduleFrames?: ModuleFrameOpener } = {}): Promise<VM> {
  if (runtime.storagePersistence === undefined) throw new VMError("PROTOCOL_ERROR", "runtime has no durable storage identity");
  const backend = await runtime.storagePersistence();
  const retention = await readBrowserQuota(navigator.storage);
  const persistence: WorkspacePersistence = options.ephemeral !== false ? { kind: "ephemeral", reason: options.ephemeral } : { kind: "persistent", backend, browserRetention: retention.persisted === true ? "granted" : "best-effort" };
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
  async function startJS(spec: PipeJSProcessSpec | TerminalJSProcessSpec): Promise<ProcessHandle | TerminalHandle> {
    active(); const decoded = validateJSProcessSpec(spec); abortIfRequested(decoded.signal);
    if (runtime.spawnJS === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "This runtime does not support JS processes");
    const creating = new AbortController(), abort = () => creating.abort(); decoded.signal?.addEventListener("abort", abort, { once: true });
    try {
      const process = await runtime.spawnJS({ ...decoded, signal: creating.signal });
      if (decoded.signal?.aborted === true) { const handle = adaptProcess(process, false); await handle.kill("SIGKILL", { scope: "process-group" }); await handle.exit; throw new VMError("ABORTED", "process creation cancelled"); }
      return adaptProcess(process, decoded.terminal !== undefined);
    } finally { decoded.signal?.removeEventListener("abort", abort); }
  }
  async function spawnJS(spec: TerminalJSProcessSpec): Promise<TerminalHandle>;
  async function spawnJS(spec: PipeJSProcessSpec): Promise<ProcessHandle>;
  async function spawnJS(spec: PipeJSProcessSpec | TerminalJSProcessSpec): Promise<ProcessHandle | TerminalHandle> { return startJS(spec); }
  const missing = async (pins: readonly ModulePin[], signal: AbortSignal | undefined): Promise<readonly CopyKey[]> => {
    active();
    if (runtime.moduleFiles === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "This runtime does not support WebAssembly modules");
    return runtime.moduleFiles(pins, signal === undefined ? {} : { signal });
  };
  /**
   * ADR 0029: a module with a network reach starts with the engine's TLS module. The VM's store holds it like any pinned
   * file, so this VM fetches it from the engine release the first time such a module starts, and never when none does;
   * a description that does not parse is left for the Userspace worker to refuse.
   */
  const withEngineFiles = async (descriptor: string, files: Readonly<Record<CopyKey, Blob>>, signal: AbortSignal | undefined): Promise<Readonly<Record<CopyKey, Blob>>> => {
    let reach;
    try { reach = moduleReach(parseLaunchArgument(descriptor).manifest.requires.host); } catch { return files; }
    if (!startsWithTls(reach)) return files;
    const pin = tlsPin(), key = copyKey(pin);
    if (Object.hasOwn(files, key) || (await missing([pin], signal)).length === 0) return files;
    return { ...files, [key]: new Blob([await assets.lazy(TLS_FILE, signal)]) };
  };
  // ADR 0028: one module frame per VM, opened by the first module start or enable; the store goes before it on dispose.
  const frames = booted.moduleFrames ?? {
    open: () => Promise.reject(new VMError("FEATURE_NOT_AVAILABLE", "This VM cannot open a module frame", { reason: "wasm-module-isolation-unavailable", capability: "frame-load" })),
    sources: () => Promise.resolve({ broker: new Blob(), runner: new Blob() }), watch: () => () => undefined,
  };
  const execution = new ModuleExecution({
    ...frames,
    attach: async port => { if (runtime.attachModuleFrame === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "This runtime does not support WebAssembly modules"); await runtime.attachModuleFrame(port); },
    detach: async () => { await runtime.detachModuleFrame?.(); },
  });
  const modules: OwnedModules = {
    missing,
    spawn: async (spec, start) => {
      active(); abortIfRequested(spec.signal);
      await execution.ensure(spec.signal);
      if (runtime.spawnModule === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "This runtime does not support WebAssembly modules");
      const creating = new AbortController(), abort = () => creating.abort(); spec.signal?.addEventListener("abort", abort, { once: true });
      try {
        const files = await withEngineFiles(start.descriptor, start.files, spec.signal);
        // A module starts in /workspace unless the caller names a directory, as every JS process does (validateJSProcessSpec).
        const process = await runtime.spawnModule({ ...(spec.args === undefined ? {} : { args: spec.args }), cwd: spec.cwd ?? "/workspace", ...(spec.env === undefined ? {} : { env: spec.env }), signal: creating.signal, ...start, files });
        if (spec.signal?.aborted === true) { const handle = adaptProcess(process, false); await handle.kill("SIGKILL", { scope: "process-group" }); await handle.exit; throw new VMError("ABORTED", "process creation cancelled"); }
        return adaptProcess(process, false);
      } finally { spec.signal?.removeEventListener("abort", abort); }
    },
  };
  const moduleCommands: OwnedModuleCommands = {
    request: async (request, signal) => {
      active();
      if (request.operation === "enable") await execution.ensure(signal);
      if (runtime.moduleCommands === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "This runtime has no module commands", { reason: MODULE_COMMAND_REASONS.unavailable });
      const sent = request.operation === "enable" ? { ...request, files: await withEngineFiles(request.descriptor, request.files, signal) } : request;
      return runtime.moduleCommands(sent, signal === undefined ? {} : { signal });
    },
    disposed: lifetime.signal,
    missing,
  };
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
    exposePort: async (port: number, request?: Parameters<VM["exposePort"]>[1]) => {
      active(); const exposure = decodeExposeOptions(request); abortIfRequested(exposure.signal);
      if (options.preview === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "preview infrastructure is not configured", { reason: "not-configured" });
      return previews.expose(port, exposure);
    },
    listeningPorts: (request?: { readonly signal?: AbortSignal }) => { active(); return runtime.listeningPorts(request); },
    watchListeningPorts: (listener: Parameters<VM["watchListeningPorts"]>[0], request: Parameters<VM["watchListeningPorts"]>[1]) => { active(); return runtime.watchListeningPorts(listener, request); },
    dispose: () => { lifetime.abort(); disposal ??= previews.dispose().finally(() => runtime.dispose()).finally(() => execution.dispose()).finally(() => assets.dispose()); return disposal; },
  };
  const vm: VM = options.mode === "userspace" ? { ...base, spawnJS, mode: "userspace", get image(){const actual=runtime.imageIdentity??image;if(actual.mode!=="userspace")throw new VMError("PROTOCOL_ERROR","Actual image mode changed");return {...actual,mode:"userspace" as const};}, start: { ...adaptStart(booted.start ?? { kind: "booted", reason: "first-start" }), workspaceDetails: booted.workspace ?? booted.start?.workspaceDetails ?? IN_SYNC_WORKSPACE,...(booted.update===undefined?{}:{update:booted.update}) } } : {
    ...base, mode: "system", get image(){const actual=runtime.imageIdentity??image;if(actual.mode!=="system")throw new VMError("PROTOCOL_ERROR","Actual image mode changed");return {...actual,mode:"system" as const};}, start: {...adaptStart(booted.start),...(booted.update===undefined?{}:{update:booted.update})},
  };
  ownedVMs.set(vm, vm.mode === "userspace" ? { runtime, modules, moduleCommands } : { runtime }); return vm;
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
