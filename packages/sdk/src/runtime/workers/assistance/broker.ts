import { GrantedTraffic, PROCESS_MESSAGE_BYTES, PROCESS_TRANSPORT_BYTES } from "./traffic.js";
import type { AssistanceCredit } from "../../protocol/assistance-credit.js";
import { exactKeys, record } from "../../decode.js";
import { serializeUnknownError, VMError } from "../../errors.js";
import { ASSISTANCE_LIMITS, decodeAssistanceIdentity, decodeAssistanceRequest, encodeAssistanceRequest, type AssistanceRequest } from "../../protocol/assistance.js";
import { BROKER_REPLY_VERSION, decodeBrokerAttention, decodeBrokerCommand, decodeBrokerShutdown, decodeBrokerEvent, decodeBrokerHeartbeat, type BrokerCommand } from "../../protocol/assistance-broker.js";
import { assistanceReplyCapacity, decodeAssistanceReply, matchAssistanceReply } from "../../protocol/assistance-reply.js";
import type { AssistanceBinding } from "../../protocol/assistance-control.js";
import { closeMailbox, completeReply, createMailbox, takeRequest } from "./mailbox.js";
import { decodeForkRequestBytes, encodeForkReply } from "../../protocol/assistance-fork.js";

interface Pending {
  readonly request: AssistanceRequest | undefined;
  readonly synchronous: boolean;
  readonly bytes: number;
  readonly reservation: number | undefined;
  /** A mailbox fork request: completed by control's fork-reply, never by bytes. */
  readonly fork: boolean;
}
/** The reply a fork request can receive: one tagged outcome with an error code. */
const FORK_REPLY_BYTES = 64;
interface Process {
  readonly worker: Worker;
  readonly buffer: SharedArrayBuffer;
  readonly pending: Map<number, Pending>;
  readonly traffic: GrantedTraffic | undefined;
  readonly allocations: number[];
  /** Control's identity of the parent this worker was forked from. */
  readonly parent: number | undefined;
  runtimeReservation: number | undefined;
  sequence: number;
  commandSequence: number;
  pendingBytes: number;
  stopped: boolean;
  ready: boolean;
  inputSequence: number | undefined;
}

/** Execution-origin lifecycle owner. Compiler admission belongs to the trusted
 * artifact bootstrap; application code never controls worker URLs or modules. */
export class ExecutionBroker {
  readonly #port: MessagePort;
  readonly #binding: AssistanceBinding;
  readonly #compiler: WebAssembly.Module;
  readonly #nextCompiler: WebAssembly.Module;
  readonly #httpParser: WebAssembly.Module;
  #runtime: Uint8Array<ArrayBuffer>;
  readonly #processes = new Map<number, Process>();
  readonly #reservations = new Map<number, { readonly sequence: number; readonly traffic: GrantedTraffic | undefined }>();
  #lastProcess = 0;
  #heartbeatSequence = 0;
  #controlDeadline = performance.now() + 60_000;
  /** Control's attention notice port: control's run loop ends a guest slice to receive what we post. */
  #notices: MessagePort | undefined;
  readonly #lifeline: ReturnType<typeof setInterval>;
  #disposed = false;

  constructor(port: MessagePort, binding: AssistanceBinding, compiler: WebAssembly.Module, runtime: Uint8Array<ArrayBuffer>, nextCompiler: WebAssembly.Module, httpParser: WebAssembly.Module) {
    this.#port = port;
    this.#binding = binding;
    this.#compiler = compiler;
    this.#nextCompiler = nextCompiler;
    this.#httpParser = httpParser;
    this.#runtime = runtime;
    port.onmessage = (event: MessageEvent<unknown>) => {
      try { this.receive(event.data); }
      catch (error) { this.#failAll(error); }
    };
    port.onmessageerror = () => this.#failAll(new VMError("PROTOCOL_ERROR", "Broker control channel failed"));
    port.start();
    this.#lifeline = setInterval(() => {
      if (performance.now() >= this.#controlDeadline) this.#failAll(new VMError("GUEST_CRASH", "Assistance control lifeline expired"));
    }, 15_000);
  }

