import { JsProcessWorkers } from "./js-process/driver.js";
import { nativePromiseCapability } from "../promise-brand.js";
import { nativeErrorCapability } from "../error-brand.js";
import { captureUserspaceJitProfileForRuntime } from "./userspace-jit-profile.js";
import { captureExecutionProfile } from "./userspace-execution-profile.js";
import { admitJSProcess } from "./js-process/admission.js";
import type { CommandInterceptorRecord } from "../../command-interceptors.js";
import type {NativeColdRuntime} from "./userspace-cold-start.js";
import { decodeWorkspaceBaseMetadata } from "../protocol/workspace-read.js";
import { admitUserspaceInput } from "./userspace-input-admission.js";
import { admitInitialUserspaceProcess, type InitialUserspaceProgram } from "./userspace-process-admission.js";
import { UserspaceCheckpointGate } from "./userspace-checkpoint-gate.js";
import { UserspaceCheckpointPort } from "./userspace-checkpoint-port.js";
import { UserspaceAccelerationKnowledge } from "./userspace-acceleration.js";
import { accelerationKnowledgeNamespace } from "./acceleration-knowledge.js";
import { engineReleaseId } from "../../engine.generated.js";
import { sdkVersion } from "../../sdk-version.js";
import { UserspaceRangedReads } from "./userspace-ranged-reads.js";
import { UserspaceWorkerCheckpoints } from "./userspace-worker-checkpoints.js";
import { UserspaceWorkerAttachments } from "./userspace-worker-attachments.js";
import { appendNativeTail, nativeAttachmentCommand } from "./userspace-attachments.js";
import { decodeNativeCheckpointConnection, type NativeCheckpointConfiguration } from "../protocol/userspace-checkpoints.js";
import type { NativeSnapshotRuntime } from "./userspace-snapshot-session.js";
import { newRuntimeState, type RuntimeState, type ProcessState } from "./userspace-worker-state.js";
import { instantiateRuntime } from "./userspace-runtime.js";
import { linuxSignalNumber } from "../process-signals.js";
import { createUserspaceWorkspaceCommit, flushUserspaceFiles } from "./userspace-workspace-commit.js";
import { UserspaceRootPersistence } from "./userspace-root-persistence.js";
import { nativeReconcileReads, reconcileWorkspaceStreams } from "./userspace-workspace-reconcile.js";
import { workspaceBytesInput } from "./workspace-stream.js";
import { UserspaceWorkspacePersistence } from "./userspace-workspace-persistence.js";
import { userspaceDurabilityCompletion } from "./userspace-durability.js";
import { UserspaceHostService } from "./userspace-host-service.js";
import { UserspaceStdin, writeUserspaceStdin } from "./userspace-stdin.js";
import { executeNativeFiles, readFileRecord } from "./userspace-files.js";
import { decodeUserspaceFileRequest, decodeUserspaceFileChanges } from "../userspace-files.js";
import { filesUnavailable } from "../workspace-files.js";
import type { FileMount } from "../protocol/userspace-files.js";
/// <reference lib="webworker" />

import { assertBrowserSupport } from "../browser-support.js";
import { serializeUnknownError, VMError } from "../errors.js";
import {
  decodeUserspaceHostRequest,
  type UserspaceStorageHostRequest,
  decodeUserspacePendingWork,
  decodeUserspaceWaitStatus,
  encodeUserspaceHostCompletion,
  encodeUserspaceNetworkHostCompletion,
  USERSPACE_PENDING_OUTPUT,
  USERSPACE_PENDING_PROCESS_EXIT,
  USERSPACE_PENDING_TIMER,
} from "../userspace-abi.js";
import {
  decodeUserspaceRequest,
  type UserspaceRequest,
} from "../userspace-protocol.js";
import { decodeGuestProcessPortAck } from "../protocol/agent.js";
import { decodeRequestId, PROTOCOL_VERSION } from "../protocol/common.js";
import type { ExecutionTimingMode } from "../protocol/common.js";
import { type JitDegradation, jitDegradationWarning } from "./control/jit-health.js";
import { DEFAULT_JIT_INSTALL_MODE, type SystemJitInstallMode } from "../protocol/system-trace-background-compile.js";
import {
  UserspaceStorageClient,
  type UserspaceRootfsRead,
} from "./userspace-storage-channel.js";
import { assertUserspaceStatus as assertStatus, callUserspaceU32 as call, callUserspaceU64 } from "./userspace-exports.js";
import { configureMountedRuntime, mountSettings, UNCONFIGURED_MOUNT, type UserspaceMountSettings } from "./userspace-settings.js";
import { readUserspaceListeners } from "./userspace-listener-read.js";
import { readUserspaceSyscallTrace } from "./userspace-trace-read.js";
import { acknowledgeUserspaceOutput, readUserspaceOutput } from "./userspace-output.js";
import { networkErrno } from "../relay-errors.js";
import { UserspaceNetworkClient } from "./userspace-network-channel.js";
import { UserspacePreviewRuntime } from "./userspace-preview-runtime.js";
import {
  createUserspaceWakeTimer,
  nativeExecutionPending,
  rearmsWakeTimer,
  shouldAcknowledgeOutputGeneration,
  wakeTimerAction,
} from "./userspace-service.js";
import { interactiveWindowEnd } from "./userspace-run-slices.js";
import type { UserspaceAttentionChannel } from "../protocol/userspace-slices.js";
import { decodeAttentionAttachment, HostAttention, isAttentionAttachment, type AttentionWatch } from "../host-attention.js";
import { runUserspaceSlice, type UserspaceSlicePorts } from "./userspace-run-loop.js";

const MAX_COMPLETED_TRACES = 64;
const MAX_MANAGED_CACHE_BYTES = 512 * 1024 * 1024;


let module: WebAssembly.Module | undefined;
let wasmUrl: string | undefined;
const processes = new Map<number, ProcessState>();
const admissionReads = new Map<number, AbortController>();
const retiredProcesses = new Map<number, ProcessState>();
const previewReferences = new Map<number, number>();
const completedSyscallTraces = new Map<number, Uint8Array>();
const completedExecutionProfiles = new Map<number, ReturnType<typeof captureExecutionProfile>>();
const managedBytes = new Map<string, Uint8Array<ArrayBuffer>>();
// Verified copies of files larger than one transfer, pinned for the duration of their ranged reads.
const rangedReads = new UserspaceRangedReads();
const managedPathDigests = new Map<string, string>();
let runtimeState: RuntimeState | undefined;
let runtimeMounting: Promise<RuntimeState> | undefined;
let runtimeMountingCancellation: AbortController | undefined;
let workspaceFailure: Error | undefined;
let disposing = false;
const runtimeWakeTimer = createUserspaceWakeTimer(
  {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: (handle) => { clearTimeout(handle); },
  },
  () => {
    const runtime = runtimeState;
    if (runtime !== undefined) run(runtime);
  },
);
let runtimeRunScheduled = false;
/** Terminal input keeps run slices short until then (`userspace-run-slices.ts`). */
let interactiveUntil = 0;
const runtimeRunChannel = new MessageChannel();
const workspaceCommit = createUserspaceWorkspaceCommit(persistWorkspace, error => {
  workspaceFailure = error instanceof Error ? error : new VMError("STORAGE_ERROR", "Workspace persistence failed");
});
let managedCacheBytes = 0;
let managedRootTree: string | undefined;
let mount: UserspaceMountSettings = UNCONFIGURED_MOUNT;
let memoryMiB = 512;
let interceptors: readonly CommandInterceptorRecord[] | undefined;
let nativeExecutionPort: MessagePort | undefined;
/** ADR 0026: remembered fast-path failures, imported before every acceleration enable. */
let accelerationKnowledge: UserspaceAccelerationKnowledge | undefined;
let executionTiming: ExecutionTimingMode = { kind: "disabled" };
let jitInstall: SystemJitInstallMode = DEFAULT_JIT_INSTALL_MODE;
let storage: UserspaceStorageClient | undefined;
let network: UserspaceNetworkClient | undefined;
let networkEnabled = false;
const checkpointGate = new UserspaceCheckpointGate();
const previewRuntime = new UserspacePreviewRuntime({
  gate: checkpointGate, epoch: () => runtimeState,
  processes: () => [...processes.values(), ...retiredProcesses.values()].map(active => ({
    pid: active.pid, instance: active.runtime.instance, memory: active.runtime.memory, wake: () => scheduleRun(active),
  })),
  opened: pid => { previewReferences.set(pid, (previewReferences.get(pid) ?? 0) + 1); }, closed: releasePreviewReference,
});
const attachments = new UserspaceWorkerAttachments();
let checkpointPort: UserspaceCheckpointPort | undefined;
let checkpointSession: UserspaceWorkerCheckpoints | undefined;
const canceled = new Set<number>();
const stdin = new UserspaceStdin((pid, bytes) => writeStdin(requireProcess(pid), bytes));

