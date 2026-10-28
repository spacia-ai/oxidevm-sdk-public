import { AgentFiles } from "./agent-files.js";
import { CaptureProgressEvents } from "./capture-progress.js";
import { requireKnownAgentCapabilities } from "../../agent-protocol.js";
import { decodeInstallationEvent, type InstallationEvent } from "../../protocol/assistance-installation-event.js";
import type { RegistryBinding } from "../../protocol/registry.js";
import { encodeInstallationBootstrap, encodeInstallationRequest, type InstallationBootstrap, type InstallationRequest } from "../../protocol/assistance-installation.js";
import { decodeInstallationReply, installationReplyMatches, type InstallationReply } from "../../protocol/assistance-installation-reply.js";
import { requireWorkspaceDialect } from "../../workspace-record.js";
import { encodeAssistanceCredit, matchAssistanceCreditReply, type AssistanceCredit } from "../../protocol/assistance-credit.js";
import { AgentInput } from "./agent-input.js";
import { AgentListeners } from "./agent-listeners.js";
import { AgentRestore, type GuestRestoreTransfer } from "./agent-restore.js";
import { AgentCaptureProgress, openAgentCapture } from "./agent-capture.js";
import { encodeWorkspaceCapture, type WorkspaceCaptureProgress } from "../../protocol/workspace-capture.js";
import type { WorkspaceRestoreTarget } from "../../protocol/workspace-restore.js";
import type { WorkspaceStreamInput } from "../workspace-stream.js";
import { encodeWorkspaceRestore, decodeRestoreBegun, decodeRestoreStatus } from "../../protocol/workspace-restore.js";
import {
  AGENT_RESEED_BYTES,
  AGENT_RESPONSE_BIT,
  AgentCapability,
  AgentFrameDecoder,
  type AgentFrame,
  type AgentProtocolVersion,
  AgentKind,
  AgentPayloadReader,
  AgentPayloadWriter,
  decodeAgentWorkspaceManifest,
  type AgentWorkspaceManifestEntry,
} from "../../agent-protocol.js";
import { decodeCpuSnapshot } from "../../core-abi.js";
import type { DiskBridgeClient } from "../../disk-bridge.js";
import type { SessionDiagnostics } from "./system-session.js";
import { VMError, serializeUnknownError } from "../../errors.js";
import { AgentProcesses } from "./agent-processes.js";
import { AgentRequests } from "./agent-requests.js";
import type { AgentResumeState } from "./agent-resume-state.js";
import { type CommandAgent, runAgentCommand } from "./agent-command.js";
import { refreshRestoredGuest } from "./guest-refresh.js";
import { conflictCommand, type ReconcileAgent } from "./workspace-reconcile.js";
import { encodeAssistanceRequest, type AssistanceRequest } from "../../protocol/assistance.js";
import { decodeAssistanceReply, matchAssistanceReply, type AssistanceReply } from "../../protocol/assistance-reply.js";
import { decodeAssistanceEvent, type AssistanceEvent } from "../../protocol/assistance-event.js";
import { encodeAssistanceVmRequest, matchAssistanceVmReply, type AssistanceVmRequest } from "../../protocol/assistance-vm.js";
import {
  type AgentHello,
  type ControlRequest,
  type CoreProbeExit,
  PROTOCOL_VERSION,
} from "../../protocol.js";
import { TextDecoder } from "../../web-encoding.js";
import {
  type Core,
  callNumber,
  memorySlice,
  readRecord,
  stage,
} from "./core.js";
import { runtimeStats } from "./trace.js";

const AGENT_CHUNK_BYTES = 64 * 1024;
/** How long a WATCH_LISTENERS reply and a restarted agent's greeting may take. */
const LISTENER_REQUEST_MILLISECONDS = 60_000;
const agentErrorDecoder = new TextDecoder("utf-8", { fatal: true });

export class GuestAgent {
  private core: Core | undefined;
  private workspaceFailure: VMError | undefined;
  private readonly pendingInput = new AgentInput();
  private decoder = new AgentFrameDecoder();
  private hello: AgentHello | undefined;
  /** The HELLO capability bits, kept for a snapshot's resume state. */
  private capabilities = 0;
  /** Set when a restored session cannot continue the agent stream; requests fail with it. */
  private unavailable: VMError | undefined;
  private ready = false;
  private dialect: AgentProtocolVersion | undefined;
  private assistanceAvailable = false;
  private forkAvailable = false;
  private listenersAvailable = false;
  private assistanceEvents: ((event: AssistanceEvent) => void) | undefined;
  private installationEvents: { readonly binding: RegistryBinding; readonly receive: (event: InstallationEvent) => void; sequence: number } | undefined;
  private awaitingReady = false;
  private readonly pendingRequests = new AgentRequests();
  private readonly captureProgress = new AgentCaptureProgress();
  private readonly legacyCaptureProgress = new CaptureProgressEvents();
  private readonly restoration = new AgentRestore(
    (id, format, bytes) => this.openWorkspaceRestore(id, format, bytes),
    error => this.failWorkspaceRestore(error),
    undefined,
    (format, header) => {
      if (typeof format === "string") requireWorkspaceDialect(header, this.dialect, format === "snapshot" ? "OXRF" : "OXWD", this.capabilities);
    },
  );
  private readonly listeners = new AgentListeners({
    begin: (payload) => this.beginListenerWatch(payload),
    greet: async () => { await this.wait(0, LISTENER_REQUEST_MILLISECONDS); },
    belowFloor: (id) => this.pendingRequests.belowFloor(id),
    dropped: () => { this.pendingRequests.drop(); },
  });
  readonly files = new AgentFiles({
    request: async (id, kind, payload) => (await this.request(id, kind, payload)).payload,
    begin: payload => this.beginListenerWatch(payload, AgentKind.watchEntries),
    greet: async () => { await this.wait(0, LISTENER_REQUEST_MILLISECONDS); },
    belowFloor: id => this.pendingRequests.belowFloor(id),
    dropped: () => { this.pendingRequests.drop(); },
  });
  private readonly processes = new AgentProcesses({
    core: () => this.requireCore(),
    diskBridge: () => this.diskBridge(),
    consoleTail: () => this.consoleTail(),
    session: () => this.session(),
  });

