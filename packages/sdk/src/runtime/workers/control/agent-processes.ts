import { type AgentFrame, AgentKind } from "../../agent-protocol.js";
import type { DiskBridgeClient } from "../../disk-bridge.js";
import { VMError, serializeUnknownError } from "../../errors.js";
import { decodeGuestProcessPortAck, PROTOCOL_VERSION } from "../../protocol.js";
import type { AdoptableProcess } from "./agent-resume-state.js";
import { MAX_RESUME_TAIL_BYTES } from "./agent-resume-state.js";
import type { Core } from "./core.js";
import type { SessionDiagnostics } from "./system-session.js";
import { checkpointSystemTrace, freezeSystemTrace } from "./trace.js";

const MAX_PENDING_PROCESS_OUTPUT_BYTES = 1024 * 1024;
/** The characters of a command line a session keeps; four UTF-8 bytes each fit OXHA's 4 KiB. */
const MAX_COMMAND_LENGTH = 1024;

/** What process sessions need from their guest agent: the core and the system trace context. */
export interface AgentProcessHost {
  readonly core: () => Core;
  readonly diskBridge: () => DiskBridgeClient | undefined;
  readonly consoleTail: () => string;
  readonly session: () => SessionDiagnostics;
}

export interface GuestProcessSession {
  readonly id: number;
  readonly agentRequestId: number;
  readonly queued: AgentFrame[];
  readonly terminal: boolean;
  /** The command line it was spawned with, for a resumed page to name it. */
  readonly command: string;
  /** The page port receiving output; none while a restored process waits to be attached. */
  port: MessagePort | undefined;
  detach: () => void;
  pid: number | undefined;
  stdinOpen: boolean;
  /** The newest output, for the next snapshot's resume state. */
  tail: Uint8Array;
  /** A restored process's screen from its snapshot, replayed first when a page attaches. */
  replay: Uint8Array | undefined;
  sequence: number;
  pendingBytes: number;
  awaitingAck: number | undefined;
  exited: boolean;
}

/**
 * The guest processes a guest agent spawned, by spawn request: each relays its output to its
 * port one acknowledged event at a time, buffering at most 1 MiB. A process restored from a
 * snapshot keeps its newest megabyte until a page attaches to it.
 */
export class AgentProcesses {
  readonly #host: AgentProcessHost;
  readonly #sessions = new Map<number, GuestProcessSession>();

  constructor(host: AgentProcessHost) {
    this.#host = host;
  }

  get size(): number {
    return this.#sessions.size;
  }

  has(agentRequestId: number): boolean {
    return this.#sessions.has(agentRequestId);
  }