runtimeRunChannel.port1.addEventListener("message", () => {
  runtimeRunScheduled = false;
  const runtime = runtimeState;
  if (runtime !== undefined && hasNativeWork(runtime)) run(runtime);
});
runtimeRunChannel.port1.start();
/** Channels whose producers count their posts, so a guest slice ends early for their messages. */
const hostAttention = new HostAttention<UserspaceAttentionChannel>();
let controlAttention: AttentionWatch | undefined;
const slicePorts: UserspaceSlicePorts = {
  now: () => performance.now(), interactiveUntil: () => interactiveUntil, attention: hostAttention,
  servicePendingWork, serviceHostRequests, finishResult, scheduleRun: active => { scheduleRun(active); },
};

function postRuntimeRun(runtime: RuntimeState): void {
  const scheduler: unknown = Reflect.get(globalThis, "scheduler");
  const postTask: unknown = typeof scheduler === "object" && scheduler !== null
    ? Reflect.get(scheduler, "postTask")
    : undefined;
  if (typeof postTask === "function") {
    try {
      Reflect.apply(postTask, scheduler, [() => {
        runtimeRunScheduled = false;
        if (runtimeState === runtime && hasNativeWork(runtime)) run(runtime);
      }, { priority: "background" }]);
      return;
    } catch {
      // The MessageChannel continuation is the compatible worker fallback.
    }
  }
  runtimeRunChannel.port2.postMessage(undefined);
}

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  controlAttention?.delivered();
  void receive(event.data);
});
self.addEventListener("messageerror", () => { controlAttention?.delivered(); });

async function receive(value: unknown): Promise<void> {
  if (isAttentionAttachment(value)) {
    // The relay's first message; a second attachment or a malformed one is a protocol defect.
    if (controlAttention !== undefined) throw new VMError("PROTOCOL_ERROR", "Host attention is already attached");
    controlAttention = hostAttention.watch("control", decodeAttentionAttachment(value));
    return;
  }
  if (typeof value === "object" && value !== null && Reflect.get(value, "type") === "connect-checkpoints") {
    try {
      if (checkpointPort !== undefined) throw new VMError("PROTOCOL_ERROR", "Checkpoint connection already exists");
      const connection = decodeNativeCheckpointConnection(value);
      const session = new UserspaceWorkerCheckpoints(connection.snapshotPort, configureCheckpoints, () => checkpointGate.operation(flushCheckpointFiles), event => connection.eventsPort.postMessage({ version: PROTOCOL_VERSION, event }));
      checkpointSession = session;
      checkpointPort = new UserspaceCheckpointPort(connection.port, (request, signal) => session.handle(request, signal));
    } catch (error) { const id = decodeRequestId(value); if (id !== undefined) respondError(id, error); }
    return;
  }
  let decoded;
  try {
    decoded = decodeUserspaceRequest(value);
  } catch (error) {
    const id = decodeRequestId(value);
    if (id !== undefined) respondError(id, error);
    return;
  }
  if (decoded.type === "cancel") {
    canceled.add(decoded.requestId);
    admissionReads.get(decoded.requestId)?.abort();
    stdin.cancel(decoded.requestId);
    return;
  }
  try {
    const execute = (): Promise<unknown> => {
      if (canceled.has(decoded.id)) throw new VMError("ABORTED", "Userspace request cancelled before admission");
      return handle(decoded);
    };
    let result: unknown;
    if (decoded.type === "stdin") result = await admitUserspaceInput(checkpointGate, execute);
    else result = await checkpointGate.operation(execute);
    if (!canceled.delete(decoded.id)) {
      self.postMessage({ id: decoded.id, version: PROTOCOL_VERSION, ok: true, value: result }, result instanceof MessagePort ? [result] : []);
    }
    if (decoded.type === "dispose") self.close();
  } catch (error) {
    if (!canceled.delete(decoded.id)) respondError(decoded.id, error);
  }
}