  constructor(
    private readonly pump: (
      workerRequestId: number,
      deadline: number,
    ) => Promise<CoreProbeExit | undefined>,
    private readonly abortIfCanceled: (workerRequestId: number) => void,
    private readonly diskBridge: () => DiskBridgeClient | undefined,
    private readonly consoleTail: () => string,
    private readonly session: () => SessionDiagnostics,
    private readonly restoreFailed: (error: VMError) => void,
  ) {}

  private hasExecutionPump(): boolean {
    return this.session().active;
  }

  assertWorkspaceHealthy(): void {
    if (this.workspaceFailure !== undefined) throw this.workspaceFailure;
  }

  cancel(workerRequestId: number): void {
    this.restoration.cancel(workerRequestId);
    this.pendingRequests.cancelWorker(workerRequestId);
  }

  executionStopped(error: unknown = new VMError("GUEST_CRASH", "guest execution stopped before agent completion")): void {
    this.restoration.stop(error);
    this.captureProgress.clear();
    this.legacyCaptureProgress.clear();
    const failure = serializeUnknownError(error);
    this.pendingRequests.failPending(new VMError(failure.code, failure.message, failure.detail));
  }

  /** Replies that completed a waiting host request (`agent-requests.ts`). */
  get responses(): number {
    return this.pendingRequests.completed;
  }

  get hasPendingInput(): boolean {
    return this.pendingInput.hasPending;
  }

  activate(loaded: Core): void {
    this.core = loaded;
  }

  /** The guest's listening ports for the page (capability 64). */
  get listenerWatch(): AgentListeners {
    return this.listeners;
  }

  /** Frames dropped because they belonged to the session before a restore. */
  get droppedFrames(): number {
    return this.pendingRequests.dropped;
  }

  /**
   * The host side of this agent session at a snapshot's cut (OXHA): call it while the VM is
   * frozen, after the agent output has been drained.
   */
  resumeState(consoleTail: Uint8Array): AgentResumeState {
    const nextRequestId = this.pendingRequests.nextId;
    if (!this.ready || this.dialect === undefined) {
      return {
        dialect: null, capabilities: 0, nextRequestId, inbound: new Uint8Array(), inboundSkip: 0,
        inboundLost: false, outbound: new Uint8Array(), outboundSequence: 0, processes: [], consoleTail,
      };
    }
    const inbound = this.decoder.resumeInbound();
    const outbound = this.pendingInput.resumeOutbound();
    return {
      dialect: this.dialect,
      capabilities: this.capabilities,
      nextRequestId,
      inbound: inbound?.bytes ?? new Uint8Array(),
      inboundSkip: inbound?.skip ?? 0,
      inboundLost: inbound === undefined,
      outbound: outbound.remainder,
      outboundSequence: outbound.sequence,
      processes: this.processes.adoptable(),
      consoleTail,
    };
  }

  /**
   * Continues the session a restored guest is in, instead of waiting for a READY its agent will
   * not send again: the stream picks up mid-frame, replies to requests from before the cut are
   * dropped, and the processes it relayed wait for a page to attach. The next `wait` greets the
   * agent without waiting for READY.
   */
  resume(loaded: Core, state: AgentResumeState): void {
    this.reset();
    this.files.agentGone("resumed");
    this.listeners.agentGone("resumed");
    this.core = loaded;
    if (state.dialect === null) return;
    if (state.inboundLost) {
      this.unavailable = new VMError("GUEST_CRASH", "The guest agent cannot reconnect after this restore; restart Linux", {
        reason: "agent-unavailable",
      });
      return;
    }
    this.decoder = AgentFrameDecoder.resume(state.inbound, state.inboundSkip);
    this.pendingInput.resume(state.outbound, state.outboundSequence);
    this.pendingRequests.resume(state.nextRequestId);
    this.processes.adopt(state.processes);
    this.dialect = state.dialect;
    this.capabilities = state.capabilities;
    // Events of the subscription held at the cut are dropped by request id until the agent greets.
    this.listenersAvailable = state.dialect === 7 && (state.capabilities & AgentCapability.listeners) !== 0;
    this.ready = true;
  }

