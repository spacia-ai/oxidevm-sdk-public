import { coreFailureError } from "./core-failure.js";
import { SystemConsole } from "./control/system-console.js";
import { isAssistanceControl } from "../protocol/assistance-control.js";
import { SystemAssistance } from "./control/assistance.js";
/// <reference lib="webworker" />
import { DiskBridgeClient } from "../disk-bridge.js";
import {
  CoreAbiError,
  decodeCpuSnapshot,
  decodeRunResult,
} from "../core-abi.js";
import { VMError, serializeUnknownError } from "../errors.js";
import {
  type ControlRequest,
  type CoreCpuState,
  type CoreProbeExit,
  type CoreProbeResult,
  decodeControlIncoming,
  decodeRequestId,
  MAX_SYSTEM_CONSOLE_INPUT_BYTES,
  PROTOCOL_VERSION,
  type SystemProbeResult,
  type SystemSliceResult,
  type WorkerResponse,
} from "../protocol.js";
import {
  CORE_API_VERSION,
  type Core,
  assertStatus,
  callNumber,
  loadCore,
  loadSystemAsset,
  memorySlice,
  prepareSharedCore,
  readRecord,
  stage,
  withCoreSteps,
} from "./control/core.js";
import { attachHostDisk, quiesceHostDisk } from "./control/disk.js";
import { loadDiagnosticLongMode } from "./control/diagnostic-core.js";
import { GuestAgent } from "./control/guest-agent.js";
import { SystemSessions } from "./control/system-session.js";
import { SystemAotRuntime } from "./control/aot-runtime.js";
import { JitRuntime } from "./control/jit-runtime.js";
import { browserJitCompilerHost, JitCompilerClient } from "./control/jit-compiler-client.js";
import { JitDeferredInstall } from "./control/jit-deferred-install.js";
import { jitEnginePolicy } from "./control/jit-engine-policy.js";
import { jitDegradationWarning, resetJitHealth } from "./control/jit-health.js";
import { DEFAULT_JIT_INSTALL_MODE } from "../protocol/system-trace-background-compile.js";
import { attachUserspaceExecution, closeUserspaceExecution, userspaceCheckpoints, requireUserspaceCheckpoints } from "./control/userspace.js";
import { ParallelExecution } from "./control/parallel-execution.js";
import { type AgentResumeState, encodeAgentResumeState } from "./control/agent-resume-state.js";
import { SnapshotSession } from "./control/snapshot-session.js";
import { AutoSave } from "./control/auto-save.js";
import { SnapshotEvents } from "./control/snapshot-events.js";
import { reconcileRestoredWorkspace } from "./control/workspace-reconcile.js";
import { configureSystemTrace } from "./control/trace-configuration.js";
import { readSystemAotTraining, readSystemTrace, resetRuntimeStats, runtimeStats } from "./control/trace.js";
import { serveDependencyInstallation } from "./control/dependency-installation-channel.js";
import { responseTransfer } from "./control/response-transfer.js";
import { SnapshotStorageClient } from "./snapshot-channel.js";
import { NetworkLink } from "./control/network-link.js";
import { SystemAttention } from "./control/system-attention.js";
import { decodeAttentionAttachment, isAttentionAttachment, type AttentionWatch } from "../host-attention.js";
const SYSTEM_PROFILE_X86_64_V3 = 2;
const LINUX_RNG_SEED_BYTES = 32;
const RUN_CHUNK_STEPS = 10_000;
const CONSOLE_CHUNK_BYTES = 64 * 1024;
const MAX_CONSOLE_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_CONSOLE_INPUT_BYTES = 1024 * 1024;
const SYSTEM_SLICE_MAX_MILLISECONDS = 20;
const SYSTEM_CLOCK_SYNC_MILLISECONDS = 4;
const SYSTEM_EXECUTION_CHECKPOINT_STEPS = 250_000;
const SYSTEM_DEADLINE_CHECK_STEPS = 16_384;
const AGENT_POLL_STEPS = 16_384;
/** How long a capture waits for the guest-agent stream to rest at a frame boundary. */
const SNAPSHOT_AGENT_QUIESCE_MILLISECONDS = 150;

