import { NetworkClient } from "./network-client.js";
import { rejectingTimeout } from "./disposal.js";
import { SystemWorkspaceFiles } from "./system-workspace-files.js";
import { VMError, serializeUnknownError, withCleanupFailure } from "./errors.js";
import type { SystemJitInstallMode } from "./protocol/system-trace-background-compile.js";
import { requireAssistanceAdmission, requireGuestExecution } from "./assistance-admission.js";
import { createDiskBridgeBuffer } from "./disk-bridge.js";
import { GuestProcessTransport } from "./guest-process.js";
import { ManagedSession } from "./managed-session.js";
import { SystemNetworkWorker } from "./system-network-worker.js";
import { SystemListeningPorts } from "./system-listening-ports.js";
import { decodeWatchOptions } from "./listening-ports.js";
import { SnapshotObserver } from "./snapshot-observer.js";
import { allowWorkspaceHandoff, type WorkspaceMovedAway } from "./workspace-handoff.js";
import { RuntimeSnapshots } from "./snapshots.js";
import type { RuntimeVMSnapshots } from "./snapshot-types.js";
import {
  type ControlOperations,
  controlResponseDecoders,
  storageResponseDecoders,
  type StorageOperations,
  type SnapshotInfo,
  type SnapshotRef,
  type RuntimeVMCapabilities,
  MAX_SYSTEM_TRACE_EVENTS,
  validateCoreProbeInput,
  validateSystemBootInput,
  validateSystemConsoleInput,
  validateSystemProbeInput,
  validateSystemSliceInput,
  validateRestorePointName,
  validateSnapshotLabel,
} from "./protocol.js";
import { SystemExecutionTransport } from "./system-execution.js";
import { WorkerClient } from "./worker-client.js";
import { createAttentionCounter } from "./host-attention.js";
import { BrowserWorkspace, type Workspace } from "./workspace.js";
import { integer } from "./decode.js";

import type { RuntimeVMOptions, DependencyInstallHandle, DependencyPreparationOptions, ListeningPort, ManagedImageInfo, ManagedImageBootOptions, SpawnSpec, ProcessHandle, PreviewHandle, PreviewIsolation, SystemBootSpec, RuntimeVM, RuntimeVMDiagnostics } from "./vm-types.js";
import { validateDependencyPreparation, validateSpawnSpec } from "./vm-options.js";
import type { AssistanceFrontEnd, AssistanceFrontEndFactory } from "./assistance-front-end.js";
import { openPreviewSession } from "./preview-session.js";
import type { PreviewKeeperHost } from "./preview-keeper.js";

const SYSTEM_READ_AOT_TRAINING = Symbol.for("oxidevm.internal.system-read-aot-training");