  /**
   * Waits up to `milliseconds` for the agent stream to rest at a frame boundary (no request
   * pending, no input queued, nothing half received), so a snapshot rarely cuts through a frame.
   * A stream that does not rest is recorded mid-frame instead.
   */
  async quiesce(milliseconds: number): Promise<void> {
    const deadline = performance.now() + milliseconds;
    while (this.ready && !this.atRest() && performance.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 2);
      });
    }
  }

  private atRest(): boolean {
    return this.pendingRequests.size === 0 && !this.pendingInput.hasPending && this.decoder.idle;
  }

  /** Gives a restored process a page; returns its pid and session. */
  attach(agentRequestId: number, port: MessagePort): { readonly pid: number; readonly sessionId: number } {
    if (this.unavailable !== undefined) throw this.unavailable;
    return this.processes.attach(agentRequestId, port);
  }

  reset(): void {
    this.restoration.stop(new VMError("ABORTED", "Guest generation was replaced during restoration"));
    this.processes.closeAll();
    this.pendingRequests.reset();
    this.captureProgress.clear();
    this.legacyCaptureProgress.clear();
    this.pendingInput.clear();
    this.decoder = new AgentFrameDecoder();
    this.hello = undefined;
    this.capabilities = 0;
    this.unavailable = undefined;
    this.ready = false;
    this.dialect = undefined;
    this.assistanceAvailable = false;
    this.forkAvailable = false;
    this.listenersAvailable = false;
    this.assistanceEvents = undefined;
    this.installationEvents = undefined;
    this.awaitingReady = false;
    this.core = undefined;
    this.listeners.agentGone("replaced");
    this.files.agentGone("replaced");
  }

  async wait(
    workerRequestId: number,
    timeoutMilliseconds: number,
  ): Promise<AgentHello> {
    if (this.unavailable !== undefined) throw this.unavailable;
    const deadline = performance.now() + timeoutMilliseconds;
    this.awaitingReady = true;
    try {
      while (!this.ready) {
        this.abortIfCanceled(workerRequestId);
        if (performance.now() >= deadline) {
          throw this.timeout("guest agent did not announce readiness");
        }
        const exit = await this.pump(workerRequestId, deadline);
        if (exit !== undefined && exit.kind !== "step-limit") {
          const detail =
            exit.kind === "reset" ? `${exit.kind}:${exit.reason}` : exit.kind;
          const tail = this.consoleTail().slice(-4096).trim();
          throw new VMError(
            "GUEST_CRASH",
            `guest stopped before agent readiness (${detail})${
              tail === "" ? "" : `; console tail:\n${tail}`
            }`,
          );
        }
      }
    } finally {
      this.awaitingReady = false;
    }
    const frame = await this.request(
      workerRequestId,
      AgentKind.hello,
      new Uint8Array(),
      Math.max(1, deadline - performance.now()),
    );
    const payload = new AgentPayloadReader(frame.payload);
    const version = payload.string();
    const capabilities = payload.u32();
    payload.finish();
    // Bit 2 was advertised by managed images with the retired CPU-hotplug path.
    // Bits 16 (fork, set after the boot probe's round trip), 32 (resume) 64 (listeners) and 128 (native files) exist
    // only in guest 7.
    requireKnownAgentCapabilities(capabilities, this.dialect);
    const hello = {
      version,
      capabilities: {
        files: (capabilities & 1) !== 0,
        processes: (capabilities & 2) !== 0,
      },
    };
    if (!hello.capabilities.files || !hello.capabilities.processes) {
      throw new VMError(
        "FEATURE_NOT_AVAILABLE",
        "managed image agent lacks required file or process capabilities",
      );
    }
    this.hello = hello;
    this.capabilities = capabilities;
    this.assistanceAvailable = (this.dialect === 6 || this.dialect === 7) && (capabilities & 8) !== 0;
    this.forkAvailable = this.dialect === 7 && this.assistanceAvailable && (capabilities & 16) !== 0;
    this.listenersAvailable = this.dialect === 7 && (capabilities & AgentCapability.listeners) !== 0;
    this.listeners.agentReady(this.listenersAvailable);
    this.files.agentReady(this.dialect === 7 && (capabilities & AgentCapability.files2) !== 0);
    return hello;
  }

  async readFile(
    workerRequestId: number,
    path: string,
  ): Promise<Uint8Array<ArrayBuffer>> {
    this.requireCapability("files");
    const frame = await this.request(
      workerRequestId,
      AgentKind.readFile,
      new AgentPayloadWriter().string(path).finish(),
    );
    return frame.payload;
  }

  get supportsAssistance(): boolean { return this.assistanceAvailable; }
  /** Guest-7 fork pairing, proven by the agent's boot probe on this guest. */
  get supportsFork(): boolean { return this.forkAvailable; }
  /** Whether the greeting agent reports listening ports (capability 64). */
  get supportsListeners(): boolean { return this.listenersAvailable; }
  get supportsStreamedRestore(): boolean { return this.dialect === 7; }
  get assistanceVersion(): 4 | 5 | 6 | 7 | undefined {
    return this.assistanceAvailable && (this.dialect === 4 || this.dialect === 5 || (this.dialect === 6 || this.dialect === 7)) ? this.dialect : undefined;
  }

  async checkAssistanceHealth(): Promise<void> {
    if (!this.hasExecutionPump() || !this.assistanceAvailable) throw new VMError("GUEST_CRASH", "Assistance lost its guest transport");
    const version = this.hello?.version;
    const hello = await this.wait(0, 60_000);
    if (!this.supportsAssistance || hello.version !== version) throw new VMError("PROTOCOL_ERROR", "Guest assistance identity changed during execution");
  }

  setAssistanceEvents(receive: ((event: AssistanceEvent) => void) | undefined): void {
    this.assistanceEvents = receive;
  }

  setInstallationEvents(binding: RegistryBinding | undefined, receive?: (event: InstallationEvent) => void): void {
    if (binding === undefined) { this.installationEvents = undefined; return; }
    if (!this.hasExecutionPump() || !this.assistanceAvailable || (this.dialect !== 6 && this.dialect !== 7) || receive === undefined || this.installationEvents !== undefined) {
      throw new VMError("PROTOCOL_ERROR", "Cannot attach installation events");
    }
    this.installationEvents = { binding: { ...binding }, receive, sequence: 0 };
  }

  async superviseAssistance(workerRequestId: number, request: AssistanceVmRequest): Promise<void> {
    if (!this.hasExecutionPump() || !this.assistanceAvailable || (this.dialect !== 6 && this.dialect !== 7)) {
      throw new VMError("FEATURE_NOT_AVAILABLE", "VM-scoped assistance supervision requires an active protocol-v6/v7 guest");
    }
    const frame = await this.request(workerRequestId, AgentKind.assistanceVm, encodeAssistanceVmRequest(request), 60_000);
    matchAssistanceVmReply(request, frame.payload);
  }

  async creditAssistance(workerRequestId: number, credit: AssistanceCredit): Promise<AssistanceCredit> {
    if (!this.hasExecutionPump() || !this.assistanceAvailable || (this.dialect !== 6 && this.dialect !== 7)) {
      throw new VMError("FEATURE_NOT_AVAILABLE", "Assistance producer credits require an active protocol-v6/v7 guest");
    }
    const frame = await this.request(workerRequestId, AgentKind.assistanceCredit, encodeAssistanceCredit(credit, this.dialect), 60_000);
    return matchAssistanceCreditReply(credit, frame.payload, this.dialect);
  }

  async startInstallation(workerRequestId: number, bootstrap: InstallationBootstrap): Promise<InstallationReply> {
    const version = this.requireInstallation();
    const frame = await this.request(workerRequestId, AgentKind.installationStart, encodeInstallationBootstrap(bootstrap, version), 60_000);
    const reply = decodeInstallationReply(frame.payload, frame.version);
    if (!installationReplyMatches(bootstrap.request, reply)) throw new VMError("PROTOCOL_ERROR", "Installation startup reply identity mismatch");
    return reply;
  }

  async installation(workerRequestId: number, request: InstallationRequest): Promise<InstallationReply> {
    const version = this.requireInstallation();
    if (request.operation.kind === "start") throw new VMError("PROTOCOL_ERROR", "Installation startup requires issued bootstrap grants");
    const frame = await this.request(workerRequestId, AgentKind.installationIo, encodeInstallationRequest(request, version),
      request.operation.kind === "stop" || request.operation.kind === "retire" || request.operation.kind === "acknowledge" ? 60_000 : null);
    const reply = decodeInstallationReply(frame.payload, frame.version);
    if (!installationReplyMatches(request, reply)) throw new VMError("PROTOCOL_ERROR", "Installation reply identity mismatch");
    return reply;
  }

  private requireInstallation(): 6 | 7 {
    if (!this.hasExecutionPump() || !this.assistanceAvailable || (this.dialect !== 6 && this.dialect !== 7)) {
      throw new VMError("FEATURE_NOT_AVAILABLE", "Installation transport requires an active protocol-v6/v7 guest");
    }
    return this.dialect;
  }

  async assistance(workerRequestId: number, request: AssistanceRequest): Promise<AssistanceReply> {
    if (!this.hasExecutionPump()) throw new VMError("FEATURE_NOT_AVAILABLE", "Assistance requires the active system execution pump");
    if (!this.assistanceAvailable) throw new VMError("FEATURE_NOT_AVAILABLE", "Assistance requires protocol-v6/v7 task services; rebuild the assistance development image");
    if (request.operation.kind === "check-dependencies" && this.dialect !== 7) throw new VMError("FEATURE_NOT_AVAILABLE", "Dependency admission requires a protocol-v7 guest");
    if ((request.operation.kind === "getcwd" || request.operation.kind === "chdir" || request.operation.kind === "access" || request.operation.kind === "readdir-entries" || request.operation.kind.startsWith("socket-") || request.operation.kind.startsWith("watch-")) && this.dialect !== 7) throw new VMError("FEATURE_NOT_AVAILABLE", "Process cwd, access, directory metadata, socket and watcher operations require a protocol-v7 guest");
    const frame = await this.request(workerRequestId, AgentKind.assistance, encodeAssistanceRequest(request),
      request.operation.kind === "start" || request.operation.kind === "stop" ? 60_000 : null);
    if (frame.version !== 4 && frame.version !== 5 && frame.version !== 6 && frame.version !== 7) throw new VMError("PROTOCOL_ERROR", "Invalid assistance reply dialect");
    const reply = decodeAssistanceReply(frame.payload, frame.version);
    matchAssistanceReply(request, reply);
    return reply;
  }

  async writeFile(
    workerRequestId: number,
    path: string,
    data: Uint8Array,
  ): Promise<void> {
    this.requireCapability("files");
    const frame = await this.request(
      workerRequestId,
      AgentKind.writeFile,
      new AgentPayloadWriter().string(path).bytes(data).finish(),
    );
    expectEmptyAgentPayload(frame);
  }

  async list(
    workerRequestId: number,
    path: string,
  ): Promise<
    {
      readonly kind: "file" | "directory" | "symlink";
      readonly name: string;
      readonly path: string;
    }[]
  > {
    this.requireCapability("files");
    const frame = await this.request(
      workerRequestId,
      AgentKind.listDirectory,
      new AgentPayloadWriter().string(path).finish(),
    );
    const payload = new AgentPayloadReader(frame.payload);
    const count = payload.u32();
    if (count > 1_000_000) {
      throw new VMError("PROTOCOL_ERROR", "guest directory is too large");
    }
    const base = path === "/" ? "" : path.replace(/\/+$/, "");
    const entries: {
      readonly kind: "file" | "directory" | "symlink";
      readonly name: string;
      readonly path: string;
    }[] = [];
    for (let index = 0; index < count; index += 1) {
      const rawKind = payload.u8();
      const kind =
        rawKind === 1
          ? "file"
          : rawKind === 2
            ? "directory"
            : rawKind === 3
              ? "symlink"
              : undefined;
      if (kind === undefined) {
        throw new VMError(
          "PROTOCOL_ERROR",
          "guest directory entry kind is invalid",
        );
      }
      const name = payload.string();
      if (
        name.length === 0 ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\0")
      ) {
        throw new VMError(
          "PROTOCOL_ERROR",
          "guest directory entry name is invalid",
        );
      }
      entries.push({ kind, name, path: `${base}/${name}` });
    }
    payload.finish();
    return entries;
  }

  async workspaceManifest(
    workerRequestId: number,
  ): Promise<Uint8Array<ArrayBuffer>> {
    this.requireCapability("files");
    const frame = await this.request(
      workerRequestId,
      AgentKind.workspaceManifest,
      new Uint8Array(),
    );
    return frame.payload;
  }

  async workspaceDelta(workerRequestId: number): Promise<Uint8Array<ArrayBuffer>> {
    this.requireCapability("files");
    const frame = await this.request(
      workerRequestId,
      AgentKind.workspaceDelta,
      new Uint8Array(),
    );
    return frame.payload;
  }

  applyWorkspace(workerRequestId: number, data: Uint8Array): Promise<void> {
    return this.applyWorkspaceRecord(workerRequestId, data, "OXRF", AgentKind.applyWorkspace);
  }

  applyWorkspaceDelta(workerRequestId: number, data: Uint8Array): Promise<void> {
    return this.applyWorkspaceRecord(workerRequestId, data, "OXWD", AgentKind.applyWorkspaceDelta);
  }

  async applyWorkspaceStream(workerRequestId: number, format: WorkspaceRestoreTarget, input: WorkspaceStreamInput): Promise<void> {
    this.requireCapability("files");
    if (this.dialect !== 7) throw new VMError("FEATURE_NOT_AVAILABLE", "Streamed restoration requires guest protocol v7");
    this.abortIfCanceled(workerRequestId);
    await this.restoration.apply(workerRequestId, format, input, header => requireWorkspaceDialect(header, this.dialect,
      format === "delta" ? "OXWD" : "OXRF", this.capabilities));
  }

  async captureWorkspace(workerRequestId: number, format: "snapshot" | "delta", signal: AbortSignal,
    receiveProgress: (event?: WorkspaceCaptureProgress) => void = () => {}) {
    this.requireCapability("files");
    if (this.dialect !== 7) throw new VMError("FEATURE_NOT_AVAILABLE", "Streamed capture requires guest protocol v7");
    this.abortIfCanceled(workerRequestId);
    const loaded = this.requireCore();
    // Keep the native receipt live across caller cancellation. The independent
    // abort is acknowledged before this source releases ownership.
    let retired = () => {};
    let transfer: number;
    try {
      transfer = this.beginRequest(AgentKind.workspaceCapture, id => {
        if ((this.capabilities & AgentCapability.workspaceCaptureProgress) !== 0) retired = this.captureProgress.open(id, receiveProgress);
        else if ((this.capabilities & AgentCapability.captureProgress) !== 0) {
          this.legacyCaptureProgress.open(id, () => receiveProgress());
          retired = () => this.legacyCaptureProgress.retire(id);
        }
        return encodeWorkspaceCapture({ kind: "begin", transfer: id, format }, 7);
      }, 0);
    } catch (error) { retired(); throw error; }
    const ready = this.awaitResponse(0, transfer, null)
      .then(frame => checkedAgentResponse(frame, AgentKind.workspaceCapture).payload);
    return openAgentCapture(ready, async operation => {
      if (this.core !== loaded || this.dialect !== 7) throw new VMError("ABORTED", "Guest capture generation was replaced");
      return (await this.request(0, AgentKind.workspaceCapture, encodeWorkspaceCapture({ ...operation, transfer }, 7), null)).payload;
    }, signal, retired).catch((error: unknown) => {
      if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) throw this.failWorkspaceRestore(error);
      throw error;
    });
  }

  private openWorkspaceRestore(workerRequestId: number, format: WorkspaceRestoreTarget, bytes: number): GuestRestoreTransfer {
    const loaded = this.requireCore();
    this.abortIfCanceled(workerRequestId);
    const transfer = this.beginRequest(AgentKind.workspaceRestore,
      id => encodeWorkspaceRestore(typeof format === "string" ? { kind: "begin", transfer: id, format, bytes }
        : { kind: "begin-dependencies", transfer: id, bytes, generation: format.generation, inputs: format.inputs }, 7), workerRequestId);
    return { transfer,
      ready: this.awaitResponse(workerRequestId, transfer, 60_000)
        .then(frame => decodeRestoreBegun(checkedAgentResponse(frame, AgentKind.workspaceRestore).payload, typeof format !== "string")),
      send: async (id, operation) => {
        if (this.core !== loaded || this.dialect !== 7) throw new VMError("ABORTED", "Guest restore generation was replaced");
        expectEmptyAgentPayload(await this.request(id, AgentKind.workspaceRestore, encodeWorkspaceRestore(operation, 7)));
      },
      status: async id => {
        if (this.core !== loaded || this.dialect !== 7) throw new VMError("ABORTED", "Guest restore generation was replaced");
        const frame = await this.request(id, AgentKind.workspaceRestore, encodeWorkspaceRestore({ kind: "status", transfer }, 7));
        return decodeRestoreStatus(checkedAgentResponse(frame, AgentKind.workspaceRestore).payload);
      },
    };
  }

  private async applyWorkspaceRecord(workerRequestId: number, data: Uint8Array,
    magic: "OXRF" | "OXWD", kind: number): Promise<void> {
    this.requireCapability("files");
    requireWorkspaceDialect(data, this.dialect, magic, this.capabilities);
    this.abortIfCanceled(workerRequestId);
    try {
      const frame = await this.request(workerRequestId, kind, new Uint8Array(data));
      expectEmptyAgentPayload(frame);
    } catch (error) {
      // Legacy replies cannot prove rollback or distinguish a committed rename
      // from failed cleanup. Reusing this generation could persist partial state.
      throw this.failWorkspaceRestore(error);
    }
  }

  private failWorkspaceRestore(error: unknown): VMError {
    if (this.workspaceFailure === undefined) {
      this.workspaceFailure = new VMError("GUEST_CRASH",
        "Workspace restoration failed; reopen the VM before further operations",
        { cause: serializeUnknownError(error) });
      this.pendingRequests.failPending(this.workspaceFailure);
      this.restoreFailed(this.workspaceFailure);
    }
    return this.workspaceFailure;
  }

  async remove(
    workerRequestId: number,
    path: string,
    recursive: boolean,
  ): Promise<void> {
    this.requireCapability("files");
    const frame = await this.request(
      workerRequestId,
      AgentKind.remove,
      new AgentPayloadWriter()
        .u8(recursive ? 1 : 0)
        .string(path)
        .finish(),
    );
    expectEmptyAgentPayload(frame);
  }

  async spawn(
    request: Extract<ControlRequest, { type: "agent-spawn" }>,
  ): Promise<{ readonly pid: number; readonly sessionId: number }> {
    this.requireCapability("processes");
    const payload = new AgentPayloadWriter()
      .string(request.command)
      .string(request.cwd)
      .u32(request.args.length);
    for (const argument of request.args) payload.string(argument);
    const environment = Object.entries(request.env);
    payload.u32(environment.length);
    for (const [key, value] of environment) {
      payload.string(key).string(value);
    }
    if (request.terminal === undefined) {
      payload.u8(0);
    } else {
      payload.u8(1).u32(request.terminal.columns).u32(request.terminal.rows);
    }

    if (request.guestPaths === true && (this.capabilities & AgentCapability.processControl) === 0) throw new VMError("FEATURE_NOT_AVAILABLE", "guest-path process creation requires updated guest integration", { reason: "image-update-required" });
    const requestKind = request.guestPaths === true ? AgentKind.guestSpawn : AgentKind.spawn;
    const agentRequestId = this.beginRequest(requestKind, payload.finish(), request.id);
    const loaded = this.requireCore();
    if (loaded.traceCapacity !== 0 && loaded.traceFreeze === undefined) {
      loaded.traceCheckpoint = undefined;
    }
    const session = this.processes.open(
      agentRequestId,
      request.port,
      request.terminal !== undefined,
      [request.command, ...request.args].join(" "),
    );
    try {
      const frame = await this.awaitResponse(
        request.id,
        agentRequestId,
        60_000,
      );
      const response = checkedAgentResponse(frame, requestKind);
      const responsePayload = new AgentPayloadReader(response.payload);
      const pid = responsePayload.u32();
      responsePayload.finish();
      this.processes.started(session, pid);
      this.requireCore().traceProfile.agent.spawnedProcesses += 1;
      return { pid, sessionId: session.id };
    } catch (error) {
      this.processes.discard(session);
      throw error;
    }
  }

  async stdin(
    workerRequestId: number,
    pid: number,
    data: Uint8Array,
  ): Promise<number> {
    this.requireCapability("processes");
    const frame = await this.request(
      workerRequestId,
      AgentKind.stdin,
      new AgentPayloadWriter().u32(pid).bytes(data).finish(),
    );
    const payload = new AgentPayloadReader(frame.payload);
    const accepted = payload.u32();
    payload.finish();
    if (accepted > data.byteLength) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "guest accepted more stdin than supplied",
      );
    }
    this.requireCore().traceProfile.agent.stdinBytes += accepted;
    return accepted;
  }

  async signal(
    workerRequestId: number,
    pid: number,
    signal: "TERM" | "KILL" | "INT" | "HUP",
  ): Promise<void> {
    this.requireCapability("processes");
    const frame = await this.request(
      workerRequestId,
      AgentKind.signal,
      new AgentPayloadWriter().u32(pid).string(signal).finish(),
    );
    expectEmptyAgentPayload(frame);
  }

  async processControl(workerRequestId: number, pid: number, sessionId: number, control: ProcessControl): Promise<void> {
    this.requireCapability("processes");
    if ((this.capabilities & AgentCapability.processControl) === 0) throw new VMError("FEATURE_NOT_AVAILABLE", "guest agent does not support generation-qualified process and terminal controls", { reason: "image-unsupported" });
    const generation = this.processes.generation(pid, sessionId);
    const payload = new AgentPayloadWriter().u32(pid).u32(generation);
    switch (control.kind) {
      case "signal": payload.u8(1).u8(linuxSignalNumber(control.signal)).u8(control.scope === "process-group" ? 1 : 0); break;
      case "resize": payload.u8(2).u32(control.columns).u32(control.rows); break;
      case "interrupt": payload.u8(3); break;
    }
    expectEmptyAgentPayload(await this.request(workerRequestId, AgentKind.processControl, payload.finish()));
  }

  async closeStdin(workerRequestId: number, pid: number): Promise<void> {
    this.requireCapability("processes");
    const frame = await this.request(
      workerRequestId,
      AgentKind.closeStdin,
      new AgentPayloadWriter().u32(pid).finish(),
    );
    expectEmptyAgentPayload(frame);
    this.processes.closedStdin(pid);
  }

  /**
   * Brings a restored guest up to date: reseeds its entropy pool and steps its paused wall clock
   * to the host's, through the agent or, for agents that predate the `resume` capability, through
   * `date` and `/dev/urandom` processes.
   */
  refreshGuest(workerRequestId: number): Promise<void> {
    this.requireCapability("processes");
    return refreshRestoredGuest(
      {
        resumeCapable: this.dialect === 7 && (this.capabilities & AgentCapability.resume) !== 0,
        request: async (kind, payload) => (await this.request(workerRequestId, kind, payload)).payload,
        ...this.commandAgent(workerRequestId),
      },
      () => Date.now(),
      crypto.getRandomValues(new Uint8Array(AGENT_RESEED_BYTES)),
    );
  }

  /**
   * Runs `sync` in the guest so its cached file data reaches its disks; does nothing before the
   * agent has announced itself.
   */
  async syncFilesystems(workerRequestId: number): Promise<void> {
    if (!this.ready) return;
    const termination = await runAgentCommand(this.commandAgent(workerRequestId), ["sync"], new Uint8Array());
    if (termination.kind !== "exit" || termination.code !== 0) {
      throw new VMError("GUEST_CRASH", "the guest could not write its files out", { reason: "sync-failed" });
    }
  }

  /** The agent operations a resumed workspace's reconciliation uses, bound to one request. */
  reconcileAgent(workerRequestId: number): ReconcileAgent {
    const commands = this.commandAgent(workerRequestId);
    let manifest: Promise<ReadonlyMap<string, AgentWorkspaceManifestEntry>> | undefined;
    return {
      readEntry: async path => {
        manifest ??= this.workspaceManifest(workerRequestId).then(bytes =>
          new Map(decodeAgentWorkspaceManifest(bytes).map(entry => [entry.path, entry])));
        return (await manifest).get(`/workspace${path === "/" ? "" : path}`);
      },
      readFile: async (path) => {
        try {
          return await this.readFile(workerRequestId, path);
        } catch (error) {
          if (error instanceof VMError && error.code === "STORAGE_NOT_FOUND") return undefined;
          throw error;
        }
      },
      applyDelta: (delta) => this.applyWorkspaceDelta(workerRequestId, delta),
      keepConflict: async (target, content) => {
        const termination = await runAgentCommand(commands, conflictCommand(target), content);
        if (termination.kind !== "exit" || termination.code !== 0) {
          throw new VMError("GUEST_CRASH", "a guest file both sides changed could not be kept", { reason: "conflict-not-kept" });
        }
      },
    };
  }

  /** Process operations for a short command the control worker runs in the guest. */
  private commandAgent(workerRequestId: number): CommandAgent {
    return {
      spawn: (command, args, port) =>
        this.spawn({ id: workerRequestId, version: PROTOCOL_VERSION, type: "agent-spawn", command, cwd: "/", args, env: {}, port }),
      writeStdin: async (pid, data) => {
        for (let offset = 0; offset < data.byteLength;) {
          const accepted = await this.stdin(workerRequestId, pid, data.subarray(offset));
          if (accepted === 0) throw new VMError("GUEST_CRASH", "a guest process stopped reading its input");
          offset += accepted;
        }
      },
      closeStdin: (pid) => this.closeStdin(workerRequestId, pid),
    };
  }

  flushInput(loaded: Core): void {
    this.pendingInput.flush(chunk => {
      stage(loaded, chunk);
      return callNumber(loaded, "oxidevm_system_agent_input", [chunk.byteLength]);
    });
  }

  drainOutput(loaded: Core): void {
    if (
      this.pendingRequests.size === 0 &&
      this.processes.size === 0 &&
      this.assistanceEvents === undefined &&
      this.installationEvents === undefined &&
      !this.listeners.draining &&
      !this.files.draining &&
      !this.pendingInput.hasPending &&
      !this.awaitingReady
    ) {
      return;
    }
    let length = callNumber(loaded, "oxidevm_system_agent_output", [
      AGENT_CHUNK_BYTES,
    ]);
    while (length !== 0) {
      if (length < 0 || length > AGENT_CHUNK_BYTES) {
        throw new VMError(
          "VM_FAULT",
          "guest agent console returned an invalid byte count",
        );
      }
      const pointer = callNumber(loaded, "oxidevm_staging_ptr");
      const bytes = memorySlice(loaded.memory, pointer, length).slice();
      for (const frame of this.decoder.push(bytes)) this.receiveFrame(frame);
      length = callNumber(loaded, "oxidevm_system_agent_output", [
        AGENT_CHUNK_BYTES,
      ]);
    }
  }

  private async request(
    workerRequestId: number,
    kind: number,
    payload: Uint8Array<ArrayBuffer>,
    timeoutMilliseconds: number | null = 60_000,
  ): Promise<AgentFrame> {
    this.abortIfCanceled(workerRequestId);
    const requestId = this.beginRequest(kind, payload, workerRequestId);
    const frame = await this.awaitResponse(
      workerRequestId,
      requestId,
      timeoutMilliseconds,
    );
    return checkedAgentResponse(frame, kind);
  }

  private beginRequest(
    kind: number,
    payload: Uint8Array<ArrayBuffer> | ((requestId: number) => Uint8Array<ArrayBuffer>),
    workerRequestId: number,
  ): number {
    this.assertWorkspaceHealthy();
    const loaded = this.requireCore();
    if (this.dialect === undefined) throw new VMError("PROTOCOL_ERROR", "guest dialect must be selected from readiness before requests");
    loaded.traceProfile.agent.requests += 1;
    const request = this.pendingRequests.open(kind, workerRequestId);
    try {
      this.pendingInput.enqueue({ version: this.dialect, kind, requestId: request.id, status: 0,
        payload: typeof payload === "function" ? payload(request.id) : payload });
      this.flushInput(loaded);
      return request.id;
    } catch (error) {
      this.pendingRequests.abandon(request);
      throw error;
    }
  }

  private async awaitResponse(
    workerRequestId: number,
    requestId: number,
    timeoutMilliseconds: number | null,
  ): Promise<AgentFrame> {
    const pending = this.pendingRequests.get(requestId);
    if (this.hasExecutionPump()) {
      return this.pendingRequests.wait(pending, timeoutMilliseconds);
    }
    if (timeoutMilliseconds === null) {
      const error = new VMError("GUEST_CRASH", "Assisted operation lost its system execution pump");
      this.pendingRequests.abandon(pending, error);
      throw error;
    }
    const deadline = performance.now() + timeoutMilliseconds;
    let completed = false;
    try {
      for (;;) {
        const available = pending.response();
        if (available !== undefined) {
          completed = true;
          return available;
        }
        this.abortIfCanceled(workerRequestId);
        if (performance.now() >= deadline) {
          throw this.timeout(
            "guest agent did not respond before the deadline",
            { requestId, kind: pending.kind },
          );
        }
        const exit = await this.pump(workerRequestId, deadline);
        if (
          exit !== undefined &&
          exit.kind !== "step-limit" &&
          pending.response() === undefined
        ) {
          throw new VMError(
            "GUEST_CRASH",
            `guest stopped before agent response (${exit.kind})`,
          );
        }
      }
    } finally {
      if (completed) this.pendingRequests.finish(pending);
      else this.pendingRequests.abandon(pending);
    }
  }

  private timeout(
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): VMError {
    const loaded = this.requireCore();
    const tail = this.consoleTail().slice(-4096).trim();
    const stats = runtimeStats(loaded);
    const state = decodeCpuSnapshot(readRecord(loaded, "cpu-state")).state;
    return new VMError(
      "GUEST_CRASH",
      `${message} after ${stats.retiredInstructions.toString()} instructions (${stats.jitInstructions.toString()} JIT, ${stats.interpretedInstructions.toString()} interpreted; ${stats.jitState}, ${stats.moduleLoads.toString()} modules) at RIP 0x${state.rip.toString(16)}${
        tail === "" ? "" : `; console tail:\n${tail}`
      }`,
      details,
    );
  }

  private receiveFrame(frame: AgentFrame): void {
    if (frame.kind === AgentKind.ready) {
      if (
        frame.requestId !== 0 ||
        frame.status !== 0 ||
        frame.payload.byteLength !== 0
      ) {
        throw new VMError(
          "PROTOCOL_ERROR",
          "guest agent readiness event is invalid",
        );
      }
      if (this.ready) this.agentRestarted();
      this.ready = true;
      this.dialect = frame.version;
      return;
    }
    if (frame.version !== this.dialect) throw new VMError("PROTOCOL_ERROR", "guest frame changed its negotiated dialect");
    if ((frame.kind & AGENT_RESPONSE_BIT) !== 0) {
      this.pendingRequests.receive(frame);
      return;
    }
    if (frame.kind === AgentKind.workspaceCaptureProgress) {
      if (this.dialect !== 7 || (this.capabilities & AgentCapability.workspaceCaptureProgress) === 0
        || frame.status !== 0 || frame.requestId === 0) throw new VMError("PROTOCOL_ERROR", "Unexpected capture progress event");
      if (this.pendingRequests.belowFloor(frame.requestId)) { this.pendingRequests.drop(); return; }
      this.captureProgress.receive(frame.requestId, frame.payload);
      return;
    }
    if (frame.kind === AgentKind.entriesChanged) {
      if (this.dialect !== 7 || (this.capabilities & AgentCapability.files2) === 0 || frame.requestId === 0) throw new VMError("PROTOCOL_ERROR", "unexpected workspace changes event");
      let failure: VMError | undefined;
      if (frame.status !== 0) {
        try { checkedAgentResponse({ ...frame, kind: AgentKind.watchEntries | AGENT_RESPONSE_BIT }, AgentKind.watchEntries); }
        catch (error) { failure = error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", "invalid workspace changes error"); }
      }
      this.files.receive(frame.requestId, frame.payload, failure);
      return;
    }
    if (frame.kind === AgentKind.captureProgress) {
      if ((this.capabilities & AgentCapability.captureProgress) === 0) throw new VMError("PROTOCOL_ERROR", "guest did not advertise capture progress");
      this.legacyCaptureProgress.receive(frame); return;
    }
    if (frame.kind === AgentKind.listeners) {
      if (!this.listenersAvailable || frame.status !== 0 || frame.requestId === 0) {
        throw new VMError("PROTOCOL_ERROR", "unexpected listening-port event");
      }
      this.listeners.receive(frame.requestId, frame.payload);
      return;
    }
    if (frame.kind === AgentKind.installationEvent) {
      const receiver = this.installationEvents;
      if (!this.assistanceAvailable || (this.dialect !== 6 && this.dialect !== 7) || receiver === undefined || frame.status !== 0 || frame.requestId !== 0) {
        throw new VMError("PROTOCOL_ERROR", "Unexpected installation event");
      }
      const event = decodeInstallationEvent(frame.payload, frame.version);
      if (event.session !== receiver.binding.session || event.generation !== receiver.binding.generation
        || event.installation !== receiver.binding.installation || event.sequence <= receiver.sequence) {
        throw new VMError("PROTOCOL_ERROR", "Stale installation event");
      }
      receiver.sequence = event.sequence;
      receiver.receive(event);
      return;
    }
    if (frame.kind === AgentKind.assistanceEvent) {
      if (!this.assistanceAvailable || this.assistanceEvents === undefined || frame.status !== 0 || frame.requestId !== 0) throw new VMError("PROTOCOL_ERROR", "unexpected assistance event");
      this.assistanceEvents(decodeAssistanceEvent(frame.payload));
      return;
    }
    if (
      frame.kind !== AgentKind.stdout &&
      frame.kind !== AgentKind.stderr &&
      frame.kind !== AgentKind.exit
    ) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "guest agent returned an unknown event",
      );
    }
    if (!this.processes.has(frame.requestId) && this.pendingRequests.belowFloor(frame.requestId)) {
      // Output of a process from before a restore that no session adopted.
      this.pendingRequests.drop();
      return;
    }
    this.processes.receive(frame);
  }

  /**
   * A second READY: init restarted the guest agent, so its processes, requests and partial
   * frames are gone. The next `wait` greets the new agent.
   */
  private agentRestarted(): void {
    const restarted = new VMError("GUEST_CRASH", "The guest agent restarted; its processes ended");
    this.processes.endAll(restarted);
    this.pendingRequests.failPending(restarted);
    this.captureProgress.clear();
    this.legacyCaptureProgress.clear();
    this.restoration.stop(restarted);
    this.pendingInput.clear();
    this.decoder = new AgentFrameDecoder();
    this.hello = undefined;
    this.capabilities = 0;
    this.assistanceAvailable = false;
    this.forkAvailable = false;
    this.listenersAvailable = false;
    this.listeners.agentGone("restarted");
    this.files.agentGone("restarted");
  }

  /**
   * Sends a WATCH_LISTENERS request. Its reply waits for a running session's drain: a
   * subscription never drives the guest itself.
   */
  private beginListenerWatch(payload: Uint8Array<ArrayBuffer>, kind: number = AgentKind.watchListeners): { readonly id: number; readonly reply: Promise<void> } {
    const id = this.beginRequest(kind, payload, 0);
    const reply = this.pendingRequests.wait(this.pendingRequests.get(id), LISTENER_REQUEST_MILLISECONDS).then((frame) => {
      expectEmptyAgentPayload(checkedAgentResponse(frame, kind));
    });
    return { id, reply };
  }

  private requireCapability(
    capability: keyof AgentHello["capabilities"],
  ): void {
    this.assertWorkspaceHealthy();
    if (this.hello?.capabilities[capability] !== true) {
      throw new VMError(
        "FEATURE_NOT_AVAILABLE",
        "managed guest agent is not ready",
      );
    }
  }

  private requireCore(): Core {
    if (this.core === undefined) {
      throw new VMError(
        "INVALID_ARGUMENT",
        "managed guest agent is not active",
      );
    }
    return this.core;
  }
}