let core: Core | undefined;
let parallelExecution: ParallelExecution | undefined;
let parallelFailure: VMError | undefined;
let diskBridge: DiskBridgeClient | undefined;
let snapshotStorage: SnapshotStorageClient | undefined;
let networkLink: NetworkLink | undefined;
const aotRuntime = new SystemAotRuntime();
const jitRuntime = new JitRuntime(
  { kind: "disabled" },
  aotRuntime,
  new JitDeferredInstall(
    DEFAULT_JIT_INSTALL_MODE,
    new JitCompilerClient(browserJitCompilerHost()),
    jitEnginePolicy().batch,
  ),
  (degradation) => {
    console.warn("oxidevm: Tier-1 JIT degraded", jitDegradationWarning("system", degradation));
  },
);
let lastRequestId = 0;
let responseQueue = Promise.resolve();
let systemBooted = false;
let humanConsole: "serial" | "virtio" | undefined;
let systemMemoryBytes = 0;
let configuredVcpus: 1 | 2 | 3 | 4 = 1;
let configuredMemoryMiB = 0;
let systemClockOriginMilliseconds: number | undefined;
let systemClockLastSyncMilliseconds: number | undefined;
let systemClockPausedAt: number | undefined;
let pendingConsoleInput = new Uint8Array();
const systemConsole = new SystemConsole();
const guestAgent = new GuestAgent(
  pumpAgentTransport,
  abortIfCanceled,
  () => diskBridge,
  systemConsoleTail,
  () => systemSessions.diagnostics(),
  error => systemSessions.fail(error),
);
/** Ends guest slices early for page and assistance messages and for guest-agent replies that complete them. */
const systemAttention = new SystemAttention();
const assistance = new SystemAssistance(guestAgent, { attention: { open: () => systemAttention.openBrokerAttention() } });
const systemSessions = new SystemSessions({
  run: deadline => runSystemInstructions(requireCore(), 0, 16_000_000, 0, undefined, deadline),
  readConsole: () => readSystemConsoleChunk(requireCore()),
  telemetry: () => runtimeStats(requireCore()),
  pause: pauseSystemClock,
  invalidate: () => jitRuntime.invalidate(),
  stopped: error => { guestAgent.executionStopped(error); assistance.executionStopped(error); },
  yield: idle => idle ? nextWorkerTurn() : nextTask(),
  recordYield: milliseconds => {
    const worker = requireCore().traceProfile.worker;
    worker.taskYields += 1;
    worker.taskYieldMilliseconds += milliseconds;
  },
});
const snapshotEvents = new SnapshotEvents();
/** The guest's retired instructions when the last save finished; a change means it ran since. */
let retiredAtLastSave: bigint | undefined;
const autoSave = new AutoSave({
  now: () => performance.now(),
  schedule: (delay, run) => {
    const timer = setTimeout(run, delay);
    return () => clearTimeout(timer);
  },
  dirty: () => systemBooted && core !== undefined && retiredInstructions(core) !== retiredAtLastSave,
  save: () => snapshotSession.capture({ kind: "automatic" }),
  collect: async () => {
    await requireSnapshotStorage().request({ type: "collect" });
  },
  emit: (event) => snapshotEvents.broadcast(event),
});
const snapshotSession = new SnapshotSession({
  core: requireCore,
  storage: requireSnapshotStorage,
  requireBooted: requireBootedSystem,
  memoryBytes: () => systemMemoryBytes,
  shape: () => ({ memoryMiB: configuredMemoryMiB, vcpus: configuredVcpus, profile: SYSTEM_PROFILE_X86_64_V3 }),
  freeze: async () => {
    await assistance.quiesce();
    await guestAgent.quiesce(SNAPSHOT_AGENT_QUIESCE_MILLISECONDS);
    return freezeForSnapshot();
  },
  // A running single-vCPU guest keeps running while a capture copies its RAM; the core refuses to
  // clear dirty bits while parallel vCPUs run.
  precopy: () => configuredVcpus === 1 && systemSessions.active?.paused === false,
  stop: stopForRestore,
  restarted: runRestoredSystem,
  agentState: () => encodeAgentResumeState(guestAgent.resumeState(systemConsole.tailBytes())),
  // Saves are not page requests a page can cancel, so the sync runs under no request id.
  syncFilesystems: () => guestAgent.syncFilesystems(0),
  notify: (event) => {
    snapshotEvents.broadcast(event);
    if (event.type !== "save-finished") return;
    retiredAtLastSave = core === undefined ? undefined : retiredInstructions(core);
    if (event.kind !== "automatic") autoSave.saved(performance.now(), event.durationMilliseconds, event.pauseMilliseconds);
  },
  now: () => performance.now(),
  lost: () => {
    systemBooted = false;
    resetSystemClock();
    guestAgent.reset();
    networkLink?.detach();
  },
});
const active = new Set<number>();
const canceled = new Set<number>();
let controlAttention: AttentionWatch | undefined;
const taskQueue: (() => void)[] = [];
const taskChannel = new MessageChannel();

taskChannel.port1.addEventListener("message", () => {
  taskQueue.shift()?.();
});
taskChannel.port1.start();

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  controlAttention?.delivered();
  receive(event.data, event.ports);
});
self.addEventListener("messageerror", () => { controlAttention?.delivered(); });

function receive(value: unknown, ports: readonly MessagePort[]): void {
  if (isAttentionAttachment(value)) {
    // The page client's first message; a second attachment or a malformed one is a protocol defect.
    if (controlAttention !== undefined) throw new VMError("PROTOCOL_ERROR", "Host attention is already attached");
    controlAttention = systemAttention.channels.watch("control", decodeAttentionAttachment(value));
    return;
  }
  let request: ReturnType<typeof decodeControlIncoming>;
  try {
    request = decodeControlIncoming(value);
  } catch (error) {
    for (const port of ports) port.close();
    const id = decodeRequestId(value);
    if (id !== undefined) postFailure(id, error);
    return;
  }
  if (request.type === "cancel") {
    for (const port of ports) port.close();
    if (active.has(request.requestId)) {
      canceled.add(request.requestId);
      guestAgent.cancel(request.requestId);
      userspaceCheckpoints()?.cancel(request.requestId);
    }
    // A successful spawn reply may still be in transit when the SDK aborts.
    assistance.cancel(request.requestId);
    return;
  }
  if (request.id <= lastRequestId) {
    for (const port of ports) port.close();
    postFailure(
      request.id,
      new VMError("PROTOCOL_ERROR", `duplicate request id ${request.id}`),
    );
    return;
  }
  lastRequestId = request.id;
  const ownedPorts = Object.values(request).filter(value => value instanceof MessagePort);
  for (const port of ports) if (!ownedPorts.includes(port)) port.close();
  active.add(request.id);
  if (isAssistanceControl(request.type) || isDiagnosticRead(request.type)) void respond(request);
  else responseQueue = responseQueue.then(() => respond(request));
}

/** A read that observes the worker must not wait behind the serialized queue,
 * or a stalled operation cannot be sampled while it stalls. */
function isDiagnosticRead(type: ControlRequest["type"]): boolean {
  return type === "read-system-trace";
}

async function respond(request: ControlRequest): Promise<void> {
  let response: WorkerResponse;
  try {
    abortIfCanceled(request.id);
    response = {
      id: request.id,
      version: PROTOCOL_VERSION,
      ok: true,
      value: await handle(request),
    };
  } catch (error) {
    for (const value of Object.values(request)) if (value instanceof MessagePort) value.close();
    const reportedError =
      error instanceof CoreAbiError
        ? new VMError(error.code, error.message)
        : error;
    response = {
      id: request.id,
      version: PROTOCOL_VERSION,
      ok: false,
      error: serializeUnknownError(reportedError),
    };
  }
  active.delete(request.id);
  canceled.delete(request.id);
  self.postMessage(response, { transfer: responseTransfer(request, response) });
  if (request.type === "dispose") self.close();
}