async function handle(request: UserspaceRequest): Promise<unknown> {
  if (disposing && request.type !== "dispose") throw new VMError("ABORTED", "Userspace VM is disposing");
  switch (request.type) {
    case "initialize":
      if (module !== undefined) throw new VMError("PROTOCOL_ERROR", "Userspace worker is initialized");
      if (request.rootPersistence === "persistent" && request.storagePort === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Persistent Userspace system files require durable storage");
      await initialize(request.wasmUrl, request.wasmModule);
      mount = mountSettings(request);
      memoryMiB = request.memoryMiB;
      interceptors = request.interceptors;
      nativeExecutionPort = request.nativeExecutionPort;
      if (nativeExecutionPort !== undefined && (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== "function")) throw new VMError("FEATURE_NOT_AVAILABLE", "Native execution requires cross-origin isolation");
      if (interceptors !== undefined && (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== "function" || new URL(interceptors[0]?.worker ?? "", location.href).origin !== location.origin)) throw new VMError("FEATURE_NOT_AVAILABLE", "Command interception requires cross-origin isolation and a same-origin trusted worker");
      executionTiming = request.executionTiming ?? { kind: "disabled" };
      jitInstall = request.jitInstall ?? DEFAULT_JIT_INSTALL_MODE;
      storage = request.storagePort === undefined
        ? undefined
        : new UserspaceStorageClient(request.storagePort);
      network = request.networkPort === undefined
        ? undefined
        : new UserspaceNetworkClient(request.networkPort, enabled => checkpointGate.deliver(() => configureNetwork(enabled)));
      network?.servePreview((operation, signal) => previewRuntime.request(operation, signal));
      if (nativeExecutionPort !== undefined) {
        accelerationKnowledge = new UserspaceAccelerationKnowledge(storage, accelerationKnowledgeNamespace(engineReleaseId, sdkVersion), () => runtimeState);
        await accelerationKnowledge.load();
      }
      return undefined;
    case "attach-process": {
      const saved = attachments.adopt(request.attachmentKey);
      const runtime = runtimeState;
      if (runtime === undefined) throw filesUnavailable("no-root-filesystem");
      const active: ProcessState = { runtime, pid: saved.pid, identityKey: saved.identityKey, sessionId: saved.key, command: saved.command,
        terminal: saved.terminal, stdinOpen: saved.stdinOpen, sequence: saved.sequence, acknowledged: saved.acknowledged,
        awaitingAck: saved.pending === undefined ? undefined : { ...saved.pending, sequence: saved.sequence },
        tail: saved.tail, stopped: false, port: request.port };
      connectProcess(active); return { pid: active.pid, sessionId: active.sessionId,identityKey:active.identityKey };
    }
    case "spawn":
      return spawn({ kind: "elf", bytes: request.elf }, request);
    case "spawn-js": {
      if (mount.initialUser !== "user") throw new VMError("FEATURE_NOT_AVAILABLE", "JS processes require ordinary uid/gid 1000");
      const runtime = await ensureManagedRuntime(request);
      if (isDisposing() || canceled.has(request.id)) throw new VMError("ABORTED", "JS process creation cancelled");
      const workers = runtime.jsProcesses;
      if (workers === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "JS process transport is unavailable");
      const token = workers.register(request.worker);
      try {
        const pid = admitJSProcess(runtime, token, request.arguments, request.environment, request.cwd, request.terminal);
        const process = connectSpawnedProcess(runtime, pid, request.port, "js-process", request.terminal);
        // Consume the Rust-admitted launch before another control request can cancel it.
        serviceHostRequests(runtime);
        return process;
      } catch (error) { workers.retireLaunch(token); throw error; }
    }
    case "spawn-managed": {
      const client = storage;
      if (client === undefined) throw filesUnavailable("no-root-filesystem");
      await ensureManagedRuntime(request);
      return spawn({ kind: "file", filename: request.executable }, request);
    }
    case "files": {
      if (request.mount !== undefined) await ensureManagedRuntime(request.mount);
      const runtime = runtimeState ?? await runtimeMounting;
      if (runtime === undefined) throw filesUnavailable("no-root-filesystem");
      if (disposing) throw new VMError("ABORTED", "Userspace VM is disposing");
      const operation = decodeUserspaceFileRequest(request.request).operation;
      const mutation = operation === "write" || operation === "mkdir" || operation === "rename" || operation === "remove";
      if (mutation && workspaceFailure !== undefined) await workspaceCommit.flush();
      if (isDisposing() || canceled.has(request.id) || runtimeState !== runtime) throw new VMError("ABORTED", "workspace file operation canceled");
      const workspace = runtime.workspacePersistence;
      const response = await executeNativeFiles(runtime, request.request, async (path, sha256) => {
        const client = storage;
        if (client === undefined || runtime.rootTreeSha256 === undefined) throw filesUnavailable("no-root-filesystem");
        return readManagedBytes(client, runtime.rootTreeSha256, path, sha256 ?? undefined, false);
      }, () => {
        if (disposing || canceled.has(request.id) || runtimeState !== runtime) throw new VMError("ABORTED", "workspace file read canceled");
      }, workspace === undefined ? undefined : (bytes, check) => workspace.requestFile(bytes, check));
      if (mutation) {
        const committed = scheduleWorkspaceCommit(); scheduleRun(runtime);
        // A successful write acknowledgment also protects the editor's clean recovery copy.
        if (operation === "write") await committed;
      }
      return response;
    }
    case "file-changes": {
      if (workspaceFailure !== undefined) throw workspaceFailure;
      const runtime = runtimeState ?? await runtimeMounting;
      if (runtime === undefined) throw filesUnavailable("no-root-filesystem");
      assertStatus(call(runtime.instance, "oxidevm_userspace_file_changes", request.cursor), "read workspace changes");
      const response = readFileRecord(runtime);
      decodeUserspaceFileChanges(response);
      return response;
    }
    case "stdin":
      requireGeneration(request.pid, request.sessionId);
      interactiveUntil = interactiveWindowEnd(performance.now());
      return stdin.write(request.id, request.pid, request.data);
    case "close-stdin": {
      const active = requireGeneration(request.pid, request.sessionId);
      stdin.rejectProcess(request.pid, new VMError("ABORTED", "Userspace stdin closed"));
      closeStdin(active); return undefined;
    }
    case "resize-terminal": {
      const active = requireGeneration(request.pid, request.sessionId);
      assertStatus(call(active.runtime.instance, "oxidevm_userspace_process_terminal_resize", active.pid, request.terminal.columns, request.terminal.rows), "resize process terminal");
      active.terminal = request.terminal;
      scheduleRun(active);
      return undefined;
    }
    case "signal": {
      const active = requireGeneration(request.pid, request.sessionId);
      sendSignal(active, signalNumber(request.signal));
      return undefined;
    }
    case "signal-named": {
      const active = requireGeneration(request.pid, request.sessionId);
      const operation = request.scope === "process-group" ? "oxidevm_userspace_process_group_signal" : "oxidevm_userspace_process_signal";
      assertStatus(call(active.runtime.instance, operation, active.pid, linuxSignalNumber(request.signal)), operation);
      scheduleRun(active); return undefined;
    }
    case "terminal-resize": {
      const active = requireGeneration(request.pid, request.sessionId);
      assertStatus(call(active.runtime.instance, "oxidevm_userspace_process_terminal_resize", active.pid, request.terminal.columns, request.terminal.rows), "terminal resize");
      active.terminal = request.terminal;
      scheduleRun(active); return undefined;
    }
    case "terminal-interrupt": {
      const active = requireGeneration(request.pid, request.sessionId);
      assertStatus(call(active.runtime.instance, "oxidevm_userspace_process_terminal_interrupt", active.pid), "foreground interrupt");
      scheduleRun(active); return undefined;
    }
    case "acceleration-notices":
      if (accelerationKnowledge === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Fast-path notices need command acceleration");
      return accelerationKnowledge.subscribe();
    case "js-trace": {
      const runtime = runtimeState;
      if (runtime === undefined) throw filesUnavailable("no-root-filesystem");
      if (request.capacity !== undefined) assertStatus(call(runtime.instance, "oxidevm_userspace_js_trace_configure", request.capacity), "configure JS service trace");
      assertStatus(call(runtime.instance, "oxidevm_userspace_js_trace"), "read JS service trace");
      return readFileRecord(runtime);
    }
    case "read-syscall-trace": {
      const active = processes.get(request.pid) ?? retiredProcesses.get(request.pid);
      const trace = active === undefined
        ? completedSyscallTraces.get(request.pid)
        : readUserspaceSyscallTrace(active.runtime);
      if (trace === undefined) {
        throw new VMError("INVALID_ARGUMENT", "Userspace syscall trace is unavailable");
      }
      return trace.slice();
    }
    case "read-execution-profile": {
      const active = processes.get(request.pid) ?? retiredProcesses.get(request.pid);
      const snapshot = active === undefined
        ? completedExecutionProfiles.get(request.pid)
        : captureExecutionProfile(active);
      if (snapshot === undefined) {
        throw new VMError("INVALID_ARGUMENT", "Userspace execution profile is unavailable");
      }
      const { profile, runtimeKey } = snapshot;
      const jit = captureUserspaceJitProfileForRuntime(active?.runtime.core ?? runtimeState?.core, runtimeKey, profile.coreProfile.enabled);
      return jit === undefined ? profile : { ...profile, jit };
    }
    case "listening-ports":
      return readUserspaceListeners(runtimeState, request.known);
    case "network-revoke":
      configureNetwork(false);
      return undefined;
    case "dispose": {
      disposing = true;
      for (const admission of admissionReads.values()) admission.abort();
      checkpointGate.close(); checkpointPort?.close(); checkpointSession?.close(); attachments.clear(); accelerationKnowledge?.close();
      runtimeMountingCancellation?.abort();
      runtimeWakeTimer.cancel(); runtimeRunScheduled = false;
      let disposalFailure: Error | undefined;
      try {
        try { await runtimeMounting; }
        catch (error) {
          if (!(error instanceof VMError && error.code === "ABORTED" && error.detail?.["cleanupFailed"] !== true && runtimeState === undefined)) throw error;
        }
        await flushCheckpointFiles();
      } catch (error: unknown) {
        disposalFailure = error instanceof Error
          ? error
          : new VMError("STORAGE_ERROR", "Userspace workspace persistence failed");
      }
      await runtimeState?.hostService?.drainDurability();
      if (runtimeState !== undefined) {
        assertStatus(call(runtimeState.instance, "oxidevm_userspace_host_cancel"), "oxidevm_userspace_host_cancel");
      }
      for (const active of [...processes.values()]) postExit(active, { kind: "signal", signal: 9 });
      runtimeWakeTimer.cancel();
      runtimeRunScheduled = false;
      workspaceCommit.reset();
      runtimeState?.jsProcesses?.dispose();runtimeState?.hostService?.cancel();
      previewRuntime.close();
      if (runtimeState !== undefined) await runtimeState.jitRuntime.dispose();
      runtimeState = undefined;
      runtimeMounting = undefined;
      workspaceFailure = undefined;
      retiredProcesses.clear();
      completedSyscallTraces.clear();
      completedExecutionProfiles.clear();
      previewReferences.clear();
      storage?.cancelAll();
      storage?.close();
      storage = undefined;
      network?.close();
      network = undefined;
      networkEnabled = false;
      module = undefined;
      mount = UNCONFIGURED_MOUNT;
      wasmUrl = undefined;
      executionTiming = { kind: "disabled" };
      jitInstall = DEFAULT_JIT_INSTALL_MODE;
      clearManagedBytes();
      if (disposalFailure !== undefined) throw disposalFailure;
      return undefined;
    }
  }
}

async function persistWorkspace(): Promise<void> {
  const active = runtimeState;
  if (active?.workspacePersistence === undefined || active.startup === "scaffold") return;
  await active.workspacePersistence.persist();
  workspaceFailure = undefined;
}

async function initialize(source: string, compiled?: WebAssembly.Module): Promise<void> {
  assertBrowserSupport();
  if (compiled === undefined) {
    const response = await fetch(source);
    if (!response.ok) throw new VMError("CORE_LOAD_FAILED", "Userspace Wasm fetch failed");
    module = await WebAssembly.compile(await response.arrayBuffer());
  } else module = compiled;
  wasmUrl = source;
}

function selectManagedRoot(rootTreeSha256: string): void {
  if (managedRootTree === rootTreeSha256) return;
  if (managedRootTree !== undefined && (hasNativeWork(runtimeState) || runtimeMounting !== undefined)) {
    throw new VMError("INVALID_ARGUMENT", "Userspace rootfs cannot change while processes are active");
  }
  clearManagedBytes();
  managedRootTree = rootTreeSha256;
}

/** Serves a range of a file larger than one transfer from its verified copy, pinned until the last range. */
function readRangedBytes(
  active: RuntimeState,
  client: UserspaceStorageClient,
  request: UserspaceStorageHostRequest,
  signal: AbortSignal,
): Promise<UserspaceRootfsRead> {
  const expectedSha256 = request.expectedSha256;
  if (expectedSha256 === undefined) throw new VMError("PROTOCOL_ERROR", "ranged storage read has no file digest");
  return rangedReads.range(request.path, expectedSha256, request.expectedBytes, request.offset, request.length, () =>
    active.rootTreeSha256 === undefined
      ? client.readRootfs(request.path, signal)
      : readManagedBytes(client, active.rootTreeSha256, request.path, expectedSha256, false, signal));
}

async function readManagedBytes(
  client: UserspaceStorageClient,
  rootTreeSha256: string,
  path: string,
  expectedSha256: string | undefined,
  cacheable: boolean,
  signal?: AbortSignal,
): Promise<UserspaceRootfsRead> {
  const pathKey = `${rootTreeSha256}\0${path}`;
  const digest = expectedSha256 ?? managedPathDigests.get(pathKey);
  if (digest !== undefined) {
    const cached = managedBytes.get(`${rootTreeSha256}:${digest}`);
    if (cached !== undefined) return { sha256: digest, bytes: cached };
  }
  const response = await client.readRootfs(path, signal);
  if (expectedSha256 !== undefined && response.sha256 !== expectedSha256) {
    throw new VMError("PROTOCOL_ERROR", "managed rootfs response digest does not match its host request");
  }
  managedPathDigests.set(pathKey, response.sha256);
  if (!cacheable || response.bytes.byteLength > MAX_MANAGED_CACHE_BYTES) return response;
  const key = `${rootTreeSha256}:${response.sha256}`;
  const existing = managedBytes.get(key);
  if (existing !== undefined) return { sha256: response.sha256, bytes: existing };
  while (managedCacheBytes + response.bytes.byteLength > MAX_MANAGED_CACHE_BYTES) {
    const oldest = managedBytes.keys().next().value;
    if (oldest === undefined) break;
    managedCacheBytes -= managedBytes.get(oldest)?.byteLength ?? 0;
    managedBytes.delete(oldest);
  }
  managedBytes.set(key, response.bytes);
  managedCacheBytes += response.bytes.byteLength;
  return response;
}

function cacheableManagedPath(path: string): boolean {
  return /^(?:\/usr)?\/(?:s?bin|lib(?:32|64)?)\//u.test(path);
}

function clearManagedBytes(): void {
  managedBytes.clear();
  rangedReads.clear();
  managedPathDigests.clear();
  managedCacheBytes = 0;
  managedRootTree = undefined;
}


/** A new instance starts with an empty table, so the stored records go in before acceleration. */
function enableNativeAcceleration(binding: Pick<RuntimeState, "instance" | "memory">, operation: string): void {
  if (nativeExecutionPort === undefined) return;
  accelerationKnowledge?.importInto(binding);
  assertStatus(call(binding.instance, "oxidevm_userspace_acceleration_enable", nativePromiseCapability | nativeErrorCapability), operation);
}

function mountRuntimeRootfs(binding:Pick<RuntimeState,"instance"|"memory">, rootfs:Uint8Array, cpuProfile:"x86-64-v2"|"x86-64-v3", workspaceBaseSha256?:string):void {
    assertStatus(call(binding.instance, "oxidevm_userspace_staging_resize", rootfs.byteLength), "mount staging");
    new Uint8Array(binding.memory.buffer, call(binding.instance, "oxidevm_userspace_staging_ptr"), rootfs.byteLength).set(rootfs);
    assertStatus(call(binding.instance, "oxidevm_userspace_mount_rootfs", rootfs.byteLength, cpuProfile === "x86-64-v2" ? 1 : 2, memoryMiB), "mount rootfs");
    configureMountedRuntime(binding.instance, mount, networkEnabled);
    if (interceptors !== undefined) assertStatus(call(binding.instance, "oxidevm_userspace_command_enable"), "enable command interceptor");
    enableNativeAcceleration(binding, "enable native acceleration");
    if (workspaceBaseSha256 !== undefined && storage !== undefined) assertStatus(call(binding.instance, "oxidevm_userspace_configure_workspace_persistence"), "configure workspace persistence");
}

async function createMountedRuntime(rootfs: Uint8Array, cpuProfile: "x86-64-v2" | "x86-64-v3", rootTreeSha256?: string, workspaceBaseSha256?: string, startup: "files" | "scaffold" = "files"): Promise<RuntimeState> {
  if (disposing) throw new VMError("ABORTED", "Userspace mounting cancelled");
  if (module === undefined || wasmUrl === undefined) throw new VMError("CORE_LOAD_FAILED", "Userspace worker is not initialized");
  if (mount.rootPersistence === "persistent" && (rootTreeSha256 === undefined || storage === undefined)) throw new VMError("FEATURE_NOT_AVAILABLE", "Persistent Userspace system files require a managed rootfs and durable storage");
  const binding = await instantiateRuntime(module, wasmUrl, executionTiming, jitInstall, warnJitDegraded);
  const cancellation = new AbortController();
  runtimeMountingCancellation = cancellation;
  try {
    if (isDisposing()) throw new VMError("ABORTED", "Userspace mounting cancelled");
    mountRuntimeRootfs(binding,rootfs,cpuProfile,workspaceBaseSha256);
    const runtime = newRuntimeState(binding, startup === "scaffold" ? "scaffold" : "ready", rootTreeSha256, workspaceBaseSha256);
    bindRuntimeServices(runtime);
    runtime.rootPersistence?.configure();
    if (startup === "files") {
      await runtime.rootPersistence?.initialize(cancellation.signal);
      await runtime.workspacePersistence?.initialize(cancellation.signal);
    }
    if (isDisposing()) throw new VMError("ABORTED", "Userspace mounting cancelled");
    runtimeState = runtime;
    return runtime;
  } catch (error) { await binding.jitRuntime.dispose(); throw error; }
  finally { if (runtimeMountingCancellation === cancellation) runtimeMountingCancellation = undefined; }
}

function configureRuntimeRoot(runtime:RuntimeState):void {runtime.rootPersistence?.configure();}

function bindRuntimeServices(runtime: RuntimeState, previous?: RuntimeState, origin:"restored"|"remounted"="restored", workspace:"now"|"later"="now"): void {
  runtime.jsProcesses = new JsProcessWorkers({ runtime, ...(interceptors?.[0] === undefined ? {} : { interceptor: interceptors[0].worker }),
    ...(nativeExecutionPort === undefined ? {} : { nativeExecution: nativeExecutionPort }),
    attention: { watch: counter => hostAttention.watch("js-process", counter) },
    knowledge: { remember: (notice, failure) => { void accelerationKnowledge?.remember(notice, failure); } },
    active: () => runtimeState === runtime && !disposing, wake: () => scheduleRun(runtime) });
  runtime.hostService = new UserspaceHostService({
    take: mask => takeHostRequest(runtime, mask), service: (request, signal) => serviceHostRequest(runtime, request, signal),
    active: () => checkpointGate.executionAllowed && !disposing && runtimeState === runtime,
    settled: () => { if (runtimeState === runtime) scheduleRun(runtime); },
    failed: error => { if (runtimeState === runtime) for (const process of [...processes.values()]) failProcess(process, error); },
  });
  if (mount.rootPersistence === "persistent" && runtime.rootTreeSha256 !== undefined && storage !== undefined) {
    const wake = () => scheduleRun(runtime);
    const failed = (error: unknown) => {
      workspaceFailure = error instanceof Error ? error : new VMError("STORAGE_ERROR", "Root persistence failed");
    };
    runtime.rootPersistence = previous?.rootPersistence?.[origin](runtime, runtime.rootTreeSha256, wake, failed)
      ?? new UserspaceRootPersistence(runtime, storage, runtime.rootTreeSha256, wake, failed);
  }
  if (workspace === "now") bindWorkspacePersistence(runtime);
}

/** Resets the native workspace capture, so a restored runtime binds it only once its native
 * checkpoint candidate is published: before that the native runtime refuses the reset. */
function bindWorkspacePersistence(runtime: RuntimeState): void {
  if (runtime.workspaceBaseSha256 !== undefined && storage !== undefined) {
    runtime.workspacePersistence = new UserspaceWorkspacePersistence(runtime, storage, runtime.workspaceBaseSha256, () => scheduleRun(runtime),
      () => runtime.hostService?.drainStorage() ?? Promise.resolve(false));
  }
}

async function flushCheckpointFiles(): Promise<void> {
  if(runtimeState?.startup === "scaffold")return;
  await flushUserspaceFiles(workspaceCommit, runtimeState?.rootPersistence);
  await runtimeState?.hostService?.drainDurability();
}

function resumeCheckpointClock(runtime: RuntimeState): void {
  try { runtime.checkpoints.resumeClock(); }
  catch (error) {
    checkpointGate.close();
    throw new VMError("STORAGE_ERROR", "Native checkpoint clock reattachment failed", {
      reason: "checkpoint-clock-reattach-failed", cleanupFailed: true,
      cause: error instanceof VMError ? error.code : "STORAGE_ERROR",
    });
  }
}

async function configureCheckpoints(configuration: NativeCheckpointConfiguration, signal: AbortSignal): Promise<NativeSnapshotRuntime & NativeColdRuntime> {
  await checkpointGate.operation(() => {
    if (signal.aborted) throw new VMError("ABORTED", "Native checkpoint configuration cancelled");
    return ensureManagedRuntime(configuration.mount, "scaffold");
  });
  const current = (): RuntimeState => {
    if (runtimeState === undefined) throw new VMError("ABORTED", "Native runtime is unavailable");
    return runtimeState;
  };
  const imageBytes = (image: string): Uint8Array => Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(image.slice(index * 2, index * 2 + 2), 16));
  const currentImage = (): string => current().rootTreeSha256 ?? configuration.mount.rootTreeSha256;
  return {
    get image() { return currentImage(); }, memoryBytes: memoryMiB * 1024 * 1024, rootPersistence: mount.rootPersistence,
    get workspaceBaseSha256() { return current().workspaceBaseSha256 ?? configuration.mount.workspaceBaseSha256; }, destination: { ...configuration.destination, trusted: { ...configuration.destination.trusted, publicKey: configuration.destination.trusted.publicKey.slice() } },
    discardStartup: async candidate => {
      const previous=current();
      previewRuntime.close();
      if(candidate===undefined)previous.checkpoints.beginCold(imageBytes(currentImage())).abort();
      else candidate.discardStartup();
      previous.jsProcesses?.dispose();previous.hostService?.cancel();runtimeWakeTimer.cancel();runtimeRunScheduled=false;
      previous.jitRuntime.invalidate();
      // The native discard retired the sole heap. Remount in the same Wasm instance.
      mountRuntimeRootfs(previous,configuration.mount.rootfs,configuration.mount.cpuProfile,configuration.mount.workspaceBaseSha256);
      const replacement:RuntimeState={...previous,startup:"scaffold",rootTreeSha256:configuration.mount.rootTreeSha256,workspaceBaseSha256:configuration.mount.workspaceBaseSha256,pendingResult:undefined};
      delete replacement.hostService;delete replacement.rootPersistence;delete replacement.workspacePersistence;
      previous.jsProcesses?.dispose();
      bindRuntimeServices(replacement,previous,"remounted");configureRuntimeRoot(replacement);
      workspaceCommit.reset();workspaceFailure=undefined;runtimeState=replacement;runtimeMounting=undefined;
      await Promise.resolve();
    },
    beginCold: async signal => {
      await checkpointGate.freeze(async () => {
        runtimeWakeTimer.cancel(); runtimeRunScheduled = false;
        current().checkpoints.pauseClock();
        await current().rootPersistence?.initialize(signal);
        previewRuntime.close();
      });
      return current().checkpoints.beginCold(imageBytes(currentImage()));
    },
    reconcileCold: async (candidate, sourceId, signal) => {
      const client=storage;if(client===undefined)throw filesUnavailable("no-root-filesystem");
      const base=current().workspaceBaseSha256??configuration.mount.workspaceBaseSha256;
      return reconcileWorkspaceStreams(candidate.beginReconcile(sourceId),workspaceBytesInput(configuration.mount.rootfs),
        nativeReconcileReads(client,base,signal),{kind:"cold",retainedId:sourceId,workspaceBaseSha256:base},signal,
        async foreign=>decodeWorkspaceBaseMetadata(await client.request({type:"inspect-workspace-base",workspaceBaseSha256:foreign},[],signal)));
    },
    coldPublished: () => {
      if (interceptors !== undefined) assertStatus(call(current().instance, "oxidevm_userspace_command_enable"), "enable cold command interceptor");
      enableNativeAcceleration(current(), "enable cold native acceleration");
      current().startup="ready";workspaceCommit.reset();workspaceFailure=undefined;resumeCheckpointClock(current());checkpointGate.resume();
    },
    coldFailed: async () => {
      previewRuntime.retire();
      checkpointGate.close();runtimeWakeTimer.cancel();runtimeRunScheduled=false;
      const failed=runtimeState;runtimeState=undefined;runtimeMounting=undefined;
      failed?.jsProcesses?.dispose();failed?.hostService?.cancel();await failed?.jitRuntime.dispose();
    },
    get baseline() { return current().checkpoints.baseline; },
    dirty: () => current().checkpoints.dirty !== current().checkpoints.acknowledgedDirty,
    assertCheckpointAdmission: () => current().jsProcesses?.assertIdle(),
    freeze: async signal => {
      current().jsProcesses?.assertIdle();
      if (signal?.aborted === true) throw new VMError("ABORTED", "Native freeze cancelled");
      await checkpointGate.freeze(async () => {
        runtimeWakeTimer.cancel(); runtimeRunScheduled = false;
        try { current().checkpoints.pauseClock(); await flushCheckpointFiles(); previewRuntime.close(); }
        catch (error) { resumeCheckpointClock(current()); throw error; }
      });
      runtimeWakeTimer.cancel(); runtimeRunScheduled = false;
    },
    resume: () => { resumeCheckpointClock(current()); checkpointGate.resume(); const runtime = runtimeState; if (runtime !== undefined) scheduleRun(runtime); },
    attachments: () => attachments.capture(processes.values()),
    beginCapture: () => current().checkpoints.beginCapture(imageBytes(currentImage())),
    beginPrecopy: baseline => current().checkpoints.beginPrecopy(imageBytes(currentImage()), baseline),
    beginRestore: image => current().checkpoints.beginRestore(imageBytes(image), imageBytes(currentImage()), mount.rootPersistence === "persistent" ? imageBytes(image) : null),
    beginRecovery: () => current().checkpoints.beginRecovery(imageBytes(currentImage())),
    reconcile: async (candidate, selection, signal) => {
      const client=storage;if(client===undefined)throw filesUnavailable("no-root-filesystem");
      const cancellation=signal??new AbortController().signal;
      return reconcileWorkspaceStreams(candidate.beginReconcile(selection.snapshotId,selection.retainedId),workspaceBytesInput(selection.rootfs.metadata),
        nativeReconcileReads(client,selection.workspaceBaseSha256,cancellation),{...selection,kind:"restore"},cancellation, async base=>decodeWorkspaceBaseMetadata(await client.request({type:"inspect-workspace-base",workspaceBaseSha256:base},[],cancellation)));
    },
    prepareAttachments: (saved, recovering, candidate, image) => {
      const prepared = attachments.prepare(saved, recovering, processes.values(), attachment => candidate.validateAttachment(attachment));
      const previous = current();
      // Fresh browser adapters bind the restored native state; initialize would replay newer files.
      const replacement: RuntimeState = { ...previous, ...image, startup:"ready", pendingResult: undefined };
      delete replacement.hostService; delete replacement.rootPersistence; delete replacement.workspacePersistence;
      bindRuntimeServices(replacement, previous, "restored", "later");
      return { attachments: prepared.attachments, publish: () => {
        bindWorkspacePersistence(replacement);
        previewRuntime.retire(); retiredProcesses.clear(); previewReferences.clear();
        // Normal runtime calls require the native checkpoint candidate to be published first.
        if (interceptors?.[0] !== undefined) assertStatus(call(replacement.instance, "oxidevm_userspace_command_enable"), "enable restored command interceptor");
        enableNativeAcceleration(replacement, "enable restored native acceleration");
        previous.jsProcesses?.dispose();previous.hostService?.cancel(); runtimeWakeTimer.cancel(); runtimeRunScheduled = false;
        if (recovering) {
          for (const process of processes.values()) process.runtime = replacement;
        } else {
          for (const process of processes.values()) {
            stdin.rejectProcess(process.pid, new VMError("ABORTED", "Native process handle was replaced"));
            process.port.close();
          }
          processes.clear(); retiredProcesses.clear(); previewReferences.clear();
          completedSyscallTraces.clear(); completedExecutionProfiles.clear();
        }
        workspaceCommit.reset(); workspaceFailure = undefined;
        runtimeState = replacement; runtimeMounting = undefined;
        if (managedRootTree !== replacement.rootTreeSha256) {
          clearManagedBytes(); managedRootTree = replacement.rootTreeSha256;
        }
        prepared.publish();
      } };
    },
  };
}

async function ensureManagedRuntime(source: FileMount, startup: "files" | "scaffold" = "files"): Promise<RuntimeState> {
  if (runtimeState !== undefined && runtimeState.rootTreeSha256 !== source.rootTreeSha256) throw new VMError("INVALID_ARGUMENT", "replace the VM before changing its mounted rootfs");
  selectManagedRoot(source.rootTreeSha256);
  if (runtimeState !== undefined) return runtimeState;
  if (runtimeMounting !== undefined) return runtimeMounting;
  if (storage === undefined) throw filesUnavailable("no-root-filesystem");
  const mounting = createMountedRuntime(source.rootfs, source.cpuProfile, source.rootTreeSha256, source.workspaceBaseSha256, startup);
  runtimeMounting = mounting;
  void mounting.catch(() => { if (runtimeMounting === mounting) runtimeMounting = undefined; });
  return mounting;
}

async function spawn(program: InitialUserspaceProgram, request: Extract<UserspaceRequest, { readonly type: "spawn" | "spawn-managed" }>): Promise<{ readonly pid: number; readonly sessionId: number; readonly identityKey: number }> {
  if (runtimeState === undefined && runtimeMounting === undefined) {
    const mounting = createMountedRuntime(request.rootfs, "x86-64-v2"); runtimeMounting = mounting;
    void mounting.catch(() => { if (runtimeMounting === mounting) runtimeMounting = undefined; });
  }
  const runtime = runtimeState ?? await runtimeMounting;
  if (runtime === undefined) throw filesUnavailable("no-root-filesystem");
  if (mount.processLimit !== undefined && processes.size >= mount.processLimit) throw new VMError("QUOTA_EXCEEDED", "Userspace process limit reached");
  const cancellation = new AbortController();
  admissionReads.set(request.id, cancellation);
  const checkCanceled = (): void => {
    if (cancellation.signal.aborted || isDisposing() || canceled.has(request.id) || runtimeState !== runtime) throw new VMError("ABORTED", "Userspace process admission cancelled");
  };
  try {
    const pid = await admitInitialUserspaceProcess(runtime, program, request, checkCanceled, async () => {
      checkCanceled();
      const read = takeHostRequest(runtime, 1);
      if (read === undefined) return false;
      await serviceHostRequest(runtime, read, cancellation.signal);
      return true;
    });
    const process = connectSpawnedProcess(runtime, pid, request.port, nativeAttachmentCommand(request.arguments[0] ?? ""), request.terminal);
    serviceHostRequests(runtime);
    return process;
  } finally { admissionReads.delete(request.id); }
}

function connectSpawnedProcess(runtime: RuntimeState, pid: number, port: MessagePort, command: string, terminal?: { readonly columns: number; readonly rows: number }): { readonly pid: number; readonly sessionId: number; readonly identityKey: number } {
  const sessionId = attachments.allocate();
  const active: ProcessState = { runtime, pid, identityKey: sessionId, sessionId, port, command,
    terminal, stdinOpen: true, sequence: 0, acknowledged: 0, awaitingAck: undefined, tail: new Uint8Array(), stopped: false };
  connectProcess(active);
  return { pid, sessionId: active.sessionId,identityKey:active.identityKey };
}

function connectProcess(active: ProcessState): void {
  const { pid, port } = active;
  processes.set(pid, active);
  port.addEventListener("message", (event: MessageEvent<unknown>) => { void checkpointGate.deliver(() => {
    if (processes.get(active.pid) === active) acknowledge(active, event.data);
  }).catch((error: unknown) => failProcess(active, error)); });
  port.addEventListener("messageerror", () => {
    void checkpointGate.deliver(() => failProcess(active, new VMError("PROTOCOL_ERROR", "Userspace process acknowledgement is malformed")))
      .catch((error: unknown) => failProcess(active, error));
  });
  port.start(); scheduleRun(active);
}

function hasNativeWork(runtime: RuntimeState | undefined): boolean {
  if (runtime === undefined) return false;
  if (processes.size + attachments.pendingCount !== 0) return true;
  const live = call(runtime.instance, "oxidevm_userspace_live_process_count");
  return nativeExecutionPending(live, live === 0 ? call(runtime.instance, "oxidevm_userspace_detached_io_pending") : 0);
}

function scheduleRun(_active: ProcessState | RuntimeState, delay = 0): void {
  const runtime = runtimeState;
  if (!checkpointGate.executionAllowed || disposing || runtime === undefined || !hasNativeWork(runtime)) return;
  if (delay === 0) {
    runtimeWakeTimer.cancel();
    if (runtimeRunScheduled) return;
    runtimeRunScheduled = true;
    if (runtime.workerRunTurns !== 0) runtime.workerYields += 1;
    postRuntimeRun(runtime);
    return;
  }
  if (runtimeRunScheduled) return;
  if (runtime.workerRunTurns !== 0) runtime.workerYields += 1;
  runtimeWakeTimer.arm(delay);
}

function run(active: RuntimeState): void {
  if (!checkpointGate.executionAllowed || disposing || runtimeState !== active || !hasNativeWork(active)) return;
  try {
    runUserspaceSlice(active, slicePorts);
  } catch (error) {
    for (const process of [...processes.values()]) failProcess(process, error);
  } finally { stdin.pump(); }
}

function servicePendingWork(active: RuntimeState, scheduleTimer: boolean): void {
  active.pendingWorkPolls += 1;
  // A child can exit while its terminal stays alive and no host request remains.
  active.jsProcesses?.retireInactive();
  const pending = decodeUserspacePendingWork(
    call(active.instance, "oxidevm_userspace_pending_work"),
  );
  if (pending.hostRequest) {
    active.hostRequestServicePolls += 1;
    serviceHostRequests(active);
  }
  if (pending.output) {
    active.outputServicePolls += 1;
    if (sendAllOutput()) {
      const generation = callUserspaceU64(
        active.instance,
        "oxidevm_userspace_pending_generation",
        USERSPACE_PENDING_OUTPUT,
      );
      assertStatus(call(
        active.instance,
        "oxidevm_userspace_pending_acknowledge",
        USERSPACE_PENDING_OUTPUT,
        generation,
      ), "acknowledge Userspace output");
    }
  }
  if (pending.processExit) {
    active.exitServicePolls += 1;
    finishCompletedProcesses();
    const generation = callUserspaceU64(
      active.instance,
      "oxidevm_userspace_pending_generation",
      USERSPACE_PENDING_PROCESS_EXIT,
    );
    assertStatus(call(
      active.instance,
      "oxidevm_userspace_pending_acknowledge",
      USERSPACE_PENDING_PROCESS_EXIT,
      generation,
    ), "acknowledge Userspace process exit");
  }
  if (pending.timer && scheduleTimer) {
    // finishResult re-arms the wake timer at this boundary; acknowledge the change here.
    const generation = callUserspaceU64(
      active.instance,
      "oxidevm_userspace_pending_generation",
      USERSPACE_PENDING_TIMER,
    );
    assertStatus(call(
      active.instance,
      "oxidevm_userspace_pending_acknowledge",
      USERSPACE_PENDING_TIMER,
      generation,
    ), "acknowledge Userspace timer");
  }
}

function scheduleNextWake(active: RuntimeState): void {
  active.timerServicePolls += 1;
  const action = wakeTimerAction(call(active.instance, "oxidevm_userspace_next_wake_ms") >>> 0);
  switch (action.kind) {
    case "none":
      runtimeWakeTimer.cancel();
      return;
    case "run-now":
      scheduleRun(active);
      return;
    case "arm":
      scheduleRun(active, action.delayMs);
      return;
  }
}

function sendAllOutput(): boolean {
  let drained = true;
  for (const process of processes.values()) {
    const awaitingAcknowledgement = process.awaitingAck !== undefined;
    const emittedOutput = !awaitingAcknowledgement && sendOutput(process);
    drained &&= shouldAcknowledgeOutputGeneration(
      awaitingAcknowledgement,
      emittedOutput,
    );
  }
  return drained;
}

function finishCompletedProcesses(): void {
  for (const process of [...processes.values()]) finishCompletedProcess(process);
}

function finishCompletedProcess(active: ProcessState): boolean {
  if (active.awaitingAck !== undefined || sendOutput(active)) return false;
  const termination = decodeUserspaceWaitStatus(call(active.runtime.instance, "oxidevm_userspace_process_wait_status", active.pid) >>> 0);
  if (termination === undefined) return false;
  postExit(active, termination);
  return true;
}

function sendOutput(active: ProcessState): boolean {
  return sendStream(active, "stdout") || sendStream(active, "stderr");
}

function sendStream(active: ProcessState, stream: "stdout" | "stderr"): boolean {
  const data = readUserspaceOutput(active.runtime, active.pid, stream);
  if (data.length === 0) return false;
  const sequence = ++active.sequence;
  active.awaitingAck = { sequence, stream, count: data.length };
  active.runtime.workerMessages += 1;
  active.port.postMessage(
    { version: PROTOCOL_VERSION, sessionId: active.sessionId, sequence, type: stream, data },
    [data.buffer],
  );
  return true;
}

function acknowledge(active: ProcessState, value: unknown): void {
  try {
    const ack = decodeGuestProcessPortAck(value);
    const pending = active.awaitingAck;
    if (processes.get(active.pid) !== active || ack.sessionId !== active.sessionId || pending === undefined || ack.sequence !== pending.sequence) {
      throw new VMError("PROTOCOL_ERROR", "Userspace process acknowledgement is stale");
    }
    const acknowledged = readUserspaceOutput(active.runtime, active.pid, pending.stream).subarray(0, pending.count);
    acknowledgeUserspaceOutput(active.runtime, active.pid, pending.stream, pending.count);
    active.tail = appendNativeTail(active.tail, acknowledged);
    active.acknowledged = pending.sequence;
    active.awaitingAck = undefined;
    active.runtime.workerMessages += 1;
    if (sendOutput(active)) return;
    const runtime = runtimeState;
    if (runtime !== undefined) servicePendingWork(runtime, false);
    if (!canResumeAfterOutputAck(active)) return;
    if (!finishCompletedProcess(active)) {
      scheduleRun(active);
      void scheduleWorkspaceCommit();
    }
  } catch (error) {
    failProcess(active, error);
  }
}

function canResumeAfterOutputAck(active: ProcessState): boolean {
  return processes.get(active.pid) === active && active.awaitingAck === undefined;
}

function finishResult(active: RuntimeState): void {
  const result = active.pendingResult;
  active.pendingResult = undefined;
  if (result?.kind === "fault") {
    for (const process of [...processes.values()]) {
      failProcess(process, new VMError("GUEST_CRASH", "Userspace runtime faulted"));
    }
  } else if (result?.kind === "step-limit") {
    if (hasNativeWork(active)) scheduleRun(active);
  } else if (result !== undefined && rearmsWakeTimer(result.kind)) {
    if (hasNativeWork(active)) scheduleNextWake(active);
    void scheduleWorkspaceCommit();
  }
}

function scheduleWorkspaceCommit(): Promise<void> {
  const root = runtimeState?.rootPersistence?.schedule();
  const workspace = workspaceCommit.schedule();
  const pending = root === undefined ? workspace : Promise.all([workspace, root]).then(() => undefined);
  void pending.catch(() => {});
  return pending;
}
function isDisposing(): boolean { return disposing; }

function configureNetwork(enabled: boolean): void {
  networkEnabled = enabled;
  const active = runtimeState;
  if (active !== undefined) {
    const operation = enabled ? "oxidevm_userspace_network_enable" : "oxidevm_userspace_network_revoke";
    assertStatus(call(active.instance, operation), operation);
  }
  if (!enabled) active?.hostService?.cancelNetwork();
  if (active !== undefined && hasNativeWork(active)) scheduleRun(active);
}

function serviceHostRequests(active: RuntimeState): void { previewRuntime.pump(); active.jsProcesses?.reconcile(); active.hostService?.pump(); }

function takeHostRequest(active: RuntimeState, mask: 1 | 2 | 4 | 8): ReturnType<typeof decodeUserspaceHostRequest> | undefined {
  const loaded = active.instance;
  assertStatus(call(loaded, "oxidevm_userspace_host_request_next", mask), "oxidevm_userspace_host_request_next");
  const length = call(loaded, "oxidevm_userspace_host_request_len");
  if (length === 0) return undefined;
  const pointer = call(loaded, "oxidevm_userspace_host_request_ptr");
  const request = decodeUserspaceHostRequest(
    new Uint8Array(active.memory.buffer, pointer, length).slice(),
  );
  active.hostRequests += 1;
  active.hostRequestBytes += BigInt(length);
  active.workerMessages += 2;
  return request;
}

async function serviceHostRequest(
  active: RuntimeState,
  request: ReturnType<typeof decodeUserspaceHostRequest>,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (request.kind === "command") {
      if (active.jsProcesses === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Command interceptor is unavailable");
      await active.jsProcesses.run(request, signal); return;
    }
    if (request.kind === "durability") {
      const record = await userspaceDurabilityCompletion(request, workspaceCommit, active.rootPersistence);
      if (signal.aborted || runtimeState !== active) return;
      await checkpointGate.deliver(() => {
        if (signal.aborted || runtimeState !== active) return;
      active.hostRequestBytes += BigInt(record.byteLength);
      assertStatus(call(active.instance, "oxidevm_userspace_staging_resize", record.byteLength), "durability staging");
      new Uint8Array(active.memory.buffer, call(active.instance, "oxidevm_userspace_staging_ptr"), record.byteLength).set(record);
      assertStatus(call(active.instance, "oxidevm_userspace_host_complete", record.byteLength), "durability completion");
      });
      return;
    }
    if (request.kind === "network") {
      const client = network;
      if (client === undefined) {
        await completeNetworkHostRequest(active, request.generation, request.id, { kind: "error", errno: 1 });
      } else {
        try {
          const completion = await client.request(request, signal);
          if (signal.aborted || runtimeState !== active || !hasNativeWork(active)) return;
          await completeNetworkHostRequest(active, request.generation, request.id, completion);
        } catch (error: unknown) {
          if (signal.aborted || runtimeState !== active || !hasNativeWork(active)) return;
          await completeNetworkHostRequest(active, request.generation, request.id, { kind: "error", errno: networkErrno(error) });
        }
      }
      return;
    }
    const client = storage;
    if (client === undefined) {
      await completeHostRequest(active, request.generation, request.id, { kind: "io" });
    } else {
      try {
        const response = request.offset !== 0 || request.length !== request.expectedBytes
          ? await readRangedBytes(active, client, request, signal)
          : active.rootTreeSha256 === undefined
            ? await client.readRootfs(request.path, signal)
            : await readManagedBytes(
              client,
              active.rootTreeSha256,
              request.path,
              request.expectedSha256,
              cacheableManagedPath(request.path),
              signal,
            );
        if (runtimeState !== active) return;
        if (response.bytes.byteLength !== request.length) {
          throw new VMError("PROTOCOL_ERROR", "managed rootfs response length does not match its host request");
        }
        await completeHostRequest(active, request.generation, request.id, {
          kind: "ok",
          bytes: response.bytes,
          ...(request.expectedSha256 === undefined ? {} : { sha256: response.sha256 }),
        });
      } catch (error) {
        const kind = error instanceof VMError && error.code === "STORAGE_NOT_FOUND"
          ? "not-found"
          : error instanceof VMError && error.code === "ABORTED"
            ? "aborted"
            : "io";
        if (runtimeState !== active) return;
        await completeHostRequest(active, request.generation, request.id, { kind });
      }
    }
  } catch (error) {
    if (runtimeState === active) for (const process of [...processes.values()]) failProcess(process, error);
  }
}

async function completeNetworkHostRequest(
  active: RuntimeState,
  generation: bigint,
  id: bigint,
  completion: Parameters<typeof encodeUserspaceNetworkHostCompletion>[2],
): Promise<void> {
  await checkpointGate.deliver(() => {
    if (runtimeState !== active) return;
  const loaded = active.instance;
  const record = encodeUserspaceNetworkHostCompletion(generation, id, completion);
  active.hostRequestBytes += BigInt(record.byteLength);
  assertStatus(call(loaded, "oxidevm_userspace_staging_resize", record.byteLength), "oxidevm_userspace_staging_resize");
  const pointer = call(loaded, "oxidevm_userspace_staging_ptr");
  new Uint8Array(active.memory.buffer, pointer, record.byteLength).set(record);
  assertStatus(call(loaded, "oxidevm_userspace_host_complete", record.byteLength), "oxidevm_userspace_host_complete");
  });
}

async function completeHostRequest(
  active: RuntimeState,
  generation: bigint,
  id: bigint,
  completion: Parameters<typeof encodeUserspaceHostCompletion>[2],
): Promise<void> {
  await checkpointGate.deliver(() => {
    if (runtimeState !== active) return;
  const loaded = active.instance;
  const record = encodeUserspaceHostCompletion(generation, id, completion);
  active.hostRequestBytes += BigInt(record.byteLength);
  assertStatus(call(loaded, "oxidevm_userspace_staging_resize", record.byteLength), "oxidevm_userspace_staging_resize");
  const pointer = call(loaded, "oxidevm_userspace_staging_ptr");
  new Uint8Array(active.memory.buffer, pointer, record.byteLength).set(record);
  assertStatus(call(loaded, "oxidevm_userspace_host_complete", record.byteLength), "oxidevm_userspace_host_complete");
  });
}

function writeStdin(active: ProcessState, data: Uint8Array): number {
  return writeUserspaceStdin(active.runtime, active.pid, data, () => scheduleRun(active));
}

function closeStdin(active: ProcessState): void {
  active.stdinOpen = false;
  // Output backpressure can retain the browser process after Rust has reaped it.
  if ((call(active.runtime.instance, "oxidevm_userspace_process_exit_status", active.pid) >>> 0) !== 0xffff_ffff) return;
  assertStatus(call(active.runtime.instance, "oxidevm_userspace_process_stdin_close", active.pid), "oxidevm_userspace_process_stdin_close");
  scheduleRun(active);
}

function sendSignal(active: ProcessState, signal: number): void {
  assertStatus(call(active.runtime.instance, "oxidevm_userspace_process_signal", active.pid, signal), "oxidevm_userspace_process_signal");
  scheduleRun(active);
}

function postExit(
  active: ProcessState,
  termination: { readonly kind: "exit"; readonly code: number } | { readonly kind: "signal"; readonly signal: number },
): void {
  active.runtime.jsProcesses?.reconcile();
  active.stopped = true;
  stdin.rejectProcess(active.pid, new VMError("GUEST_CRASH", "Userspace process closed stdin"));
  active.port.postMessage({
    version: PROTOCOL_VERSION,
    sessionId: active.sessionId,
    sequence: ++active.sequence,
    type: "exit",
    termination,
  });
  active.runtime.workerMessages += 1;
  active.port.close();
  processes.delete(active.pid);
  retireOrDispose(active);
  if (!hasNativeWork(active.runtime)) {
    runtimeWakeTimer.cancel();
    runtimeRunScheduled = false;
  }
}

function failProcess(active: ProcessState, error: unknown): void {
  if (processes.get(active.pid) !== active || active.stopped) return;
  active.stopped = true;
  stdin.rejectProcess(active.pid, error);
  active.port.postMessage({
    version: PROTOCOL_VERSION,
    sessionId: active.sessionId,
    sequence: ++active.sequence,
    type: "error",
    error: serializeUnknownError(error),
  });
  active.runtime.workerMessages += 1;
  active.port.close();
  processes.delete(active.pid);
  retireOrDispose(active);
}

function retireOrDispose(active: ProcessState): void {
  if (mount.syscallTraceCapacity !== 0) {
    if (!completedSyscallTraces.has(active.pid) && completedSyscallTraces.size === MAX_COMPLETED_TRACES) {
      const oldest = completedSyscallTraces.keys().next().value;
      if (oldest !== undefined) completedSyscallTraces.delete(oldest);
    }
    completedSyscallTraces.set(active.pid, readUserspaceSyscallTrace(active.runtime));
  }
  if (!completedExecutionProfiles.has(active.pid) && completedExecutionProfiles.size === MAX_COMPLETED_TRACES) {
    const oldest = completedExecutionProfiles.keys().next().value;
    if (oldest !== undefined) completedExecutionProfiles.delete(oldest);
  }
  completedExecutionProfiles.set(active.pid, captureExecutionProfile(active));
  if ((previewReferences.get(active.pid) ?? 0) !== 0) retiredProcesses.set(active.pid, active);
}

/** The JIT left `active`: guest processes keep running, so say so once in the console. */
function warnJitDegraded(degradation: JitDegradation): void {
  console.warn("oxidevm: Tier-1 JIT degraded", jitDegradationWarning("userspace", degradation));
}


function releasePreviewReference(pid: number): void {
  const references = previewReferences.get(pid);
  if (references === undefined) return;
  if (references > 1) {
    previewReferences.set(pid, references - 1);
    return;
  }
  previewReferences.delete(pid);
  const retired = retiredProcesses.get(pid);
  if (retired !== undefined) {
    retiredProcesses.delete(pid);
  }
}

function requireProcess(pid: number): ProcessState {
  const active = processes.get(pid);
  if (active === undefined) throw new VMError("INVALID_ARGUMENT", "Userspace process is not active");
  return active;
}

function requireGeneration(pid: number, sessionId: number): ProcessState {
  const active = requireProcess(pid);
  if (active.sessionId !== sessionId) throw new VMError("PROTOCOL_ERROR", "stale process generation");
  return active;
}


function signalNumber(signal: "TERM" | "KILL" | "INT" | "HUP"): number {
  switch (signal) {
    case "HUP": return 1;
    case "INT": return 2;
    case "KILL": return 9;
    case "TERM": return 15;
  }
}

function respondError(id: number, error: unknown): void {
  self.postMessage({ id, version: PROTOCOL_VERSION, ok: false, error: serializeUnknownError(error) });
}