function checkedAgentResponse(frame: AgentFrame, kind: number): AgentFrame {
  if (frame.kind !== (kind | AGENT_RESPONSE_BIT)) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "guest agent returned the wrong response kind",
    );
  }
  if (frame.status === 0) return frame;
  let message: string;
  try {
    message = agentErrorDecoder.decode(frame.payload);
  } catch {
    throw new VMError(
      "PROTOCOL_ERROR",
      "guest agent error is invalid UTF-8",
    );
  }
  const code =
    frame.status === 1
      ? "INVALID_ARGUMENT"
      : frame.status === 2
        ? "STORAGE_NOT_FOUND"
        : frame.status === 3
          ? "PERMISSION_DENIED"
          : frame.status === 4
            ? "STORAGE_ERROR"
            : frame.status === 5
              ? "FEATURE_NOT_AVAILABLE"
              : "PROTOCOL_ERROR";
  throw new VMError(code, message, {
    agentStatus: frame.status,
    agentKind: kind,
    ...(kind >= 26 && kind <= 32 && ["busy", "exists", "too-large", "not-a-file", "not-a-directory", "version-mismatch"].includes(message) ? { reason: message } : {}),
  });
}

function expectEmptyAgentPayload(frame: AgentFrame): void {
  if (frame.payload.byteLength !== 0) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "guest agent response has unexpected payload",
    );
  }
}
import type { ProcessControl } from "../../protocol/process-control.js";
import { linuxSignalNumber } from "../../process-signals.js";