async function handle(request: ControlRequest): Promise<unknown> {
  if (request.type === "network-link-connect") {
    networkLink?.close();
    networkLink = await NetworkLink.connect(request.bridge, request.doorbell);
    networkLink.attachExisting(requireCore());
    return undefined;
  }
  if (request.type === "network-link-failed") {
    networkLink?.failed("worker");
    return undefined;
  }
  if (request.type === "agent-write-file" || request.type === "agent-remove" || request.type === "agent-spawn") assistance.assertWorkspaceWritable();
  if (request.type !== "dispose" && request.type !== "assistance-dispose" && request.type !== "read-system-trace" && request.type !== "assistance-installation-profile") guestAgent.assertWorkspaceHealthy();
  if (request.type !== "dispose" && request.type !== "assistance-dispose" && request.type !== "assistance-stop"
    && request.type !== "assistance-attach" && request.type !== "assistance-bootstrap-release" && request.type !== "assistance-spawn" && request.type !== "assistance-install" && request.type !== "read-system-trace" && request.type !== "assistance-installation-profile") assistance.assertHealthy();
  if (request.type === "initialize" || request.type === "attach-userspace" || request.type === "run-core-probe"
    || request.type === "run-system-probe" || request.type === "boot-system" || request.type === "quiesce-disk"
    || request.type === "pause-system" || request.type === "stop-system" || request.type === "snapshot"
    || request.type === "restore" || request.type === "agent-restore-workspace" || request.type === "agent-apply-workspace" || request.type === "agent-apply-workspace-delta") {
    assistance.assertIdle();
  }
  switch (request.type) {
    case "assistance-status": return assistance.prepare();
    case "assistance-prepare": return assistance.prepareBound();
    case "assistance-bootstrap-release":
      assistance.releaseBootstrap(request);
      return undefined;
    case "assistance-attach":
      assistance.attach(request);
      return undefined;
    case "assistance-network-attach":
      assistance.attachNetwork(request.port);
      return undefined;
    case "assistance-network-failed":
      assistance.networkFailed();
      return undefined;
    case "assistance-build-policy": return assistance.commitBuildPolicy(request.id, requireSnapshotStorage(), request);
    case "assistance-install": {
      let close: (() => void) | undefined;
      try {
        const preparing = assistance.prepareDependencies(request.id,
          { origin: "https://registry.npmjs.org", maximumBytes: 512 * 1024 * 1024 },
          { storage: requireSnapshotStorage(), workspaceBaseSha256: request.workspaceBaseSha256, agent: guestAgent },
          { cwd: request.cwd === "/" ? "/workspace" : `/workspace${request.cwd}`, frozenLockfile: request.frozenLockfile });
        close = serveDependencyInstallation(request.port, preparing, () => assistance.cancel(request.id));
        await preparing;
        return undefined;
      } catch (error) { close?.(); request.port.close(); throw error; }
    }
    case "assistance-spawn": return assistance.spawn(request.id, request, request.workspaceBaseSha256 === undefined ? undefined : requireSnapshotStorage());
    case "assistance-input": return assistance.input(request.process, request.bytes);
    case "assistance-stop": return assistance.stop(request.process, request.signal);
    case "assistance-dispose": return assistance.dispose();
    case "assistance-installation-profile": return assistance.installationProfile();
    case "attach-userspace":
      await assistance.replaceGeneration();
      await systemSessions.stop();
      autoSave.configure({ enabled: false });
      attachUserspaceExecution(request.port, request.snapshotPort, event => snapshotEvents.broadcast(event));
      return undefined;
    case "start-userspace-cold":
      return requireUserspaceCheckpoints().request(request.id, "cold-start", {sourceId:request.sourceId});
    case "prepare-image":
      return requireUserspaceCheckpoints().request(request.id, "prepare-image", { reason: request.reason ?? "repair" });
    case "configure-userspace-checkpoints":
      return requireUserspaceCheckpoints().request(request.id, "configure", { mount: request.mount, destination: request.destination });
    case "restore-userspace-checkpoint":
      return requireUserspaceCheckpoints().request(request.id, "restore", { snapshot: request.snapshot,
        ...(request.startup===undefined?{}:{startup:request.startup}),
        ...(request.initialStart===undefined?{}:{initialStart:request.initialStart}),
        ...(request.replacedId === undefined ? {} : { replacedId: request.replacedId }) });
    case "flush-userspace":
      return requireUserspaceCheckpoints().request(request.id, "flush", undefined);
    case "initialize": {
      await assistance.replaceGeneration();
      closeUserspaceExecution();
      await systemSessions.stop();
      await stopParallelExecution();
      await quiesceHostDisk(core, diskBridge, systemBooted);
      await disposeParallelExecution();
      jitRuntime.invalidate();
      jitRuntime.configureInstall(request.jitInstall ?? DEFAULT_JIT_INSTALL_MODE);
      const nextDiskBridge =
        request.diskBridge === undefined || request.diskPort === undefined
          ? undefined
          : new DiskBridgeClient(
              request.diskBridge,
              request.diskPort,
              () => requireCore().memory,
            );
      const nextSnapshotStorage = new SnapshotStorageClient(request.snapshotPort);
      nextDiskBridge?.configureProfiling(true);
      let loaded: Core;
      let nextParallel: ParallelExecution | undefined;
      const parallelVcpus =
        request.vcpus === 2 || request.vcpus === 3 || request.vcpus === 4
          ? request.vcpus
          : undefined;
      try {
        if (
          parallelVcpus !== undefined &&
          typeof SharedArrayBuffer === "function" &&
          globalThis.crossOriginIsolated
        ) {
          const prepared = await prepareSharedCore(
            request.sharedCoreWasmUrl,
            nextDiskBridge?.imports,
          );
          nextParallel = await ParallelExecution.create(
            prepared.module,
            prepared.memory,
            parallelVcpus,
            failParallelExecution,
          );
          loaded = prepared.initialize();
        } else {
          loaded = await loadCore(
            request.coreWasmUrl,
            nextDiskBridge?.imports,
          );
        }
        jitRuntime.initialize();
        aotRuntime.initialize();
      } catch (error) {
        nextParallel?.dispose();
        nextDiskBridge?.close();
        nextSnapshotStorage.close();
        throw error;
      }
      diskBridge?.close();
      snapshotStorage?.close();
      diskBridge = nextDiskBridge;
      snapshotStorage = nextSnapshotStorage;
      core = loaded;
      parallelExecution = nextParallel;
      parallelFailure = undefined;
      configuredVcpus = request.vcpus;
      configuredMemoryMiB = request.memoryMiB;
      systemBooted = false;
      systemMemoryBytes = 0;
      snapshotSession.reset();
      autoSave.configure({ enabled: false });
      resetSystemClock();
      pendingConsoleInput = new Uint8Array();
      systemConsole.reset();
      guestAgent.reset();
      networkLink?.detach();
      return {
        execution:
          nextParallel === undefined ? "serialized" : "parallel-shared-memory",
        vcpus: request.vcpus,
        sharedMemory: nextParallel !== undefined,
      };
    }
    case "run-core-probe":
      await assistance.quiesce();
      await systemSessions.stop();
      await stopParallelExecution();
      await quiesceHostDisk(core, diskBridge, systemBooted);
      systemBooted = false;
      resetSystemClock();
      jitRuntime.invalidate();
      pendingConsoleInput = new Uint8Array();
      systemConsole.reset();
      guestAgent.reset();
      networkLink?.detach();
      return runProbe(request.id, request.program, request.maximumSteps);
    case "configure-system-aot":
      if (systemSessions.active !== undefined) {
        throw new VMError("INVALID_ARGUMENT", "system AOT must be configured before boot");
      }
      jitRuntime.clearCatalogBindings(requireCore());
      aotRuntime.configure(requireCore(), request.configuration);
      return undefined;
    case "run-system-probe":
      await assistance.replaceGeneration();
      await systemSessions.stop();
      return runSystemProbe(request);
    case "boot-system":
      await assistance.replaceGeneration();
      await systemSessions.stop();
      await bootSystem(request);
      return undefined;
    case "quiesce-disk":
      // A managed boot replaces the disk next. Automatic saves stop (the page turns them on after
      // its next start), a save or restore under way ends first, and the machine counts as not
      // booted until the next one is, so no save pairs this machine's RAM with the next disk.
      autoSave.configure({ enabled: false });
      return snapshotSession.exclusively(async () => {
        await assistance.quiesce();
        await systemSessions.stop();
        await stopParallelExecution();
        await quiesceHostDisk(core, diskBridge, systemBooted);
        await diskBridge?.reset();
        systemBooted = false;
        return undefined;
      });
    case "run-system-slice":
      if (systemSessions.active !== undefined) {
        throw new VMError(
          "INVALID_ARGUMENT",
          "bounded system slices are unavailable during continuous execution",
        );
      }
      return runSystemSlice(request);
    case "start-system":
      startSystemSession(request);
      return undefined;
    case "pause-system":
      await assistance.quiesce();
      await systemSessions.control(request.sessionId, "pause");
      return undefined;
    case "resume-system":
      await systemSessions.control(request.sessionId, "resume");
      return undefined;
    case "stop-system":
      await assistance.quiesce();
      await systemSessions.stop(request.sessionId);
      return undefined;
    case "write-system-console":
      writeSystemConsole(request.data);
      return undefined;
    case "resize-system-console":
      systemConsole.resize(requireCore(), request);
      return undefined;
    case "configure-system-trace":
      configureSystemTrace(
        requireCore(),
        diskBridge,
        request.capacity,
        request.interpreterOnly,
        request.interpretedSemantics,
        request.interpretedRipRanges,
        request.checkpointPolicy,
      );
      return undefined;
    case "read-system-trace":
      return readSystemTrace(requireCore(), diskBridge, systemConsoleTail(), aotRuntime.status(), systemSessions.diagnostics(),
        networkLink?.diagnostics(requireCore()) ?? NetworkLink.absent(requireCore()));
    case "read-system-aot-training":
      return readSystemAotTraining(requireCore());
    case "snapshot":
      if (userspaceCheckpoints() !== undefined) return (await requireUserspaceCheckpoints().capture(request.id, {
        kind: request.kind ?? (request.label === undefined ? "automatic" : "named"),
        ...(request.label === undefined ? {} : { label: request.label }),
      })).snapshot;
      return (await snapshotSession.capture({
        kind: request.kind ?? (request.label === undefined ? "automatic" : "named"),
        ...(request.label === undefined ? {} : { label: request.label }),
      })).snapshot;
    case "snapshot-events":
      snapshotEvents.listen(request.port);
      return undefined;
    case "auto-save-configure":
      if (userspaceCheckpoints() !== undefined) { requireUserspaceCheckpoints().configureAutoSave(request.enabled); return undefined; }
      autoSave.configure({ enabled: request.enabled });
      return undefined;
    case "auto-save-hint":
      if (userspaceCheckpoints() !== undefined) { requireUserspaceCheckpoints().hint(request.hint); return undefined; }
      autoSave.hint(request.hint);
      return undefined;
    case "snapshot-app-data":
      if (userspaceCheckpoints() !== undefined) return requireUserspaceCheckpoints().request(request.id, "app-data", { data: request.data });
      snapshotSession.setAppData(request.data);
      return undefined;
    case "restore":
      if (userspaceCheckpoints() !== undefined) return requireUserspaceCheckpoints().request(request.id, "restore", { snapshot: request.snapshot });
      await assistance.replaceGeneration();
      return snapshotSession.restore(request.snapshot, () => abortIfCanceled(request.id),request.initialStart);
    case "wait-agent":
      return guestAgent.wait(request.id, request.timeoutMilliseconds);
    case "agent-refresh-guest":
      await guestAgent.refreshGuest(request.id);
      return undefined;
    case "agent-reconcile-workspace":
      return reconcileRestoredWorkspace(requireSnapshotStorage(), guestAgent.reconcileAgent(request.id), request.snapshot);
    case "agent-files":
      return guestAgent.files.execute(request.id, request.request);
    case "agent-files-watch":
      guestAgent.files.watch(request.port); return undefined;
    case "agent-files-set":
      await guestAgent.files.setDirectories(request.directories); return undefined;
    case "agent-files-unwatch":
      guestAgent.files.unwatch(); return undefined;
    case "agent-read-file":
      return guestAgent.readFile(request.id, request.path);
    case "agent-write-file":
      await guestAgent.writeFile(request.id, request.path, request.data);
      return undefined;
    case "agent-list":
      return guestAgent.list(request.id, request.path);
    case "agent-workspace-manifest":
      return guestAgent.workspaceManifest(request.id);
    case "agent-workspace-delta": {
      const delta = await guestAgent.workspaceDelta(request.id);
      await guestAgent.syncFilesystems(request.id);
      return delta;
    }
    case "agent-apply-workspace":
      await guestAgent.applyWorkspace(request.id, request.data);
      return undefined;
    case "agent-apply-workspace-delta":
      await guestAgent.applyWorkspaceDelta(request.id, request.data);
      return undefined;
    case "agent-restore-workspace":
      return assistance.restoreWorkspace(request.id, request.workspaceBaseSha256, requireSnapshotStorage(), guestAgent);
    case "agent-sync-workspace":
      // The flush streams the whole workspace through the guest agent and storage, which a save
      // would pause and compete for: automatic saves stop (the page turns them on after its next
      // start), and a save under way ends first.
      autoSave.configure({ enabled: false });
      return snapshotSession.exclusively(() =>
        assistance.synchronizeWorkspace(request.id, request.workspaceBaseSha256, requireSnapshotStorage(), guestAgent));
    case "agent-remove":
      await guestAgent.remove(
        request.id,
        request.path,
        request.recursive,
      );
      return undefined;
    case "agent-spawn":
      return guestAgent.spawn(request);
    case "agent-attach-process":
      return guestAgent.attach(request.agentRequestId, request.port);
    case "agent-stdin":
      return guestAgent.stdin(request.id, request.pid, request.data);
    case "agent-close-stdin":
      await guestAgent.closeStdin(request.id, request.pid);
      return undefined;
    case "agent-signal":
      await guestAgent.signal(request.id, request.pid, request.signal);
      return undefined;
    case "agent-process-control":
      await guestAgent.processControl(request.id, request.pid, request.sessionId, request.control);
      return undefined;
    case "agent-listeners-watch":
      guestAgent.listenerWatch.watch(request.port);
      return undefined;
    case "agent-listeners-unwatch":
      guestAgent.listenerWatch.unwatch();
      return undefined;
    case "agent-listeners-list":
      return guestAgent.listenerWatch.list();
    case "dispose":
      await assistance.dispose();
      closeUserspaceExecution();
      await systemSessions.stop();
      await stopParallelExecution();
      await quiesceHostDisk(core, diskBridge, systemBooted);
      await disposeParallelExecution();
      await jitRuntime.dispose();
      aotRuntime.dispose();
      diskBridge?.close();
      snapshotStorage?.close();
      networkLink?.close();
      diskBridge = undefined;
      snapshotStorage = undefined;
      networkLink = undefined;
      core = undefined;
      systemBooted = false;
      systemMemoryBytes = 0;
      snapshotSession.reset();
      autoSave.configure({ enabled: false });
      snapshotEvents.close();
      resetSystemClock();
      pendingConsoleInput = new Uint8Array();
      systemConsole.reset();
      guestAgent.reset();
      return undefined;
  }
}

