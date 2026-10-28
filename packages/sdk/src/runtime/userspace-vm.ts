import { NetworkClient } from "./network-client.js";
import { rejectingTimeout } from "./disposal.js";
import { openPreviewSession } from "./preview-session.js";
import type { PreviewKeeperHost } from "./preview-keeper.js";
import { requireGuestExecution } from "./assistance-admission.js";
import { validateSpawnSpec } from "./vm-options.js";
import { nativeGuestCommand } from "./guest-command.js";
import type { RuntimeVMOptions, DependencyInstallHandle, DependencyPreparationOptions, ListeningPort, ManagedImageInfo, ManagedImageBootOptions, SpawnSpec, ProcessHandle, PreviewHandle, PreviewIsolation, RuntimeVM, RuntimeVMDiagnostics } from "./vm-types.js";
import { decodeWatchOptions, pollDelay, watchListeningPorts } from "./listening-ports.js";
import { VMError, serializeUnknownError, withCleanupFailure } from "./errors.js";
import { UserspaceProcessBackend } from "./userspace-process.js";
import { UserspaceWorkspaceFiles } from "./userspace-workspace-files.js";
import { UserspaceManagedSession } from "./userspace-managed-session.js";
import { SnapshotObserver } from "./snapshot-observer.js";
import type { RuntimeVMSnapshots } from "./snapshot-types.js";
import {
  storageResponseDecoders,
  type StorageOperations,
  type SnapshotInfo,
  type SnapshotRef,
  type RuntimeVMCapabilities,
  PROTOCOL_VERSION,
  validateRestorePointName,
  validateSnapshotLabel,
} from "./protocol.js";
import { RuntimeSnapshots } from "./snapshots.js";
import { WorkerClient } from "./worker-client.js";
import { BrowserWorkspace, type Workspace } from "./workspace.js";
import { allowWorkspaceHandoff, type WorkspaceMovedAway } from "./workspace-handoff.js";
import { exactKeys, integer, record, string } from "./decode.js";
import type { ExecutionTimingMode } from "./protocol/common.js";
import type { SystemJitInstallMode } from "./protocol/system-trace-background-compile.js";
import type { UserspaceJitTier } from "./jit-tier-option.js";
import type { AccelerationNotice } from "./js-process/late-failure.js";

const USERSPACE_PROFILE_OPTIONS = Symbol.for("oxidevm.internal.userspace-profile-options");
const USERSPACE_READ_PROFILE = Symbol.for("oxidevm.internal.userspace-read-profile");
const USERSPACE_READ_SYSCALL_TRACE = Symbol.for("oxidevm.internal.userspace-read-syscall-trace");

interface UserspaceProfileOptions {
  readonly executionTiming: ExecutionTimingMode;
  readonly syscallTraceCapacity?: number;
}