export async function createSystemRuntimeVM(
  validated: Extract<RuntimeVMOptions, { mode: "system" }>,
  jitInstall?: SystemJitInstallMode,
  assistanceFactory?: AssistanceFrontEndFactory,
): Promise<RuntimeVM> {
  if (validated.assistance !== undefined) requireAssistanceAdmission();
  if (validated.assistance !== undefined && assistanceFactory === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "assistance requires the diagnostics entry point");
  // The control worker runs the guest; counted requests end its run slices early (host attention).
  const control = new WorkerClient<ControlOperations>(
    new Worker(new URL("./workers/control.worker.js", import.meta.url), {
      name: "oxidevm-control",
      type: "module",
    }),
    controlResponseDecoders,
    "immediate",
    createAttentionCounter(),
  );
  const storage = new WorkerClient<StorageOperations>(
    new Worker(new URL("./workers/storage.worker.js", import.meta.url), {
      name: "oxidevm-storage",
      type: "module",
    }),
    storageResponseDecoders,
    "settled",
  );
  let diskBridge =
    typeof SharedArrayBuffer === "function" &&
    globalThis.crossOriginIsolated
      ? {
          buffer: createDiskBridgeBuffer(),
          channel: new MessageChannel(),
        }
      : undefined;
  const snapshotChannel = new MessageChannel();

  let capabilities: RuntimeVMCapabilities;
  const network = new SystemNetworkWorker(control, validated.netstackWasmUrl);
  try {
    await storage.request(
      "initialize",
      {
        workspaceId: validated.workspaceId,
        snapshotPort: snapshotChannel.port2,
        ...(validated.ephemeral === undefined ? {} : { ephemeral: validated.ephemeral }),
        machine: { memoryMiB: validated.memoryMiB, vcpus: validated.vcpus },
        ...(diskBridge === undefined ? {} : { diskBridge: diskBridge.buffer, diskPort: diskBridge.channel.port2 }),
      },
      { transfer: [snapshotChannel.port2, ...(diskBridge === undefined ? [] : [diskBridge.channel.port2])] },
    );
    // Shared memory availability does not imply an OPFS disk backend. The
    // IndexedDB owner uses the existing disk path and cannot service this ring.
    if (diskBridge !== undefined && await storage.request("workspace-persistence", undefined) !== "opfs") {
      diskBridge.channel.port1.close();
      diskBridge = undefined;
    }
    capabilities = await control.request(
      "initialize",
      {
        coreWasmUrl: validated.coreWasmUrl ?? "/oxidevm_core.wasm",
        sharedCoreWasmUrl:
          validated.sharedCoreWasmUrl ?? "/oxidevm_core_shared.wasm",
        workspaceId: validated.workspaceId,
        memoryMiB: validated.memoryMiB,
        vcpus: validated.vcpus,
        snapshotPort: snapshotChannel.port1,
        ...(diskBridge === undefined
          ? {}
          : {
              diskBridge: diskBridge.buffer,
              diskPort: diskBridge.channel.port1,
            }),
        ...(jitInstall === undefined ? {} : { jitInstall }),
      },
      {
        transfer: [
          snapshotChannel.port1,
          ...(diskBridge === undefined ? [] : [diskBridge.channel.port1]),
        ],
      },
    );
    if (validated.assistance !== undefined) await network.connectAssistance();
  } catch (error) {
    snapshotChannel.port1.close();
    diskBridge?.channel.port1.close();
    control.terminate();
    storage.terminate();
    network.terminate();
    throw error;
  }

  const vm = new BrowserRuntimeVM(validated, capabilities, control, storage, network, assistanceFactory);
  if (validated.network === "relay" && validated.relayUrl !== undefined) {
    try { await vm.network.connect({kind: "server", url: validated.relayUrl}); }
    catch (error: unknown) { await vm.dispose().catch(() => {}); throw error; }
  }
  return vm;
}

class BrowserRuntimeVM implements RuntimeVM {
  storagePersistence(): Promise<"opfs" | "indexeddb"> {
    return this.#storage.request("workspace-persistence", undefined);
  }
  readonly mode = "system" as const;
  readonly capabilities: RuntimeVMCapabilities;
  readonly workspace: Workspace;
  readonly diagnostics: RuntimeVMDiagnostics;
  readonly network: NetworkClient;
  readonly snapshots: RuntimeVMSnapshots;
  readonly #control: WorkerClient<ControlOperations>;
  readonly #storage: WorkerClient<StorageOperations>;
  readonly #network: SystemNetworkWorker;
  readonly #listening: SystemListeningPorts;
  readonly #memoryMiB: number;
  readonly #workspaceId: string;
  readonly #ephemeral: boolean;
  /** Aborted when disposal starts, so a disposing VM no longer hands its workspace over. */
  readonly #disposing = new AbortController();
  readonly #assistance: AssistanceFrontEnd | undefined;
  readonly #previewOrigin: URL | undefined;
  readonly #previewIsolation: PreviewIsolation;
  readonly #previewKeeperHost: PreviewKeeperHost | undefined;
  readonly #previews = new Map<number, Promise<PreviewHandle>>();
  #activeExecution: SystemExecutionTransport | undefined;
  #nextSystemSessionId = 1;
  readonly #managed: ManagedSession;
  #disposePromise: Promise<void> | undefined;
  /** Set once the workspace went out with a save before stopping: disposal does not write it again. */
  #suspended = false;