async function runSystemProbe(
  request: Extract<ControlRequest, { type: "run-system-probe" }>,
): Promise<SystemProbeResult> {
  const loaded = requireCore();
  await bootSystem(request);

  const consoleChunks: Uint8Array<ArrayBuffer>[] = [];
  let consoleBytes = 0;
  const exit = await runSystemInstructions(
    loaded,
    request.id,
    request.maximumSteps,
    RUN_CHUNK_STEPS,
    () => {
      consoleBytes = drainSystemConsole(
        loaded,
        consoleChunks,
        consoleBytes,
      );
    },
  );
  consoleBytes = drainSystemConsole(loaded, consoleChunks, consoleBytes);
  return {
    apiVersion: CORE_API_VERSION,
    exit,
    state: decodeCpuSnapshot(readRecord(loaded, "cpu-state")).state,
    console: concatenate(consoleChunks, consoleBytes),
  };
}

async function bootSystem(
  request: Extract<
    ControlRequest,
    { type: "boot-system" | "run-system-probe" }
  >,
): Promise<void> {
  const loaded = requireCore();
  await stopParallelExecution();
  await quiesceHostDisk(core, diskBridge, systemBooted);
  jitRuntime.invalidate();
  systemBooted = false;
  resetSystemClock();
  humanConsole = request.type === "boot-system" ? request.console : undefined;
  pendingConsoleInput = new Uint8Array();
  systemConsole.reset();
  guestAgent.reset();
  jitRuntime.clearCatalogBindings(loaded);
  systemMemoryBytes = request.memoryMiB * 1024 * 1024;
  resetJitHealth(loaded.jitHealth);
  resetRuntimeStats(loaded);
  aotRuntime.prepareBoot(loaded);
  await snapshotSession.rememberBoot(request);
  assertStatus(
    callNumber(loaded, "oxidevm_system_create", [
      request.memoryMiB,
      configuredVcpus,
      SYSTEM_PROFILE_X86_64_V3,
    ]),
  );
  if (request.type === "boot-system") {
    const unixSeconds = Math.floor(Date.now() / 1_000);
    assertStatus(
      callNumber(loaded, "oxidevm_system_seed_rtc", [
        unixSeconds >>> 0,
        Math.floor(unixSeconds / 0x1_0000_0000),
      ]),
    );
  }
  networkLink?.machineReplaced(loaded);
  loadSystemAsset(loaded, 0, request.kernel);
  if (request.initrd !== undefined) loadSystemAsset(loaded, 1, request.initrd);
  if (request.disk !== undefined) loadSystemAsset(loaded, 2, request.disk);
  attachHostDisk(loaded, diskBridge, request.hostDiskBytes);
  loadSystemAsset(loaded, 3, new TextEncoder().encode(request.commandLine));
  loadSystemAsset(
    loaded,
    4,
    crypto.getRandomValues(new Uint8Array(LINUX_RNG_SEED_BYTES)),
  );
  assertStatus(callNumber(loaded, "oxidevm_system_boot"));
  parallelExecution?.start(loaded);
  systemBooted = true;
  if (request.type === "boot-system") {
    systemClockOriginMilliseconds = performance.now();
  }
  guestAgent.activate(loaded);
}