  generation(pid: number, sessionId: number): number {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.exited || session.pid !== pid) throw new VMError("PROTOCOL_ERROR", "process capability is stale or retired");
    return session.agentRequestId;
  }

  /** Starts relaying the output of spawn request `agentRequestId`, running `command`, to `port`. */
  open(agentRequestId: number, port: MessagePort, terminal: boolean, command: string): GuestProcessSession {
    const session = this.#session(agentRequestId, undefined, terminal, true, command.slice(0, MAX_COMMAND_LENGTH));
    this.#bind(session, port);
    this.#sessions.set(agentRequestId, session);
    return session;
  }

  /** Takes over the processes a restored snapshot was relaying; none has a page yet. */
  adopt(processes: readonly AdoptableProcess[]): void {
    for (const process of processes) {
      const session = this.#session(process.agentRequestId, process.pid, process.terminal, process.stdinOpen, process.command);
      session.tail = process.tail.slice();
      session.replay = process.tail.byteLength === 0 ? undefined : process.tail.slice();
      this.#sessions.set(process.agentRequestId, session);
    }
  }

  /**
   * Gives a restored process a page: its screen from the snapshot first, then what it printed
   * since the restore, then live output.
   */
  attach(agentRequestId: number, port: MessagePort): { readonly pid: number; readonly sessionId: number; readonly terminal: boolean } {
    const session = this.#sessions.get(agentRequestId);
    if (session === undefined) throw new VMError("INVALID_ARGUMENT", "the guest process is not running");
    if (session.port !== undefined) throw new VMError("INVALID_ARGUMENT", "the guest process is already attached");
    if (session.pid === undefined) throw new VMError("PROTOCOL_ERROR", "the guest process has no pid");
    const replay = session.replay;
    session.replay = undefined;
    if (replay !== undefined) session.queued.unshift(outputFrame(session, replay));
    this.#bind(session, port);
    this.#dispatch(session);
    return { pid: session.pid, sessionId: session.id, terminal: session.terminal };
  }

  /** The live processes and their newest output, for a snapshot's resume state. */
  adoptable(): AdoptableProcess[] {
    const processes: AdoptableProcess[] = [];
    for (const session of this.#sessions.values()) {
      if (session.exited || session.pid === undefined) continue;
      processes.push({
        agentRequestId: session.agentRequestId,
        pid: session.pid,
        terminal: session.terminal,
        stdinOpen: session.stdinOpen,
        command: session.command,
        tail: session.tail.slice(),
      });
    }
    return processes;
  }

  /** Records that a process's stdin was closed. */
  closedStdin(pid: number): void {
    for (const session of this.#sessions.values()) {
      if (session.pid === pid) session.stdinOpen = false;
    }
  }

  /** Ends every session with `error`, as when the guest agent restarted. */
  endAll(error: VMError): void {
    for (const session of [...this.#sessions.values()]) this.#fail(session, error);
    this.#sessions.clear();
  }

  #session(
    agentRequestId: number,
    pid: number | undefined,
    terminal: boolean,
    stdinOpen: boolean,
    command: string,
  ): GuestProcessSession {
    return {
      id: agentRequestId,
      agentRequestId,
      queued: [],
      command,
      terminal,
      port: undefined,
      detach: () => undefined,
      pid,
      stdinOpen,
      tail: new Uint8Array(),
      replay: undefined,
      sequence: 0,
      pendingBytes: 0,
      awaitingAck: undefined,
      exited: false,
    };
  }

  #bind(session: GuestProcessSession, port: MessagePort): void {
    const receiveAck = (event: MessageEvent<unknown>) => {
      this.#receiveAck(session, event.data);
    };
    const receiveError = () => {
      this.#fail(
        session,
        new VMError(
          "PROTOCOL_ERROR",
          "guest process acknowledgement could not be decoded",
        ),
      );
    };
    session.port = port;
    session.detach = () => {
      port.removeEventListener("message", receiveAck);
      port.removeEventListener("messageerror", receiveError);
    };
    port.addEventListener("message", receiveAck);
    port.addEventListener("messageerror", receiveError);
    port.start();
  }

  /** Records the pid the guest reported for a spawn. */
  started(session: GuestProcessSession, pid: number): void {
    if (session.pid !== undefined && session.pid !== pid) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "guest process id changed during spawn",
      );
    }
    session.pid = pid;
  }

  /** Forgets a spawn that failed and closes its port. */
  discard(session: GuestProcessSession): void {
    session.detach();
    session.port?.close();
    this.#sessions.delete(session.agentRequestId);
  }

  closeAll(): void {
    for (const session of this.#sessions.values()) session.port?.close();
    this.#sessions.clear();
  }

  /** Queues a stdout, stderr or exit event for its process. */
  receive(frame: AgentFrame): void {
    const session = this.#sessions.get(frame.requestId);
    if (session === undefined) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "guest agent returned output for an unknown process",
      );
    }
    const pid = readAgentEventPid(frame);
    if (session.pid !== undefined && session.pid !== pid) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "guest process output has the wrong process id",
      );
    }
    session.pid = pid;
    if (frame.kind === AgentKind.stdout || frame.kind === AgentKind.stderr) {
      session.tail = newestTail(session.tail, frame.payload.subarray(4));
    }
    if (session.port === undefined) {
      // No page listens yet: keep the newest megabyte rather than end the process's session.
      while (session.pendingBytes + frame.payload.byteLength > MAX_PENDING_PROCESS_OUTPUT_BYTES && session.queued.length !== 0) {
        const dropped = session.queued.shift();
        session.pendingBytes -= dropped?.payload.byteLength ?? 0;
      }
      session.queued.push(frame);
      session.pendingBytes += frame.payload.byteLength;
      return;
    }
    if (
      session.pendingBytes + frame.payload.byteLength >
      MAX_PENDING_PROCESS_OUTPUT_BYTES
    ) {
      this.#fail(
        session,
        new VMError(
          "QUOTA_EXCEEDED",
          "guest process output exceeded its browser backpressure buffer",
        ),
      );
      return;
    }
    session.queued.push(frame);
    session.pendingBytes += frame.payload.byteLength;
    this.#dispatch(session);
  }

  #dispatch(session: GuestProcessSession): void {
    const port = session.port;
    if (
      port === undefined ||
      session.awaitingAck !== undefined ||
      session.exited ||
      session.queued.length === 0
    ) {
      return;
    }
    const frame = session.queued.shift();
    if (frame === undefined) return;
    session.pendingBytes -= frame.payload.byteLength;
    const sequence = session.sequence + 1;
    session.sequence = sequence;
    if (frame.kind === AgentKind.stdout || frame.kind === AgentKind.stderr) {
      const data = frame.payload.slice(4);
      const loaded = this.#host.core();
      if (frame.kind === AgentKind.stdout) {
        loaded.traceProfile.agent.stdoutBytes += data.byteLength;
      } else {
        loaded.traceProfile.agent.stderrBytes += data.byteLength;
        if (loaded.traceCheckpointPolicy === "faults-and-stderr") {
          checkpointSystemTrace(
            loaded,
            this.#host.diskBridge(),
            this.#host.consoleTail(),
            this.#host.session(),
          );
        }
      }
      session.awaitingAck = sequence;
      port.postMessage(
        {
          version: PROTOCOL_VERSION,
          sessionId: session.id,
          sequence,
          type: frame.kind === AgentKind.stdout ? "stdout" : "stderr",
          data,
        },
        [data.buffer],
      );
      return;
    }
    if (frame.kind !== AgentKind.exit || frame.payload.byteLength !== 8) {
      this.#fail(
        session,
        new VMError("PROTOCOL_ERROR", "guest process exit is malformed"),
      );
      return;
    }
    const code = new DataView(
      frame.payload.buffer,
      frame.payload.byteOffset + 4,
      4,
    ).getInt32(0, true);
    if (code < -64 || code > 255) {
      this.#fail(
        session,
        new VMError("PROTOCOL_ERROR", "guest process termination is invalid"),
      );
      return;
    }
    if (code > 0) {
      freezeSystemTrace(
        this.#host.core(),
        this.#host.diskBridge(),
        this.#host.consoleTail(),
        "guest-process-exit",
        this.#host.session(),
      );
    }
    session.exited = true;
    port.postMessage({
      version: PROTOCOL_VERSION,
      sessionId: session.id,
      sequence,
      type: "exit",
      termination:
        code < 0
          ? { kind: "signal", signal: -code }
          : { kind: "exit", code },
    });
    port.close();
    this.#sessions.delete(session.agentRequestId);
  }

  #receiveAck(session: GuestProcessSession, value: unknown): void {
    try {
      const ack = decodeGuestProcessPortAck(value);
      if (
        this.#sessions.get(session.agentRequestId) !== session ||
        ack.sessionId !== session.id ||
        ack.sequence !== session.awaitingAck
      ) {
        throw new VMError(
          "PROTOCOL_ERROR",
          "guest process acknowledgement is invalid",
        );
      }
      session.awaitingAck = undefined;
      this.#dispatch(session);
    } catch (error) {
      this.#fail(session, error);
    }
  }

  #fail(session: GuestProcessSession, error: unknown): void {
    if (this.#sessions.get(session.agentRequestId) !== session) return;
    freezeSystemTrace(
      this.#host.core(),
      this.#host.diskBridge(),
      this.#host.consoleTail(),
      "guest-process-protocol",
      this.#host.session(),
    );
    session.exited = true;
    this.#sessions.delete(session.agentRequestId);
    const port = session.port;
    if (port === undefined) return;
    try {
      const sequence = session.sequence + 1;
      session.sequence = sequence;
      port.postMessage({
        version: PROTOCOL_VERSION,
        sessionId: session.id,
        sequence,
        type: "error",
        error: serializeUnknownError(error),
      });
    } finally {
      port.close();
    }
  }
}