  get imageIdentity() { return this.#managed.imageIdentity; }

  constructor(
    options: Extract<RuntimeVMOptions, { mode: "system" }>,
    capabilities: RuntimeVMCapabilities,
    control: WorkerClient<ControlOperations>,
    storage: WorkerClient<StorageOperations>,
    network: SystemNetworkWorker,
    assistanceFactory?: AssistanceFrontEndFactory,
  ) {
    this.#control = control;
    this.#storage = storage;
    this.#network = network;
    this.network = new NetworkClient(() => network.start(), {origin: typeof location === "undefined" ? "null" : location.origin, workspaceId: options.workspaceId, serverAllowed: options.relayPolicy !== "personal-only"}, () => network.connectLink());
    this.#listening = new SystemListeningPorts(control);
    this.#memoryMiB = options.memoryMiB;
    this.#workspaceId = options.workspaceId;
    this.#ephemeral = options.ephemeral === true;
    const observer = new SnapshotObserver(control);
    this.#managed = new ManagedSession({
      control,
      storage,
      memoryMiB: options.memoryMiB,
      vcpus: capabilities.vcpus,
      startExecution: (signal) => this.diagnostics.startSystem(signal === undefined ? {} : { signal }),
      stopExecution: () => this.#stopActiveExecution(),
      executionRunning: () => this.#activeExecution?.running === true,
      syncGuestDisk: () => this.#syncGuestDisk(),
      attachProcess: (agentRequestId, signal) => this.#attachProcess(agentRequestId, signal),
      observe: (listener, signal) => observer.listen(listener, signal),
      connectNetworkLink: (signal) => network.connectLink(signal),
    });
    this.snapshots = new RuntimeSnapshots({
      control,
      storage,
      observer,
      restore: async (snapshot, onProgress, signal) => { await this.network.disconnect(); return this.#managed.restore(snapshot, onProgress, signal); },
    });
    this.#assistance = options.assistance === undefined ? undefined : assistanceFactory?.(control, options.assistance);
    this.#previewOrigin = options.previewOrigin === undefined ? undefined : new URL(options.previewOrigin);
    this.#previewIsolation = options.previewIsolation ?? "per-session";
    this.#previewKeeperHost = options.previewKeeperHost;
    this.capabilities = capabilities;
    this.workspace = new BrowserWorkspace(options.workspaceId, {
      files: new SystemWorkspaceFiles(control),
      readFile: (path, signal) =>
        control.request("agent-read-file", { path }, { signal }),
      writeFile: (path, data, signal) =>
        control.request(
          "agent-write-file",
          { path, data },
          { signal, transfer: [data.buffer] },
        ),
      list: (path, signal) =>
        control.request("agent-list", { path }, { signal }),
      remove: (path, recursive, signal) =>
        control.request(
          "agent-remove",
          { path, recursive },
          { signal },
        ),
    });
    this.diagnostics = {
      runCoreProbe: (program, options = {}) => {
        const maximumSteps = options.maximumSteps ?? 1000;
        validateCoreProbeInput(program.byteLength, maximumSteps);
        const copy = program.slice();
        return control.request(
          "run-core-probe",
          {
            program: copy,
            maximumSteps,
          },
          { signal: options.signal, transfer: [copy.buffer] },
        );
      },
      runSystemProbe: async (boot, probeOptions = {}) => {
        const maximumSteps = probeOptions.maximumSteps ?? 1_000_000;
        validateSystemProbeInput(
          this.#memoryMiB,
          boot.kernel.byteLength,
          boot.initrd?.byteLength ?? 0,
          boot.disk?.byteLength ?? 0,
          boot.commandLine,
          maximumSteps,
        );
        await this.network.disconnect();
        const { request, transfer } = copySystemBoot(this.#memoryMiB, boot);
        this.#managed.deactivate();
        return control.request(
          "run-system-probe",
          {
            ...request,
            maximumSteps,
          },
          { signal: probeOptions.signal, transfer },
        );
      },
      bootSystem: async (boot, bootOptions = {}) => {
        validateSystemBootInput(
          this.#memoryMiB,
          boot.kernel.byteLength,
          boot.initrd?.byteLength ?? 0,
          boot.disk?.byteLength ?? 0,
          boot.commandLine,
        );
        await this.network.disconnect();
        const { request, transfer } = copySystemBoot(this.#memoryMiB, boot);
        this.#managed.deactivate();
        return control.request("boot-system", { ...request, ...(bootOptions.console === undefined ? {} : { console: bootOptions.console }) }, {
          signal: bootOptions.signal,
          transfer,
        });
      },
      runSystemSlice: (sliceOptions = {}) => {
        const maximumSteps = sliceOptions.maximumSteps ?? 100_000;
        validateSystemSliceInput(maximumSteps);
        return control.request(
          "run-system-slice",
          { maximumSteps },
          { signal: sliceOptions.signal },
        );
      },
      startSystem: async (executionOptions = {}) => {
        await this.#activeExecution?.stop();
        if (signalAborted(executionOptions.signal)) {
          throw new VMError("ABORTED", "operation was aborted");
        }
        const sessionId = this.#nextSystemSessionId++;
        const channel = new MessageChannel();
        const execution = new SystemExecutionTransport(
          channel.port1,
          sessionId,
          {
            pause: () => control.request("pause-system", { sessionId }),
            resume: () => control.request("resume-system", { sessionId }),
            stop: () => control.request("stop-system", { sessionId }),
          },
        );
        this.#activeExecution = execution;
        try {
          await control.request(
            "start-system",
            { sessionId, port: channel.port2 },
            { transfer: [channel.port2] },
          );
        } catch (error) {
          if (this.#activeExecution === execution) {
            this.#activeExecution = undefined;
          }
          // The caller never receives this execution, so nothing else observes its exit.
          execution.exit.catch(() => undefined);
          execution.fail(error);
          throw error;
        }
        if (executionOptions.signal?.aborted === true) {
          await execution.stop();
          if (this.#activeExecution === execution) {
            this.#activeExecution = undefined;
          }
          throw new VMError("ABORTED", "operation was aborted");
        }
        const abort = () => {
          void execution.stop();
        };
        executionOptions.signal?.addEventListener("abort", abort, {
          once: true,
        });
        const cleanup = () => {
          executionOptions.signal?.removeEventListener("abort", abort);
          if (this.#activeExecution === execution) {
            this.#activeExecution = undefined;
          }
        };
        void execution.exit.then(cleanup, cleanup);
        return execution;
      },
      writeSystemConsole: (data, consoleOptions = {}) => {
        validateSystemConsoleInput(data.byteLength);
        const copy = data.slice();
        return control.request(
          "write-system-console",
          { data: copy },
          { signal: consoleOptions.signal, transfer: [copy.buffer] },
        );
      },
      resizeSystemConsole: (size, consoleOptions = {}) => {
        if (![size.columns, size.rows].every(value => Number.isInteger(value) && value >= 1 && value <= 1000)) {
          throw new VMError("INVALID_ARGUMENT", "console dimensions must be integers from 1 to 1000");
        }
        return control.request("resize-system-console", size, { signal: consoleOptions.signal });
      },
      configureSystemTrace: (traceOptions = {}) => {
        const capacity = integer(
          traceOptions.capacity ?? MAX_SYSTEM_TRACE_EVENTS,
          "system trace capacity",
          0,
          MAX_SYSTEM_TRACE_EVENTS,
        );
        const interpreterOnly = traceOptions.interpreterOnly ?? false;
        if (typeof interpreterOnly !== "boolean") {
          throw new VMError(
            "INVALID_ARGUMENT",
            "interpreterOnly must be a boolean",
          );
        }
        const interpretedSemantics = traceOptions.interpretedSemantics ?? [];
        const interpretedRipRanges = traceOptions.interpretedRipRanges ?? [];
        const checkpointPolicy: unknown = traceOptions.checkpointPolicy ?? "faults-and-stderr";
        if (
          checkpointPolicy !== "faults-and-stderr" &&
          checkpointPolicy !== "faults-only"
        ) {
          throw new VMError(
            "INVALID_ARGUMENT",
            "checkpointPolicy must be faults-and-stderr or faults-only",
          );
        }
        if (
          interpretedSemantics.length > 256 ||
          interpretedSemantics.some(
            (semantic) =>
              !Number.isInteger(semantic) ||
              semantic < 0 ||
              semantic > 0xffff,
          ) ||
          new Set(interpretedSemantics).size !== interpretedSemantics.length ||
          (interpreterOnly && interpretedSemantics.length !== 0)
        ) {
          throw new VMError(
            "INVALID_ARGUMENT",
            "interpretedSemantics must contain unique u16 semantic IDs and cannot be combined with interpreterOnly",
          );
        }
        let previousEnd = 0n;
        if (
          interpretedRipRanges.length > 32 ||
          interpretedRipRanges.some((range, index) => {
            const invalid =
              typeof range.start !== "bigint" ||
              typeof range.end !== "bigint" ||
              range.start < 0n ||
              range.start >= range.end ||
              range.end > 0xffff_ffff_ffff_ffffn ||
              (index !== 0 && range.start < previousEnd);
            if (!invalid) previousEnd = range.end;
            return invalid;
          }) ||
          (interpretedRipRanges.length !== 0 &&
            interpretedSemantics.length === 0)
        ) {
          throw new VMError(
            "INVALID_ARGUMENT",
            "interpretedRipRanges must contain ordered, non-overlapping u64 intervals and require interpretedSemantics",
          );
        }
        return control.request(
          "configure-system-trace",
          {
            capacity,
            interpreterOnly,
            interpretedSemantics: [...interpretedSemantics],
            interpretedRipRanges: interpretedRipRanges.map((range) => ({
              start: range.start,
              end: range.end,
            })),
            checkpointPolicy,
          },
          { signal: traceOptions.signal },
        );
      },
      readSystemTrace: (traceOptions = {}) =>
        control.request(
          "read-system-trace",
          undefined,
          { signal: traceOptions.signal },
        ),
      readInstallationProfile: (profileOptions = {}) =>
        control.request(
          "assistance-installation-profile",
          undefined,
          { signal: profileOptions.signal },
        ),
    };
  }

  [SYSTEM_READ_AOT_TRAINING](): Promise<Uint8Array> {
    return this.#control.request("read-system-aot-training", undefined);
  }

  async bootManagedImage(manifestUrl: string | URL, options: ManagedImageBootOptions = {}): Promise<ManagedImageInfo> {
    await this.network.disconnect();
    return this.#managed.boot(manifestUrl, options);
  }

  async prepareImage(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    this.#managed.assertUsable();
    const signal=AbortSignal.any([this.#disposing.signal,...(options.signal===undefined?[]:[options.signal])]);
    await this.#storage.request("prepare-current-system-image", undefined, { signal, cancellation: "settled" });
  }

  checkForUpdate(options: { readonly signal?: AbortSignal } = {}): Promise<{ readonly id: string; readonly version: string } | null> {
    return this.#managed.checkForUpdate(AbortSignal.any([this.#disposing.signal,...(options.signal===undefined?[]:[options.signal])]));
  }

  async spawn(spec: SpawnSpec): Promise<ProcessHandle> {
    return this.#spawn(spec, false);
  }

  async spawnGuest(spec: SpawnSpec): Promise<ProcessHandle> {
    return this.#spawn(spec, true);
  }

  async #spawn(spec: SpawnSpec, guestPaths: boolean): Promise<ProcessHandle> {
    this.#managed.assertUsable();
    const validated = validateSpawnSpec(spec, guestPaths);
    if (validated.execution?.kind === "assisted-node") {
      requireAssistanceAdmission();
      if (this.#assistance === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Configure a system execution origin before assisted spawn");
      return this.#assistance.spawn(validated, this.#managed.workspaceBaseSha256);
    }
    requireGuestExecution(validated.execution);
    const channel = new MessageChannel();
    let spawned;
    try {
      spawned = await this.#control.request(
        "agent-spawn",
        {
          command: validated.command,
          args: validated.args,
          cwd: validated.cwd,
          env: validated.env,
          ...(guestPaths ? { guestPaths: true } : {}),
          ...(validated.terminal === undefined ? {} : { terminal: validated.terminal }),
          port: channel.port2,
        },
        { signal: validated.signal, transfer: [channel.port2] },
      );
    } catch (error) {
      channel.port1.close();
      throw error;
    }
    return this.#guestProcess(channel.port1, spawned, validated.signal, validated.terminal !== undefined);
  }

  /** Gives the page a guest process a restore brought back; its saved screen comes first. */
  async #attachProcess(agentRequestId: number, signal: AbortSignal | undefined): Promise<ProcessHandle> {
    this.#managed.assertUsable();
    const channel = new MessageChannel();
    let attached;
    try {
      attached = await this.#control.request(
        "agent-attach-process",
        { agentRequestId, port: channel.port2 },
        { signal, transfer: [channel.port2] },
      );
    } catch (error) {
      channel.port1.close();
      throw error;
    }
    return this.#guestProcess(channel.port1, attached, signal, attached.terminal ?? false);
  }

  /** A process handle over the page side of a guest process's port. */
  #guestProcess(
    port: MessagePort,
    spawned: { readonly pid: number; readonly sessionId: number },
    signal: AbortSignal | undefined,
    terminal = false,
  ): ProcessHandle {
    const process = new GuestProcessTransport(
      port,
      spawned.pid,
      spawned.sessionId,
      {
        snapshotKey:`process:${String(spawned.sessionId)}`,
        lifetime: this.#control.lifetime,
        write: (data) => {
          const copy = data.slice();
          return this.#control.request(
            "agent-stdin",
            { pid: spawned.pid, data: copy },
            { transfer: [copy.buffer] },
          );
        },
        closeStdin: () =>
          this.#control.request(
            "agent-close-stdin",
            { pid: spawned.pid },
          ),
        signal: (signal) =>
          this.#control.request("agent-signal", {
            pid: spawned.pid,
            signal,
          }),
        signalNamed: (signal, scope) => this.#control.request("agent-process-control", { pid: spawned.pid, sessionId: spawned.sessionId, control: { kind: "signal", signal, scope } }),
        resize: size => this.#control.request("agent-process-control", { pid: spawned.pid, sessionId: spawned.sessionId, control: { kind: "resize", ...size } }),
        interrupt: () => this.#control.request("agent-process-control", { pid: spawned.pid, sessionId: spawned.sessionId, control: { kind: "interrupt" } }),
      }, terminal,
    );
    const abort = () => {
      void process.kill("KILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
    };
    void process.exit.then(cleanup, cleanup);
    return process;
  }

  async prepareDependencies(options?: DependencyPreparationOptions): Promise<DependencyInstallHandle> {
    const validated = validateDependencyPreparation(options);
    if (signalAborted(validated.signal) || this.#disposePromise !== undefined) throw new VMError("ABORTED", "Dependency preparation cancelled");
    this.#managed.assertUsable();
    requireAssistanceAdmission();
    if (this.#assistance === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Configure system assistance before preparing dependencies");
    this.#assistance.assertPreparationAvailable();
    const workspaceBaseSha256 = this.#managed.workspaceBaseSha256;
    if (!this.#managed.active || workspaceBaseSha256 === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Boot a managed workspace before preparing dependencies");
    const channel = new MessageChannel();
    const failed = new AbortController();
    const connecting = this.#assistance.connectInstallation(channel.port1, AbortSignal.any([this.#control.lifetime, failed.signal]));
    void connecting.catch(() => {});
    try {
      await this.#control.request("assistance-install", { cwd: validated.cwd, frozenLockfile: validated.frozenLockfile,
        workspaceBaseSha256, port: channel.port2 }, { signal: validated.signal, transfer: [channel.port2] });
      const installed = await connecting;
      const approval = new AbortController();
      const signal = AbortSignal.any([approval.signal, ...(validated.signal === undefined ? [] : [validated.signal])]);
      const assistance = this.#assistance;
      const handle: DependencyInstallHandle = {
        stdin: installed.stdin, stdout: installed.stdout, stderr: installed.stderr, exit: installed.exit,
        generation: installed.generation.catch((error: unknown) => assistance.approveBlockedBuilds(error, workspaceBaseSha256, signal)),
        kill: signal => { approval.abort(); return installed.kill(signal); },
      };
      const abort = () => { void handle.kill("KILL").catch(() => {}); };
      validated.signal?.addEventListener("abort", abort, { once: true });
      const detach = () => validated.signal?.removeEventListener("abort", abort);
      void handle.generation.then(detach, detach);
      if (signalAborted(validated.signal)) {
        await handle.kill("KILL");
        throw new VMError("ABORTED", "Dependency preparation cancelled");
      }
      return handle;
    } catch (error) {
      failed.abort(); channel.port1.close(); channel.port2.close();
      throw error;
    }
  }

  /** One preview session per exposed port on its own origin. Browser requests reach the
   * assisted listener through Linux loopback inside its own task; the handle
   * resolves only once that origin's Service Worker holds the transport. */
  exposePort(port: number, options?: { readonly signal?: AbortSignal }): Promise<PreviewHandle> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return Promise.reject(new VMError("INVALID_ARGUMENT", "preview port must be an integer from 1 through 65535"));
    }
    // The network link carries previews of managed images; assistance keeps its own path without it.
    const network = this.#network.worker;
    if (network === undefined || (!this.#network.linked && this.#assistance === undefined)) {
      return Promise.reject(new VMError("FEATURE_NOT_AVAILABLE", "Previews need a managed Linux image's network link", { reason: "no-network-link" }));
    }
    const previewOrigin = this.#previewOrigin;
    if (previewOrigin === undefined) {
      return Promise.reject(new VMError("FEATURE_NOT_AVAILABLE", "previewOrigin is required for isolated port exposure", { phase: 8 }));
    }
    if (this.#previews.has(port)) return Promise.reject(new VMError("INVALID_ARGUMENT", "This port already has an active preview session"));
    // Closing frees the VM for the next session at once; the old one finishes closing on its own.
    const opening = openPreviewSession({ previewOrigin, isolation: this.#previewIsolation, ...(this.#previewKeeperHost === undefined ? {} : { host: this.#previewKeeperHost }), runtime: "system", port, network, signal: AbortSignal.any([this.#disposing.signal, ...(options?.signal === undefined ? [] : [options.signal])]) }).then(handle => ({
      url: handle.url,
      close: () => { if (this.#previews.get(port) === opening) this.#previews.delete(port); return handle.close(); },
    }));
    this.#previews.set(port, opening);
    opening.catch(() => { if (this.#previews.get(port) === opening) this.#previews.delete(port); });
    return opening;
  }

  /** Rejects with `agent-not-ready` before the managed image's agent greets, and with
   * `image-update-required` when that agent cannot report ports (no capability 64). */
  listeningPorts(options: { readonly signal?: AbortSignal } = {}): Promise<readonly ListeningPort[]> {
    return this.#listening.list(options.signal);
  }

  /** Waits for the agent's greeting and carries on across restores and agent restarts. */
  async watchListeningPorts(onChange: (ports: readonly ListeningPort[]) => void, options: { readonly signal: AbortSignal }): Promise<void> {
    const { signal } = decodeWatchOptions(options);
    if (typeof onChange !== "function") throw new VMError("INVALID_ARGUMENT", "watchListeningPorts needs an onChange function");
    await this.#listening.watch(onChange, signal);
  }

  snapshot(label?: string): Promise<SnapshotRef> {
    return this.#control.request(
      "snapshot",
      label === undefined ? {} : { label: validateSnapshotLabel(label) },
    );
  }

  async restore(snapshot: SnapshotRef): Promise<void> {
    await this.#managed.restore(snapshot);
  }

  allowWorkspaceHandoff(onMovedAway: (moved: WorkspaceMovedAway) => void, options: { readonly signal: AbortSignal }): void {
    allowWorkspaceHandoff(
      this.#workspaceId,
      AbortSignal.any([this.#disposing.signal, this.#control.lifetime]),
      () => this.#handOff(),
      onMovedAway,
      options,
    );
  }

  /** Saves a running managed VM, then disposes the VM, which frees its workspace for another tab. */
  async #handOff(): Promise<WorkspaceMovedAway> {
    let moved: WorkspaceMovedAway = { saved: false };
    if (this.#managed.active) {
      try {
        // Without a label the save is automatic, and resuming takes it up.
        // The assistance owner rejects active tasks/bootstrap before synchronization;
        // permanent retirement belongs to disposal after the save commits.
        await this.#managed.synchronize("running");
        await this.#control.request("snapshot", {});
        this.#suspended = true;
        moved = { saved: true };
      } catch (error) {
        const failure = error instanceof VMError ? error : new VMError("GUEST_CRASH", String(error));
        try {
          await this.snapshots.autoSave.configure({ enabled: true });
        } catch (cleanup) {
          throw withCleanupFailure(failure, cleanup);
        }
        throw failure;
      }
    }
    // The workspace is released only after the running VM was saved, or when nothing runs.
    await this.dispose().catch(() => undefined);
    return moved;
  }

  async suspend(options: { readonly label: string; readonly signal?: AbortSignal }): Promise<SnapshotInfo> {
    const label = validateRestorePointName(options.label);
    if (!this.#managed.active) {
      throw new VMError("INVALID_ARGUMENT", "only a VM running a managed image can be suspended", { reason: "not-running" });
    }
    const signal = AbortSignal.any([this.#disposing.signal, ...(options.signal === undefined ? [] : [options.signal])]);
    // Where the VM left off, as a hidden page's save is: it does not push a destructive action's
    // safety point out of the newest three.
    await this.network.disconnect();
    const saved = await this.#writeOutThenSave(() => this.snapshots.capture({ label, kind: "automatic", signal }));
    void this.dispose().catch(() => undefined);
    return saved;
  }

  /**
   * Writes the guest's files to the workspace store, then saves with `save`, before the VM stops
   * for another mode or tab. The save so records the store generation the guest matches, and a
   * resume carries in only what changed elsewhere since; disposal then does not write the files
   * again. Writing them out needs assisted processes retired, and keeps the page's running console.
   */
  async #writeOutThenSave<T>(save: () => Promise<T>): Promise<T> {
    await this.#assistance?.cancelBootstrap();
    await rejectingTimeout(this.#control.request("assistance-dispose", undefined), 60_000,
      new VMError("GUEST_CRASH", "Assisted task retirement timed out"));
    await this.#managed.synchronize("running");
    const saved = await save();
    this.#suspended = true;
    return saved;
  }

  /** Runs `sync` in the guest, so a reboot finds on disk what it last wrote. */
  async #syncGuestDisk(): Promise<void> {
    const child = await this.spawn({ command: "sync" });
    await rejectingTimeout(child.exit, 30_000, new VMError("GUEST_CRASH", "the guest did not write its files to disk"));
    const exit = await child.exit;
    if (exit.code !== 0) throw new VMError("GUEST_CRASH", "the guest filesystem flush failed", { exitCode: exit.code });
  }

  dispose(): Promise<void> {
    this.#disposing.abort();
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    let failure: unknown;
    try {
      try { await rejectingTimeout(this.#assistance?.cancelBootstrap() ?? Promise.resolve(), 60_000); }
      catch (error: unknown) { failure = error; }
      try { await rejectingTimeout(this.network.dispose()); } catch (error: unknown) { failure ??= error; }
      let assistanceStopped = false;
      try {
        await rejectingTimeout(this.#control.request("assistance-dispose", undefined), 60_000,
          new VMError("GUEST_CRASH", "Assisted task retirement timed out"));
        assistanceStopped = true;
      } catch (error) {
        failure ??= error;
        this.#control.terminate(error instanceof VMError ? error : new VMError("GUEST_CRASH", "Assisted task retirement failed"));
      }
      for (const operation of [
        // The control worker bounds the flush by capture progress; a large
        // workspace legitimately takes minutes through the guest console.
        ...(assistanceStopped && !this.#suspended && !this.#ephemeral ? [() => this.#managed.synchronize()] : []),
        () => rejectingTimeout(this.#stopActiveExecution(), 30_000,
          new VMError("GUEST_CRASH", "Active execution did not stop during disposal")),
        () => rejectingTimeout(this.#control.request("dispose", undefined)),
        () => rejectingTimeout(this.#storage.request("dispose", undefined)),
      ]) {
        try {
          await operation();
        } catch (error) {
          failure ??= error;
        }
      }
    } finally {
      const previews = [...this.#previews.values()]; this.#previews.clear();
      // Each close is bounded, so one silent preview cannot keep the workers alive.
      const closed = await Promise.allSettled(previews.map(preview => rejectingTimeout(preview.then(handle => handle.close(), () => undefined))));
      const failed = closed.find(result => result.status === "rejected");
      if (failed?.status === "rejected") failure ??= failed.reason as unknown;
      try { this.#assistance?.dispose(); }
      finally {
        this.#control.terminate();
        this.#storage.terminate();
        this.#network.terminate();
      }
    }
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) {
      const serialized = serializeUnknownError(failure);
      throw new VMError(
        serialized.code,
        serialized.message,
        serialized.detail,
      );
    }
  }

  async #stopActiveExecution(): Promise<void> {
    const execution = this.#activeExecution;
    await execution?.stop();
    if (this.#activeExecution === execution) this.#activeExecution = undefined;
  }

}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function copySystemBoot(
  memoryMiB: number,
  boot: SystemBootSpec,
): {
  readonly request: {
    readonly memoryMiB: number;
    readonly kernel: Uint8Array<ArrayBuffer>;
    readonly initrd?: Uint8Array<ArrayBuffer>;
    readonly disk?: Uint8Array<ArrayBuffer>;
    readonly commandLine: string;
  };
  readonly transfer: ArrayBuffer[];
} {
  const kernel = boot.kernel.slice();
  const initrd = boot.initrd?.slice();
  const disk = boot.disk?.slice();
  return {
    request: {
      memoryMiB,
      kernel,
      commandLine: boot.commandLine,
      ...(initrd === undefined ? {} : { initrd }),
      ...(disk === undefined ? {} : { disk }),
    },
    transfer: [
      kernel.buffer,
      ...(initrd === undefined ? [] : [initrd.buffer]),
      ...(disk === undefined ? [] : [disk.buffer]),
    ],
  };
}