/** Stops execution and quiesces disks before a restore replaces the machine. */
async function stopForRestore(): Promise<void> {
  await systemSessions.stop();
  await stopParallelExecution();
  await quiesceHostDisk(core, diskBridge, systemBooted);
  await diskBridge?.reset();
  systemBooted = false;
}

/**
 * Runs a restored machine with fresh JIT and console state, continuing the guest-agent session
 * recorded with the snapshot (a fresh one without it).
 */
function runRestoredSystem(memoryBytes: number, agent: AgentResumeState | undefined): void {
  const loaded = requireCore();
  networkLink?.machineReplaced(loaded);
  jitRuntime.invalidate();
  resetJitHealth(loaded.jitHealth);
  resetRuntimeStats(loaded);
  pendingConsoleInput = new Uint8Array();
  systemConsole.reset();
  if (agent === undefined) guestAgent.reset();
  else systemConsole.record(agent.consoleTail);
  parallelExecution?.start(loaded);
  systemBooted = true;
  systemMemoryBytes = memoryBytes;
  const clockMode = callNumber(loaded, "oxidevm_system_clock_mode");
  if (clockMode === 1) {
    systemClockOriginMilliseconds = performance.now();
    systemClockLastSyncMilliseconds = undefined;
    systemClockPausedAt = undefined;
  } else if (clockMode === 0) {
    resetSystemClock();
  } else {
    throw new VMError("VM_FAULT", "restored clock mode is invalid");
  }
  if (agent === undefined) guestAgent.activate(loaded);
  else guestAgent.resume(loaded, agent);
}