/** A stdout event carrying `data`, as the guest would send it for `session`. */
function outputFrame(session: GuestProcessSession, data: Uint8Array): AgentFrame {
  const payload = new Uint8Array(4 + data.byteLength);
  new DataView(payload.buffer).setUint32(0, session.pid ?? 0, true);
  payload.set(data, 4);
  return { version: 7, kind: AgentKind.stdout, requestId: session.agentRequestId, status: 0, payload };
}

function newestTail(tail: Uint8Array, output: Uint8Array): Uint8Array {
  const kept = Math.min(tail.byteLength, MAX_RESUME_TAIL_BYTES - Math.min(output.byteLength, MAX_RESUME_TAIL_BYTES));
  const next = new Uint8Array(kept + Math.min(output.byteLength, MAX_RESUME_TAIL_BYTES));
  next.set(tail.subarray(tail.byteLength - kept));
  next.set(output.subarray(Math.max(0, output.byteLength - MAX_RESUME_TAIL_BYTES)), kept);
  return next;
}

function readAgentEventPid(frame: AgentFrame): number {
  if (frame.payload.byteLength < 4) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "guest process event is truncated",
    );
  }
  return new DataView(
    frame.payload.buffer,
    frame.payload.byteOffset,
    4,
  ).getUint32(0, true);
}