export async function createUserspaceRuntimeVM(
  options: Extract<RuntimeVMOptions, { mode: "userspace" }>,
  profileOptions?: UserspaceProfileOptions,
  jitInstall?: SystemJitInstallMode,
  jitTier?: UserspaceJitTier,
): Promise<RuntimeVM> {
  const storage = new WorkerClient<StorageOperations>(
    new Worker(new URL("./workers/storage.worker.js", import.meta.url), {
      name: "oxidevm-storage",
      type: "module",
    }),
    storageResponseDecoders,
    "settled",
  );
  const network = new Worker(new URL("./workers/network.worker.js", import.meta.url), {
    name: "oxidevm-network",
    type: "module",
  });
  const networkChannel = new MessageChannel();
  const linuxStorage = new MessageChannel();
  const linuxNetwork = new MessageChannel();
  const snapshot = new MessageChannel();
  network.postMessage(
    { version: PROTOCOL_VERSION, type: "connect", port: networkChannel.port1 },
    [networkChannel.port1],
  );
  network.postMessage(
    {
      version: PROTOCOL_VERSION,
      type: "connect-userspace",
      port: linuxNetwork.port1,
    },
    [linuxNetwork.port1],
  );
  let backend: UserspaceProcessBackend | undefined;
  try {
    await storage.request(
      "initialize",
      {
        workspaceId: options.workspaceId,
        machine: { mode: "userspace", memoryMiB: options.memoryMiB, vcpus: 1 },
        ...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
        snapshotPort: snapshot.port1,
        rootfsNetworkPort: networkChannel.port2,
        userspaceStoragePort: linuxStorage.port1,
      },
      { transfer: [snapshot.port1, networkChannel.port2, linuxStorage.port1] },
    );
    const defaultUrl = options.userspaceWasmUrl ?? "/oxidevm_userspace.wasm";
    const wasmUrl = typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated
      ? options.userspaceSharedWasmUrl ?? defaultUrl
      : defaultUrl;
    backend = await UserspaceProcessBackend.create(
      {
        wasmUrl, memoryMiB: options.memoryMiB,
        ...(options.userspaceWasmModule === undefined ? {} : { wasmModule: options.userspaceWasmModule }),
        storagePort: linuxStorage.port2, networkPort: linuxNetwork.port2,
        ...(options.limits?.maxProcesses === undefined ? {} : { maxProcesses: options.limits.maxProcesses }),
        ...(profileOptions?.syscallTraceCapacity === undefined ? {} : { syscallTraceCapacity: profileOptions.syscallTraceCapacity }),
        ...(profileOptions?.executionTiming === undefined ? {} : { executionTiming: profileOptions.executionTiming }),
        ...(jitInstall === undefined ? {} : { jitInstall }),
        ...(jitTier === undefined ? {} : { jitTier }),
        ...(options.interceptors === undefined ? {} : { interceptors: options.interceptors }),
        ...(options.nativeExecutionPort === undefined ? {} : { nativeExecutionPort: options.nativeExecutionPort }),
        ...(options.initialUser === undefined ? {} : { initialUser: options.initialUser }),
        ...(options.rootPersistence === undefined ? {} : { rootPersistence: options.rootPersistence }),
      }, snapshot.port2,
    );
    const vm = new BrowserUserspaceVM(options, storage, network, backend);
    if (options.network === "relay" && options.relayUrl !== undefined) {
      try { await vm.network.connect({kind: "server", url: options.relayUrl}); }
      catch (error: unknown) { await vm.dispose().catch(() => {}); throw error; }
    }
    return vm;
  } catch (error) {
    backend?.dispose().catch(() => undefined);
    storage.terminate();
    network.terminate();
    snapshot.port2.close();
    throw error;
  }
}

class BrowserUserspaceVM implements RuntimeVM {
  readonly mode = "userspace" as const;
  readonly capabilities: RuntimeVMCapabilities = {
    execution: "serialized",
    vcpus: 1,
    sharedMemory: false,
  };
  readonly workspace: Workspace;
  readonly diagnostics: RuntimeVMDiagnostics;
  readonly network: NetworkClient;
  readonly snapshots: RuntimeVMSnapshots;
  readonly #storage: WorkerClient<StorageOperations>;
  readonly #network: Worker;
  readonly #backend: UserspaceProcessBackend;
  readonly #previewOrigin: URL | undefined;
  readonly #previewIsolation: PreviewIsolation;
  readonly #previewKeeperHost: PreviewKeeperHost | undefined;
  readonly #previews = new Map<number, Promise<PreviewHandle>>();
  readonly #managed: UserspaceManagedSession;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  /** Aborted when disposal starts, so a disposing VM no longer hands its workspace over. */
  readonly #disposing = new AbortController();
  readonly #workspaceId: string;