async function freezeForSnapshot(): Promise<() => unknown> {
  const session = systemSessions.active;
  if (session !== undefined) {
    if (!session.paused) {
      await systemSessions.control(session.id, "pause");
      await quiesceHostDisk(core, diskBridge, systemBooted);
      return () => systemSessions.control(session.id, "resume");
    }
    await quiesceHostDisk(core, diskBridge, systemBooted);
    return () => undefined;
  }
  await parallelExecution?.barrier();
  await quiesceHostDisk(core, diskBridge, systemBooted);
  const loaded = requireCore();
  synchronizeSystemClock(loaded, true);
  const pausedAt = performance.now();
  return () => {
    if (systemClockOriginMilliseconds !== undefined) {
      systemClockOriginMilliseconds += performance.now() - pausedAt;
      systemClockLastSyncMilliseconds = undefined;
    }
  };
}

/** Every instruction the guest retired, translated or interpreted. */
function retiredInstructions(loaded: Core): bigint {
  return loaded.runtimeStats.jitInstructions + loaded.runtimeStats.interpretedInstructions;
}

function requireSnapshotStorage(): SnapshotStorageClient {
  if (snapshotStorage === undefined) {
    throw new VMError("PROTOCOL_ERROR", "snapshot storage is unavailable");
  }
  return snapshotStorage;
}

async function runSystemSlice(
  request: Extract<ControlRequest, { type: "run-system-slice" }>,
): Promise<SystemSliceResult> {
  requireBootedSystem();
  const loaded = requireCore();
  const exit = await runSystemInstructions(
    loaded,
    request.id,
    request.maximumSteps,
    0,
    undefined,
    performance.now() + SYSTEM_SLICE_MAX_MILLISECONDS,
  );
  const consoleChunks: Uint8Array<ArrayBuffer>[] = [];
  const consoleBytes = drainSystemConsole(loaded, consoleChunks, 0);
  const cpus = readSystemCpuStates(loaded);
  const state = cpus[0];
  if (state === undefined) {
    throw new VMError("VM_FAULT", "core returned no vCPU state");
  }
  return {
    apiVersion: CORE_API_VERSION,
    exit,
    state,
    cpus,
    console: concatenate(consoleChunks, consoleBytes),
    runtime: runtimeStats(loaded),
  };
}

function readSystemCpuStates(loaded: Core): CoreCpuState[] {
  const count = callNumber(loaded, "oxidevm_system_cpu_count");
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    throw new VMError("PROTOCOL_ERROR", "core reported an invalid vCPU count");
  }
  return Array.from({ length: count }, (_, index) => {
    assertStatus(callNumber(loaded, "oxidevm_system_select_cpu", [index]));
    return decodeCpuSnapshot(readRecord(loaded, "cpu-state")).state;
  });
}

function startSystemSession(request: Extract<ControlRequest, { type: "start-system" }>): void {
  requireBootedSystem();
  systemSessions.start(request.sessionId, request.port, systemConsole.takeBoot());
}

async function pauseSystemClock(paused: boolean): Promise<void> {
  if (paused) {
    await parallelExecution?.barrier();
    synchronizeSystemClock(requireCore(), true);
    systemClockPausedAt = performance.now();
  } else if (systemClockOriginMilliseconds !== undefined && systemClockPausedAt !== undefined) {
    systemClockOriginMilliseconds += performance.now() - systemClockPausedAt;
    systemClockPausedAt = undefined;
  }
}

async function runSystemInstructions(
  loaded: Core,
  requestId: number,
  maximumSteps: number,
  yieldEvery = 0,
  onYield?: () => void,
  deadline = Number.POSITIVE_INFINITY,
): Promise<CoreProbeExit> {
  const startedAt = performance.now();
  // Slices with a deadline end early for host attention (`control/system-attention.ts`).
  const attended = Number.isFinite(deadline);
  if (attended) systemAttention.begin(startedAt, guestAgent.responses);
  let runnable = false;
  try {
    let completed = 0n;
    let remaining = maximumSteps;
    let sinceYield = 0;
    let sinceDeadlineCheck = 0;
    let sinceAgentPoll = 0;
    flushSystemConsoleInput(loaded);
    guestAgent.flushInput(loaded);
    while (remaining > 0) {
      if (requestId !== 0) abortIfCanceled(requestId);
      synchronizeSystemClock(loaded);
      let budget =
        yieldEvery === 0
          ? remaining
          : Math.min(remaining, yieldEvery - sinceYield);
      if (Number.isFinite(deadline)) {
        budget = Math.min(budget, SYSTEM_EXECUTION_CHECKPOINT_STEPS);
      }
      networkLink?.beforeStep(loaded);
      const exit =
        parallelExecution?.started === true
          ? await runParallelInstructions(loaded, requestId, budget)
          : runSingleWorkerInstructions(
              loaded,
              requestId,
              budget,
            );
      networkLink?.afterStep(loaded);
      if (exit.steps > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new VMError("VM_FAULT", "system result is too large");
      }
      const steps = Number(exit.steps);
      if (steps > budget) {
        throw new VMError(
          "VM_FAULT",
          "system retired beyond its execution budget",
        );
      }
      completed += exit.steps;
      remaining -= steps;
      sinceYield += steps;
      sinceDeadlineCheck += steps;
      sinceAgentPoll += steps;
      if (
        guestAgent.hasPendingInput ||
        steps === 0 || // An idle guest may have completed I/O before halting.
        sinceAgentPoll >= AGENT_POLL_STEPS ||
        exit.kind !== "step-limit"
      ) {
        guestAgent.flushInput(loaded);
        guestAgent.drainOutput(loaded);
        sinceAgentPoll = 0;
      }
      if (exit.kind !== "step-limit") {
        return withCoreSteps(exit, completed);
      }
      if (steps === 0) {
        return { kind: "step-limit", steps: completed };
      }
      if (sinceDeadlineCheck >= SYSTEM_DEADLINE_CHECK_STEPS) {
        sinceDeadlineCheck = 0;
        const now = performance.now();
        if (
          now >= deadline
          || attended && jitRuntime.yieldForCompiledModule(loaded, now - startedAt)
          || attended && systemAttention.endsSlice(loaded.traceProfile.worker.hostAttention, now - startedAt, guestAgent.responses)
        ) {
          runnable = true;
          return { kind: "step-limit", steps: completed };
        }
      }
      if (yieldEvery !== 0 && sinceYield === yieldEvery) {
        onYield?.();
        sinceYield = 0;
        await nextTask();
      }
    }
    runnable = true;
    return { kind: "step-limit", steps: completed };
  } finally {
    if (attended) systemAttention.end(performance.now(), runnable);
    loaded.traceProfile.worker.executionLoopCalls += 1;
    loaded.traceProfile.worker.executionLoopMilliseconds +=
      performance.now() - startedAt;
  }
}