  receive(value: unknown): void {
    if (this.#disposed) throw new VMError("ABORTED", "Execution broker is disposed");
    const envelope = record(value, "broker command");
    if (envelope["kind"] === "shutdown") {
      const command = decodeBrokerShutdown(value);
      this.#validate(command.binding);
      if (command.sequence !== this.#heartbeatSequence + 1) throw new VMError("PROTOCOL_ERROR", "Invalid broker shutdown sequence");
      this.#dispose({ ...command, kind: "stopped" });
      return;
    }
    if (envelope["kind"] === "attention") {
      const attention = decodeBrokerAttention(value);
      this.#validate(attention.binding);
      if (this.#notices !== undefined) { attention.port.close(); throw new VMError("PROTOCOL_ERROR", "Broker attention is already attached"); }
      this.#notices = attention.port;
      return;
    }
    if (envelope["kind"] === "ping") {
      const ping = decodeBrokerHeartbeat(value);
      this.#validate(ping.binding);
      if (ping.sequence !== this.#heartbeatSequence + 1) throw new VMError("PROTOCOL_ERROR", "Invalid broker heartbeat sequence");
      this.#heartbeatSequence = ping.sequence;
      this.#controlDeadline = performance.now() + 60_000;
      this.#post({ ...ping, kind: "pong" });
      return;
    }
    const command = decodeBrokerCommand(value);
    this.#validate(command.identity);
    // Private channels are created here, between two owned workers. Control
    // never holds a port into a process worker.
    if (command.kind === "fork-channel") throw new VMError("PROTOCOL_ERROR", "Fork channels are created by the broker");
    if (command.kind === "reserve") {
      this.#reserve(command.identity.process, command.identity.sequence, command.credits);
      return;
    }
    if (command.kind === "start") { this.#start(command); return; }
    const reserved = this.#reservations.get(command.identity.process);
    if (reserved !== undefined) {
      if (command.kind !== "stop" || command.identity.sequence !== reserved.sequence + 1) {
        throw new VMError("PROTOCOL_ERROR", "Invalid reserved process command");
      }
      this.#reservations.delete(command.identity.process);
      if (reserved.traffic !== undefined) this.#post({ kind: "retired",
        identity: command.identity, credits: reserved.traffic.returns() });
      return;
    }
    const process = this.#processes.get(command.identity.process);
    if (process === undefined) throw new VMError("PROTOCOL_ERROR", "Unknown assisted process");
    if (command.kind !== "reply" && command.kind !== "fork-reply") {
      if (command.identity.sequence !== process.commandSequence + 1) throw new VMError("PROTOCOL_ERROR", "Out-of-order broker command");
      process.commandSequence = command.identity.sequence;
    }
    // A worker can fail while Linux events/replies are already in transit.
    // Fence their authority until control retires the task; retain the first
    // terminal outcome instead of turning queued data into broker failure.
    if (process.stopped && command.kind !== "stop") return;
    if (command.kind === "input") {
      if (!process.ready || process.inputSequence !== undefined) throw new VMError("PROTOCOL_ERROR", "Invalid assisted input state");
      process.inputSequence = command.identity.sequence;
      process.worker.postMessage(command, command.bytes === null ? [] : [command.bytes.buffer]);
      return;
    }
    if (command.kind === "event") {
      process.worker.postMessage(command, [command.bytes.buffer]);
      return;
    }
    if (command.kind === "fork-output") {
      process.worker.postMessage(command, [command.bytes.buffer]);
      return;
    }
    if (command.kind === "fork-exit" || command.kind === "signal") {
      process.worker.postMessage(command, []);
      return;
    }
    if (command.kind === "stop") {
      this.#terminate(process);
      this.#processes.delete(command.identity.process);
      if (process.traffic !== undefined) this.#post({ kind: "retired",
        identity: command.identity, credits: process.traffic.returns() });
      return;
    }
    const pending = process.pending.get(command.identity.sequence);
    if (pending === undefined) throw new VMError("PROTOCOL_ERROR", "Unknown assisted completion");
    if (command.kind === "fork-reply") {
      if (!pending.fork) throw new VMError("PROTOCOL_ERROR", "Fork reply for a non-fork request");
      if (!completeReply(process.buffer, command.identity.sequence, encodeForkReply(command.reply))) throw new VMError("PROTOCOL_ERROR", "Mailbox completion was rejected");
    } else {
      if (pending.fork) throw new VMError("PROTOCOL_ERROR", "A fork request completes only through a fork reply");
      if (command.bytes.byteLength > (pending.request === undefined ? 128 : pending.bytes)) throw new VMError("PROTOCOL_ERROR", "Assisted reply exceeds its reservation");
      const reply = decodeAssistanceReply(command.bytes, BROKER_REPLY_VERSION);
      if (pending.request !== undefined) matchAssistanceReply(pending.request, reply);
      else if (reply.result.kind !== "unit") throw new VMError("PROTOCOL_ERROR", "Invalid output acknowledgement");
      if (pending.synchronous) {
        if (!completeReply(process.buffer, command.identity.sequence, command.bytes)) throw new VMError("PROTOCOL_ERROR", "Mailbox completion was rejected");
      } else {
        process.worker.postMessage(command, [command.bytes.buffer]);
      }
    }
    process.pending.delete(command.identity.sequence);
    process.pendingBytes -= pending.bytes;
    if (pending.reservation !== undefined) process.traffic?.release(pending.reservation);
  }

  dispose(): void { this.#dispose(); }

  /** Every message to control follows one notice on the attention port, when control attached one. */
  #post(message: unknown): void {
    this.#notices?.postMessage(null);
    this.#port.postMessage(message);
  }

  #dispose(receipt?: ReturnType<typeof decodeBrokerShutdown>): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearInterval(this.#lifeline);
    for (const process of this.#processes.values()) this.#terminate(process);
    this.#processes.clear();
    this.#reservations.clear();
    this.#runtime = new Uint8Array();
    this.#port.onmessage = null; this.#port.onmessageerror = null;
    try { if (receipt !== undefined) this.#post(receipt); }
    finally { this.#port.close(); this.#notices?.close(); this.#notices = undefined; }
  }

  #validate(identity: AssistanceBinding): void {
    if (identity.session !== this.#binding.session || identity.generation !== this.#binding.generation) {
      throw new VMError("PROTOCOL_ERROR", "Stale execution broker binding");
    }
  }

  #reserve(id: number, sequence: number, credits?: readonly AssistanceCredit[]): void {
    if (sequence !== 1) throw new VMError("PROTOCOL_ERROR", "Invalid first broker command sequence");
    if (id <= this.#lastProcess || this.#processes.size + this.#reservations.size >= ASSISTANCE_LIMITS.processes) {
      throw new VMError("QUOTA_EXCEEDED", "Assisted worker capacity or identity exhausted");
    }
    const traffic = credits === undefined ? undefined : new GrantedTraffic({ ...this.#binding, process: id, producer: "broker" }, credits);
    this.#lastProcess = id;
    this.#reservations.set(id, { sequence, traffic });
  }

  #start(command: Extract<BrokerCommand, { kind: "start" }>): void {
    const reserved = this.#reservations.get(command.identity.process);
    if (reserved === undefined) {
      // The v4 control dialect starts directly; v5 reserves before Linux setup.
      this.#reserve(command.identity.process, command.identity.sequence);
    } else if (command.identity.sequence !== reserved.sequence + 1) {
      throw new VMError("PROTOCOL_ERROR", "Out-of-order reserved startup");
    }
    const traffic = this.#reservations.get(command.identity.process)?.traffic;
    // A validated start consumes its sequence even if local allocation fails.
    this.#reservations.set(command.identity.process, { sequence: command.identity.sequence, traffic });
    // A fork child's parent must be an owned, ready worker; the private IPC
    // channel is created here and never leaves these two workers.
    const parent = command.parent === undefined ? undefined : this.#processes.get(command.parent);
    if (command.parent !== undefined && (parent === undefined || !parent.ready || parent.stopped)) {
      throw new VMError("PROTOCOL_ERROR", "Fork parent is not a running worker");
    }
    const allocations: number[] = [];
    let runtimeReservation: number | undefined;
    let buffer: SharedArrayBuffer;
    let worker: Worker;
    try {
      if (traffic !== undefined) {
        for (const bytes of PROCESS_TRANSPORT_BYTES) allocations.push(traffic.reserve("data", bytes));
        runtimeReservation = traffic.reserve("data", this.#runtime.byteLength);
      }
      buffer = createMailbox();
      worker = new Worker("/assisted-process.worker.js", { type: "module" });
    } catch (error) {
      if (runtimeReservation !== undefined) traffic?.release(runtimeReservation);
      for (const allocation of allocations) traffic?.release(allocation);
      throw error;
    }
    const process: Process = { worker, buffer, traffic, allocations, parent: command.parent, runtimeReservation, sequence: 0, commandSequence: command.identity.sequence, pending: new Map(), pendingBytes: 0, stopped: false, ready: false, inputSequence: undefined };
    this.#processes.set(command.identity.process, process);
    this.#reservations.delete(command.identity.process);
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (process.stopped) return;
      try { this.#receiveProcess(command.identity.process, process, event.data); }
      catch (error) { this.#fail(command.identity.process, process, error); }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.#fail(command.identity.process, process, new VMError("GUEST_CRASH",
        `Assisted worker was lost${event.message ? `: ${event.message.slice(0, 2048)}` : ""}`,
        { filename: event.filename.slice(0, 2048), line: event.lineno, column: event.colno }));
    };
    worker.onmessageerror = () => this.#fail(command.identity.process, process, new VMError("PROTOCOL_ERROR", "Assisted worker message failed"));
    try {
      const runtimeBytes = this.#runtime.slice().buffer;
      const channel = parent === undefined || command.parent === undefined ? undefined : new MessageChannel();
      if (channel !== undefined && parent !== undefined && command.parent !== undefined) {
        parent.worker.postMessage({ kind: "fork-channel", identity: { ...this.#binding, process: command.parent, sequence: parent.commandSequence },
          child: command.identity.process, port: channel.port1 }, [channel.port1]);
      }
      worker.postMessage({ ...command, buffer, compilerModule: this.#compiler, nextCompilerModule: this.#nextCompiler, httpParserModule: this.#httpParser, runtimeBytes,
        ...(traffic === undefined ? {} : { trafficBytes: PROCESS_MESSAGE_BYTES }), ...(channel === undefined ? {} : { ipc: channel.port2 }) },
      channel === undefined ? [runtimeBytes] : [runtimeBytes, channel.port2]);
    } catch (error) { this.#fail(command.identity.process, process, error); }
  }

  #receiveProcess(id: number, process: Process, value: unknown): void {
    const input = record(value, "process worker event");
    const identity = decodeAssistanceIdentity(input["identity"]);
    this.#validate(identity);
    if (identity.process !== id || identity.sequence !== process.sequence + 1) {
      throw new VMError("PROTOCOL_ERROR", "Wrong process worker identity or sequence");
    }
    if (process.traffic !== undefined && !process.ready && input["kind"] !== "ready" && input["kind"] !== "failed") {
      throw new VMError("PROTOCOL_ERROR", "Process traffic before runtime readiness");
    }
    let synchronous = false;
    let fork = false;
    if (input["kind"] === "pending" || input["kind"] === "pending-fork") {
      exactKeys(input, ["kind", "identity"]);
      if ([...process.pending.values()].some(pending => pending.synchronous)) throw new VMError("PROTOCOL_ERROR", "Concurrent synchronous requests");
      const bytes = takeRequest(process.buffer, identity.sequence);
      if (input["kind"] === "pending-fork") {
        // The parent describes its child; control allocates every identity.
        value = { kind: "fork", identity, request: decodeForkRequestBytes(bytes) };
        fork = true;
      } else {
        const request = decodeAssistanceRequest(bytes);
        if (request.session !== identity.session || request.generation !== identity.generation
          || request.process !== id || request.sequence !== identity.sequence) throw new VMError("PROTOCOL_ERROR", "Mailbox identity mismatch");
        value = { kind: "request", identity, operation: request.operation };
      }
      synchronous = true;
    }
    const event = decodeBrokerEvent(value);
    if (event.kind === "fork" && !fork) throw new VMError("PROTOCOL_ERROR", "Fork requests enter through the mailbox");
    if (event.kind === "ready") {
      if (process.ready) throw new VMError("PROTOCOL_ERROR", "Duplicate process readiness");
      process.ready = true;
      if (process.runtimeReservation !== undefined) {
        process.traffic?.release(process.runtimeReservation); process.runtimeReservation = undefined;
      }
      if (process.traffic !== undefined) process.allocations.push(process.traffic.reserve("data", 2 * ASSISTANCE_LIMITS.request));
    } else if (event.kind === "input-ack") {
      if (process.inputSequence !== event.sequence) throw new VMError("PROTOCOL_ERROR", "Invalid input acknowledgement");
      process.inputSequence = undefined;
    } else if (event.kind === "request" || event.kind === "output" || event.kind === "fork" || event.kind === "fork-input" || event.kind === "fork-signal") {
      if (event.kind !== "request" && !process.ready) throw new VMError("PROTOCOL_ERROR", "Process traffic before readiness");
      const bytes = event.kind === "output" ? event.bytes.length
        : event.kind === "fork" ? FORK_REPLY_BYTES
          : event.kind === "fork-input" ? (event.bytes?.length ?? 0) + 128
            : event.kind === "fork-signal" ? 128
              : Math.max(encodeAssistanceRequest({ ...identity, operation: event.operation }).byteLength, assistanceReplyCapacity(event.operation));
      if (process.pending.size >= 128 || process.pendingBytes + bytes > ASSISTANCE_LIMITS.stream) {
        throw new VMError("QUOTA_EXCEEDED", "Assisted worker pending traffic exceeded");
      }
      process.pending.set(identity.sequence, {
        request: event.kind === "request" ? { ...identity, operation: event.operation } : undefined,
        synchronous, bytes, reservation: process.traffic?.reserve("data", bytes * 2 + 128), fork,
      });
      process.pendingBytes += bytes;
    } else if (event.kind === "fork-output-ack") {
      if (!process.ready) throw new VMError("PROTOCOL_ERROR", "Process traffic before readiness");
    } else if (event.kind === "exit" || event.kind === "exit-request" || event.kind === "exit-signal") {
      if (event.kind === "exit" && process.pending.size !== 0) throw new VMError("PROTOCOL_ERROR", "Assisted process exited before draining I/O");
      this.#terminate(process);
    } else this.#terminate(process);
    process.sequence = identity.sequence;
    this.#post(event);
  }

  #terminate(process: Process): void {
    if (process.stopped) return;
    process.stopped = true;
    closeMailbox(process.buffer);
    process.worker.terminate();
    for (const pending of process.pending.values()) if (pending.reservation !== undefined) process.traffic?.release(pending.reservation);
    process.pending.clear();
    if (process.runtimeReservation !== undefined) {
      process.traffic?.release(process.runtimeReservation); process.runtimeReservation = undefined;
    }
    for (const reservation of process.allocations.splice(0)) process.traffic?.release(reservation);
    process.pendingBytes = 0;
  }

  #fail(id: number, process: Process, error: unknown): void {
    if (process.stopped) return;
    this.#terminate(process);
    if (process.sequence === 0xffff_ffff) { this.#failAll(error); return; }
    this.#post({ kind: "failed", identity: { ...this.#binding, process: id, sequence: ++process.sequence }, error: serializeUnknownError(error) });
  }

  #failAll(error: unknown): void {
    if (this.#disposed) return;
    try { this.#post({ kind: "broker-failed", binding: this.#binding, error: serializeUnknownError(error) }); }
    finally { this.dispose(); }
  }
}