  get imageIdentity() { return this.#managed.rootfs?.identity; }

  constructor(
    options: Extract<RuntimeVMOptions, { mode: "userspace" }>,
    storage: WorkerClient<StorageOperations>,
    network: Worker,
    backend: UserspaceProcessBackend,
  ) {
    this.#storage = storage;
    this.#network = network;
    this.network = new NetworkClient(() => network, {origin: typeof location === "undefined" ? "null" : location.origin, workspaceId: options.workspaceId, serverAllowed: options.relayPolicy !== "personal-only"}, undefined, () => backend.revokeNetwork());
    this.#workspaceId = options.workspaceId;
    this.#backend = backend;
    this.#previewOrigin = options.previewOrigin === undefined ? undefined : new URL(options.previewOrigin);
    this.#previewIsolation = options.previewIsolation ?? "per-session";
    this.#previewKeeperHost = options.previewKeeperHost;
    const observer = new SnapshotObserver(backend.control);
    const files = new UserspaceWorkspaceFiles(backend, () => this.#managed.rootfs, AbortSignal.any([this.#disposing.signal, storage.lifetime]));
    this.#managed = new UserspaceManagedSession({
      control: backend.control, storage, rootPersistence: options.rootPersistence ?? "ephemeral",
      observe: (listener, signal) => observer.listen(listener, signal),
      attachProcess: (key, terminal, tail, signal) => backend.attachProcess(key, terminal, tail, signal),
      restored: () => { files.restored(); return this.#closePreviews(); },
    });
    this.snapshots = new RuntimeSnapshots({ control: backend.control, storage, observer,
      restore: async (snapshot, onProgress, signal) => {
        this.#ensureActive();
        await this.network.disconnect();
        return this.#managed.restore(snapshot, onProgress, signal);
      },
    });
    this.workspace = new BrowserWorkspace(options.workspaceId, {
      files,
      readFile: (path, signal) => files.readFile(path, signal),
      writeFile: (path, data, signal) => files.writeFile(path, data, signal),
      list: (path, signal) => files.list(path, signal),
      remove: (path, recursive, signal) => files.remove(path, recursive, signal),
    });
    const unsupported = <T>() => unavailable<T>("System diagnostics are unavailable in Userspace mode", 7);
    this.diagnostics = {
      runCoreProbe: unsupported,
      runSystemProbe: unsupported,
      bootSystem: unsupported,
      runSystemSlice: unsupported,
      startSystem: unsupported,
      writeSystemConsole: unsupported,
      resizeSystemConsole: unsupported,
      configureSystemTrace: unsupported,
      readSystemTrace: unsupported,
      readInstallationProfile: unsupported,
    };
  }

  async bootManagedImage(
    manifestUrl: string | URL,
    options: ManagedImageBootOptions = {},
  ): Promise<ManagedImageInfo> {
    this.#ensureActive();
    await this.network.disconnect();
    return this.#managed.boot(manifestUrl, options);
  }

  async spawn(spec: SpawnSpec): Promise<ProcessHandle> {
    return this.#spawn(spec, false);
  }

  checkForUpdate(options:{readonly signal?:AbortSignal}={}):Promise<{readonly id:string;readonly version:string}|null> {
    this.#ensureActive();
    return this.#managed.checkForUpdate(AbortSignal.any([this.#disposing.signal,...(options.signal===undefined?[]:[options.signal])]));
  }

  prepareImage(options: {readonly signal?:AbortSignal} = {}): Promise<void> {
    this.#ensureActive();
    return this.#managed.prepareImage(AbortSignal.any([this.#disposing.signal,...(options.signal===undefined?[]:[options.signal])]));
  }

  async spawnGuest(spec: SpawnSpec): Promise<ProcessHandle> {
    return this.#spawn(spec, true);
  }
  readJSProcessTrace(capacity?: number): Promise<Uint8Array> { this.#ensureActive(); return this.#backend.readJSProcessTrace(capacity); }
  watchAccelerationNotices(listener: (notice: AccelerationNotice) => void, options: { readonly signal: AbortSignal }): Promise<void> {
    this.#ensureActive();
    return this.#backend.watchAccelerationNotices(listener, AbortSignal.any([options.signal, this.#disposing.signal]));
  }

  async spawnJS(spec: Omit<SpawnSpec, "command"> & { readonly worker: string }): Promise<ProcessHandle> {
    this.#ensureActive();
    const rootfs = this.#managed.rootfs;
    if (rootfs === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Install a Userspace image before spawning a JS process");
    const { worker, ...native } = spec;
    const validated = validateSpawnSpec({ ...native, command: "/js-process" }, true);
    return this.#backend.spawnJS(rootfs, worker, validated.args, validated.env, validated.cwd, validated.terminal, validated.signal);
  }

  async #spawn(spec: SpawnSpec, guestPaths: boolean): Promise<ProcessHandle> {
    this.#ensureActive();
    const rootfs = this.#managed.rootfs;
    if (rootfs === undefined) {
      throw new VMError("FEATURE_NOT_AVAILABLE", "Install a Userspace rootfs before spawning", { phase: 7 });
    }
    const validated = validateSpawnSpec(spec, guestPaths);
    requireGuestExecution(validated.execution);
    const admitted = guestPaths ? nativeGuestCommand(validated.command, validated.args)
      : { executable: validated.command, arguments: [validated.command, ...validated.args] };
    return this.#backend.spawnManaged(
      rootfs,
      admitted.executable,
      admitted.arguments,
      validated.signal,
      validated.env,
      validated.cwd,
      validated.terminal,
    );
  }

  storagePersistence(): Promise<"opfs" | "indexeddb"> {
    this.#ensureActive();
    return this.#storage.request("workspace-persistence", undefined);
  }

  async [USERSPACE_READ_PROFILE](pid: unknown): Promise<unknown> {
    this.#ensureActive();
    return this.#backend.readExecutionProfile(integer(pid, "Userspace profile PID", 1));
  }

  async [USERSPACE_READ_SYSCALL_TRACE](pid: unknown): Promise<unknown> {
    this.#ensureActive();
    return this.#backend.readSyscallTrace(integer(pid, "Userspace syscall trace PID", 1));
  }

  prepareDependencies(_options?: DependencyPreparationOptions): Promise<DependencyInstallHandle> {
    void _options;
    this.#ensureActive();
    return Promise.reject(new VMError("FEATURE_NOT_AVAILABLE", "Dependency preparation requires system assistance"));
  }

  /** One preview session per exposed port on its own origin below `previewOrigin`;
   * Userspace listeners are reached through the same session transport as
   * system-mode ones. */
  async exposePort(port: number, options?: { readonly signal?: AbortSignal }): Promise<PreviewHandle> {
    this.#ensureActive();
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new VMError("INVALID_ARGUMENT", "preview port must be an integer from 1 through 65535");
    }
    const previewOrigin = this.#previewOrigin;
    if (previewOrigin === undefined) {
      throw new VMError("FEATURE_NOT_AVAILABLE", "previewOrigin is required for isolated port exposure", { phase: 8 });
    }
    if (this.#previews.has(port)) throw new VMError("INVALID_ARGUMENT", "This port already has an active preview session");
    // Closing frees the VM for the next session at once; the old one finishes closing on its own.
    const opening = openPreviewSession({ previewOrigin, isolation: this.#previewIsolation, ...(this.#previewKeeperHost === undefined ? {} : { host: this.#previewKeeperHost }), runtime: "userspace", port, network: this.#network, signal: AbortSignal.any([this.#disposing.signal, ...(options?.signal === undefined ? [] : [options.signal])]) }).then(handle => ({
      url: handle.url,
      close: () => { if (this.#previews.get(port) === opening) this.#previews.delete(port); return handle.close(); },
    }));
    this.#previews.set(port, opening);
    opening.catch(() => { if (this.#previews.get(port) === opening) this.#previews.delete(port); });
    return opening;
  }

  async listeningPorts(options: { readonly signal?: AbortSignal } = {}): Promise<readonly ListeningPort[]> {
    this.#ensureActive();
    return (await this.#backend.listeningPorts(null, options.signal)).ports ?? [];
  }

  async watchListeningPorts(onChange: (ports: readonly ListeningPort[]) => void, options: { readonly signal: AbortSignal }): Promise<void> {
    const { signal } = decodeWatchOptions(options);
    if (typeof onChange !== "function") throw new VMError("INVALID_ARGUMENT", "watchListeningPorts needs an onChange function");
    // Disposal ends the wait at once; the next read then rejects with PROTOCOL_ERROR.
    const disposing = this.#disposing.signal;
    await watchListeningPorts((known, readSignal) => {
      this.#ensureActive();
      return this.#backend.listeningPorts(known, readSignal);
    }, onChange, signal, (ms, waitSignal) => pollDelay(ms, AbortSignal.any([waitSignal, disposing])));
  }

  snapshot(label?: string): Promise<SnapshotRef> {
    this.#ensureActive();
    return this.#backend.control.request("snapshot", label === undefined ? {} : { label: validateSnapshotLabel(label) }, { cancellation: "settled" });
  }

  async restore(snapshot: SnapshotRef): Promise<void> {
    this.#ensureActive();
    await this.network.disconnect();
    await this.#managed.restore(snapshot);
  }

  async suspend(options: { readonly label: string; readonly signal?: AbortSignal }): Promise<SnapshotInfo> {
    this.#ensureActive();
    const label = validateRestorePointName(options.label);
    if (!this.#managed.active) throw new VMError("INVALID_ARGUMENT", "only a VM running a managed image can be suspended", { reason: "not-running" });
    const signal = AbortSignal.any([this.#disposing.signal, ...(options.signal === undefined ? [] : [options.signal])]);
    await this.#backend.control.request("flush-userspace", undefined, { signal, cancellation: "settled" });
    const saved = await this.snapshots.capture({ label, kind: "automatic", signal });
    void this.dispose().catch(() => undefined);
    return saved;
  }

  allowWorkspaceHandoff(onMovedAway: (moved: WorkspaceMovedAway) => void, options: { readonly signal: AbortSignal }): void {
    allowWorkspaceHandoff(
      this.#workspaceId,
      AbortSignal.any([this.#disposing.signal, this.#storage.lifetime]),
      () => this.#handOff(),
      onMovedAway,
      options,
    );
  }

  async #handOff(): Promise<WorkspaceMovedAway> {
    if (this.#managed.active) {
      try {
        await this.#backend.control.request("flush-userspace", undefined);
        await this.#backend.control.request("snapshot", {}, { cancellation: "settled" });
      } catch (error) {
        const failure = error instanceof VMError ? error : new VMError("GUEST_CRASH", String(error));
        try { await this.snapshots.autoSave.configure({ enabled: true }); }
        catch (cleanup) { throw withCleanupFailure(failure, cleanup); }
        throw failure;
      }
    }
    const saved = this.#managed.active;
    await this.dispose().catch(() => undefined);
    return { saved };
  }

  async #closePreviews(): Promise<void> {
    const previews = [...this.#previews.values()]; this.#previews.clear();
    // A committed restore remains committed even when an old preview origin stopped answering.
    await Promise.allSettled(previews.map(preview => rejectingTimeout(preview.then(handle => handle.close(), () => undefined))));
  }

  dispose(): Promise<void> {
    this.#disposing.abort();
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    this.#disposed = true;
    const previews = [...this.#previews.values()]; this.#previews.clear();
    let failure: unknown;
    try {
      for (const operation of [
        () => this.network.dispose(),
        () => this.#backend.dispose(),
        () => this.#storage.request("dispose", undefined),
      ]) {
        try { await rejectingTimeout(operation()); }
        catch (error: unknown) { failure ??= error; }
      }
      // Each close is bounded, so one silent preview cannot keep the workers alive.
      const closed = await Promise.allSettled(previews.map(preview => rejectingTimeout(preview.then(handle => handle.close(), () => undefined))));
      const failed = closed.find(result => result.status === "rejected");
      if (failed?.status === "rejected") failure ??= failed.reason as unknown;
    } finally {
      this.#storage.terminate();
      this.#network.terminate();
    }
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) {
      const serialized = serializeUnknownError(failure);
      throw new VMError(serialized.code, serialized.message, serialized.detail);
    }
  }

  #ensureActive(): void {
    if (this.#disposed) throw new VMError("PROTOCOL_ERROR", "Userspace VM is disposed");
  }
}

export function decodeUserspaceProfileOptions(
  options: RuntimeVMOptions,
): UserspaceProfileOptions | undefined {
  const value: unknown = Reflect.get(options, USERSPACE_PROFILE_OPTIONS);
  if (value === undefined) return undefined;
  const profile = record(value, "Userspace profile options");
  exactKeys(profile, ["executionTiming"], ["syscallTraceCapacity"]);
  const rawTiming = record(profile["executionTiming"], "Userspace execution timing mode");
  exactKeys(rawTiming, ["kind"]);
  const kind = string(rawTiming["kind"], "Userspace execution timing mode kind");
  if (kind !== "disabled" && kind !== "sampled" && kind !== "exact") {
    throw new VMError("INVALID_ARGUMENT", "Userspace execution timing mode is invalid");
  }
  return {
    executionTiming: { kind },
    ...(profile["syscallTraceCapacity"] === undefined
      ? {}
      : {
          syscallTraceCapacity: integer(
            profile["syscallTraceCapacity"],
            "Userspace syscall trace capacity",
            1,
            4_096,
          ),
        }),
  };
}

function unavailable<T>(message: string, phase: number): Promise<T> {
  return Promise.reject(
    new VMError("FEATURE_NOT_AVAILABLE", message, { phase }),
  );
}