function runSingleWorkerInstructions(
  loaded: Core,
  requestId: number,
  budget: number,
): CoreProbeExit {
  const jit =
    configuredVcpus === 1
      ? jitRuntime.runBlock(
          loaded,
          requestId,
          budget,
          systemBooted,
          abortIfCanceled,
        )
      : jitRuntime.runInterpreter(
          loaded,
          Math.min(budget, RUN_CHUNK_STEPS),
          "degraded",
        );
  return jit ?? jitRuntime.runGuardFallback(loaded, budget);
}

async function runParallelInstructions(
  loaded: Core,
  requestId: number,
  budget: number,
): Promise<CoreProbeExit> {
  if (parallelFailure !== undefined) throw parallelFailure;
  const parallel = parallelExecution;
  if (parallel === undefined || !parallel.started) {
    throw new VMError("VM_FAULT", "parallel execution is not active");
  }
  const totalBudget = Math.min(
    budget,
    RUN_CHUNK_STEPS * configuredVcpus,
  );
  const quotient = Math.floor(totalBudget / configuredVcpus);
  const remainder = totalBudget % configuredVcpus;
  const budgets = Array.from(
    { length: configuredVcpus },
    (_, index) => quotient + (index < remainder ? 1 : 0),
  );
  const bspBudget = budgets[0];
  if (bspBudget === undefined) {
    throw new VMError("VM_FAULT", "parallel BSP budget is unavailable");
  }
  const apPromise = parallel.run(budgets.slice(1));
  let bsp: CoreProbeExit;
  try {
    if (bspBudget === 0) {
      bsp = { kind: "step-limit", steps: 0n };
    } else {
      const jit = jitRuntime.runBlock(
        loaded,
        requestId,
        bspBudget,
        systemBooted,
        abortIfCanceled,
      );
      bsp = jit ?? jitRuntime.runGuardFallback(loaded, bspBudget);
    }
  } catch (error) {
    parallel.cancel();
    await apPromise.catch(() => undefined);
    throw error;
  }
  const aps = await apPromise;
  assertStatus(callNumber(loaded, "oxidevm_system_service_devices"));
  loaded.runtimeStats.jitInstructions += aps.reduce(
    (total, result) =>
      total +
      (result.tier === "jit"
        ? result.exit.steps - result.residentInterpreted
        : 0n),
    0n,
  );
  loaded.runtimeStats.interpretedInstructions += aps.reduce(
    (total, result) =>
      total +
      (result.tier === "interpreter"
        ? result.exit.steps
        : result.residentInterpreted),
    0n,
  );
  const exits = [bsp, ...aps.map((result) => result.exit)];
  const steps = exits.reduce((total, exit) => total + exit.steps, 0n);
  const terminal = exits.find((exit) => exit.kind !== "step-limit");
  return terminal === undefined
    ? { kind: "step-limit", steps }
    : withCoreSteps(terminal, steps);
}

function synchronizeSystemClock(loaded: Core, force = false): void {
  if (systemClockOriginMilliseconds === undefined) return;
  const now = performance.now();
  if (
    !force &&
    systemClockLastSyncMilliseconds !== undefined &&
    now - systemClockLastSyncMilliseconds < SYSTEM_CLOCK_SYNC_MILLISECONDS
  ) {
    return;
  }
  systemClockLastSyncMilliseconds = now;
  const microseconds = Math.floor(
    Math.max(0, now - systemClockOriginMilliseconds) * 1_000,
  );
  assertStatus(
    callNumber(loaded, "oxidevm_system_sync_clock", [
      microseconds >>> 0,
      Math.floor(microseconds / 0x1_0000_0000),
    ]),
  );
}

function resetSystemClock(): void {
  systemClockOriginMilliseconds = undefined;
  systemClockLastSyncMilliseconds = undefined;
  systemClockPausedAt = undefined;
}

function writeSystemConsole(data: Uint8Array): void {
  requireBootedSystem();
  if (
    pendingConsoleInput.byteLength + data.byteLength >
    MAX_PENDING_CONSOLE_INPUT_BYTES
  ) {
    throw new VMError(
      "QUOTA_EXCEEDED",
      `pending console input exceeds ${MAX_PENDING_CONSOLE_INPUT_BYTES / 1024} KiB`,
    );
  }
  const combined = new Uint8Array(
    pendingConsoleInput.byteLength + data.byteLength,
  );
  combined.set(pendingConsoleInput);
  combined.set(data, pendingConsoleInput.byteLength);
  pendingConsoleInput = combined;
  flushSystemConsoleInput(requireCore());
}

function flushSystemConsoleInput(loaded: Core): void {
  while (pendingConsoleInput.byteLength !== 0) {
    const chunk = pendingConsoleInput.subarray(
      0,
      MAX_SYSTEM_CONSOLE_INPUT_BYTES,
    );
    stage(loaded, chunk);
    const accepted = humanConsole === undefined
      ? callNumber(loaded, "oxidevm_system_console_input", [chunk.byteLength])
      : callNumber(loaded, "oxidevm_system_console_input_selected", [chunk.byteLength, humanConsole === "serial" ? 0 : 1]);
    if (accepted < 0 || accepted > chunk.byteLength) {
      throw new VMError(
        "VM_FAULT",
        "system console accepted an invalid byte count",
      );
    }
    if (accepted === 0) return;
    pendingConsoleInput = pendingConsoleInput.slice(accepted);
  }
}

async function pumpAgentTransport(
  workerRequestId: number,
  deadline: number,
): Promise<CoreProbeExit | undefined> {
  const loaded = requireCore();
  guestAgent.flushInput(loaded);
  guestAgent.drainOutput(loaded);
  captureBootConsole(loaded);
  if (systemSessions.active !== undefined) {
    const waitStartedAt = performance.now();
    await nextWorkerTurn();
    loaded.traceProfile.worker.agentTurnWaits += 1;
    loaded.traceProfile.worker.agentTurnWaitMilliseconds +=
      performance.now() - waitStartedAt;
    return undefined;
  }
  const exit = await runSystemInstructions(
    loaded,
    workerRequestId,
    16_000_000,
    0,
    undefined,
    Math.min(deadline, performance.now() + SYSTEM_SLICE_MAX_MILLISECONDS),
  );
  const waitStartedAt = performance.now();
  await (exit.steps === 0n ? nextWorkerTurn() : nextTask());
  loaded.traceProfile.worker.agentTurnWaits += 1;
  loaded.traceProfile.worker.agentTurnWaitMilliseconds +=
    performance.now() - waitStartedAt;
  guestAgent.drainOutput(loaded);
  captureBootConsole(loaded);
  return exit;
}

function nextWorkerTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function drainSystemConsole(
  loaded: Core,
  chunks: Uint8Array<ArrayBuffer>[],
  total: number,
): number {
  let length = readHumanConsole(loaded);
  while (length !== 0) {
    if (length > CONSOLE_CHUNK_BYTES || total + length > MAX_CONSOLE_BYTES) {
      throw new VMError(
        "QUOTA_EXCEEDED",
        `system console output exceeds ${MAX_CONSOLE_BYTES / 1024 / 1024} MiB`,
      );
    }
    const pointer = callNumber(loaded, "oxidevm_staging_ptr");
    const bytes = memorySlice(loaded.memory, pointer, length).slice();
    systemConsole.record(bytes);
    chunks.push(bytes);
    total += length;
    length = readHumanConsole(loaded);
  }
  return total;
}

function readHumanConsole(loaded: Core): number {
  return humanConsole === undefined
    ? callNumber(loaded, "oxidevm_system_console_output", [CONSOLE_CHUNK_BYTES])
    : callNumber(loaded, "oxidevm_system_console_output_selected", [CONSOLE_CHUNK_BYTES, humanConsole === "serial" ? 0 : 1]);
}

function captureBootConsole(loaded: Core): void {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const total = drainSystemConsole(loaded, chunks, 0);
  if (total === 0) return;
  systemConsole.queueBoot(concatenate(chunks, total));
}

function readSystemConsoleChunk(
  loaded: Core,
): Uint8Array<ArrayBuffer> {
  const length = readHumanConsole(loaded);
  if (length < 0 || length > CONSOLE_CHUNK_BYTES) {
    throw new VMError(
      "VM_FAULT",
      "system console returned an invalid byte count",
    );
  }
  if (length === 0) return new Uint8Array();
  const pointer = callNumber(loaded, "oxidevm_staging_ptr");
  const bytes = memorySlice(loaded.memory, pointer, length).slice();
  systemConsole.record(bytes);
  return bytes;
}

function concatenate(
  chunks: readonly Uint8Array[],
  length: number,
): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function runProbe(
  requestId: number,
  program: Uint8Array,
  maximumSteps: number,
): Promise<CoreProbeResult> {
  const loaded = requireCore();
  await stopParallelExecution();
  assertStatus(callNumber(loaded, "oxidevm_reset", [0, 0]));
  const programAddress = loadDiagnosticLongMode(loaded);
  stage(loaded, program);
  assertStatus(
    callNumber(loaded, "oxidevm_load_memory", [
      programAddress,
      program.byteLength,
    ]),
  );

  let remaining = maximumSteps;
  let completed = 0n;
  while (remaining > 0) {
    abortIfCanceled(requestId);
    const jit = jitRuntime.runBlock(
      loaded,
      requestId,
      remaining,
      systemBooted,
      abortIfCanceled,
    );
    if (jit !== undefined) {
      if (jit.steps > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new VMError("VM_FAULT", "compiled JIT result is too large");
      }
      const steps = Number(jit.steps);
      completed += jit.steps;
      remaining -= steps;
      if (jit.kind === "step-limit" && remaining > 0) continue;
      return {
        apiVersion: CORE_API_VERSION,
        exit: withCoreSteps(jit, completed),
        state: decodeCpuSnapshot(readRecord(loaded, "cpu-state")).state,
      };
    }

    const chunk = Math.min(remaining, RUN_CHUNK_STEPS);
    assertStatus(callNumber(loaded, "oxidevm_run", [chunk]));
    const exit = decodeRunResult(readRecord(loaded, "result"));
    if (exit.kind === "adapter-exit") {
      throw new VMError(
        "UNSUPPORTED_SYSCALL",
        "diagnostic execution requested an adapter exit",
      );
    }
    if (exit.kind === "internal-failure") {
      throw coreFailureError(exit);
    }
    completed += exit.steps;
    if (exit.kind !== "step-limit" || chunk === remaining) {
      return {
        apiVersion: CORE_API_VERSION,
        exit: withCoreSteps(exit, completed),
        state: decodeCpuSnapshot(readRecord(loaded, "cpu-state")).state,
      };
    }
    remaining -= chunk;
    await nextTask();
  }
  throw new VMError("VM_FAULT", "core returned no execution result");
}

function systemConsoleTail(): string {
  return systemConsole.tail();
}

function failParallelExecution(error: VMError): void {
  parallelFailure = error;
  systemSessions.fail(error);
}

async function stopParallelExecution(): Promise<void> {
  const parallel = parallelExecution;
  if (parallel?.started === true && core !== undefined) await parallel.stop(core);
}

async function disposeParallelExecution(): Promise<void> {
  const parallel = parallelExecution;
  if (parallel === undefined) return;
  await stopParallelExecution();
  parallel.dispose();
  parallelExecution = undefined;
  parallelFailure = undefined;
}

function requireCore(): Core {
  if (core === undefined) {
    throw new VMError("PROTOCOL_ERROR", "core is not initialized");
  }
  return core;
}

function requireBootedSystem(): void {
  if (!systemBooted) {
    throw new VMError("INVALID_ARGUMENT", "system is not booted");
  }
}

function abortIfCanceled(requestId: number): void {
  if (canceled.has(requestId)) {
    throw new VMError("ABORTED", "operation was aborted");
  }
}

function nextTask(): Promise<void> {
  return new Promise<void>((resolve) => {
    taskQueue.push(resolve);
    taskChannel.port2.postMessage(undefined);
  });
}

function postFailure(id: number, error: unknown): void {
  const response: WorkerResponse = {
    id,
    version: PROTOCOL_VERSION,
    ok: false,
    error: serializeUnknownError(error),
  };
  self.postMessage(response);
}
