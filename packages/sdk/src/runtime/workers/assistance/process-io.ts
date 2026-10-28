import { VMError, deserializeError, serializeUnknownError } from "../../errors.js";
import { ASSISTANCE_LIMITS, decodeAssistanceOperation, encodeAssistanceRequest, isAssistanceSupervisoryOperation, type AssistanceIdentity, type AssistanceOperation, type AssistanceRequest } from "../../protocol/assistance.js";
import { BROKER_REPLY_VERSION, decodeBrokerCommand, type BrokerEvent, type BrokerCommand } from "../../protocol/assistance-broker.js";
import { decodeAssistanceEvent, type AssistanceEvent } from "../../protocol/assistance-event.js";
import { assistanceReplyCapacity, decodeAssistanceReply, matchAssistanceReply, type AssistanceResult } from "../../protocol/assistance-reply.js";
import { closeMailbox, publishRequest, waitForReply } from "./mailbox.js";
import { decodeForkReplyBytes, encodeForkRequest, type ForkReply, type ForkRequest } from "../../protocol/assistance-fork.js";
import type { ChildSignal, ExitSignal, ForkTermination } from "../../protocol/assistance-broker.js";
import type { LinuxSignal } from "../../process-signals.js";
import type { ExceptionOrigin } from "./node-exceptions.js";
import type { NativeChildSpec } from "../../../js-process-types.js";

// Capture trusted primitives before installing application globals.
const wait = Atomics.wait.bind(Atomics);
const load = Atomics.load.bind(Atomics);
const ControlWords = Int32Array;

type Pending = {
  readonly request: AssistanceRequest | undefined;
  readonly completion: PromiseWithResolvers<AssistanceResult>;
  readonly charge: number;
  readonly control: boolean;
  readonly referenced: boolean;
  /** Fork traffic settles with unit or a Node-style error result. */
  readonly fork: boolean;
};
type Supervision = { readonly operation: AssistanceOperation; readonly completion: PromiseWithResolvers<AssistanceResult> };
type ProcessEvent = BrokerEvent | { readonly kind: "pending" | "pending-fork"; readonly identity: AssistanceIdentity };
/** Fork children owned by this parent worker: their private channel, silent
 * output and termination arrive as commands routed to one owner. */
export type ForkExit = ForkTermination | { readonly kind: "native-signal"; readonly signal: LinuxSignal };
export interface ForkEvents {
  channel(child: number, port: MessagePort): void;
  output(child: number, stream: "stdout" | "stderr", bytes: Uint8Array<ArrayBuffer>, chunk: number): void;
  exit(child: number, termination: ForkExit): void;
}

/** A process owns its sequence and pending callbacks. Async APIs never wait on
 * shared memory; only their synchronous counterparts enter the mailbox. */
export class ProcessIO {
  readonly #binding: AssistanceIdentity;
  readonly #buffer: SharedArrayBuffer;
  readonly #send: (event: ProcessEvent) => void;
  readonly #pending = new Map<number, Pending>();
  #schedule: ((callback: () => void) => void) | undefined;
  #sequence = 0;
  #bytes = 0;
  #controlBytes = 0;
  readonly #supervision: Supervision[] = [];
  #supervising = false;
  #activities = 0;
  #ready = false;
  #commandSequence: number;
  readonly #capacity: number;
  #input: ((bytes: Uint8Array | null) => Promise<void>) | undefined;
  #inputPending = false;
  #guestSequence = 0;
  #childEvents: ((event: ProcessChildEvent) => void) | undefined;
  #forkEvents: ForkEvents | undefined;
  #signals: ((signal: Exclude<ChildSignal, "KILL">) => void) | undefined;
  #closed: Error | undefined;
  #exception: ((error: unknown, origin: ExceptionOrigin, promise?: Promise<unknown>) => boolean) | undefined;
  #drained: PromiseWithResolvers<undefined> | undefined;

  constructor(binding: AssistanceIdentity, buffer: SharedArrayBuffer, send: (event: ProcessEvent) => void, capacity: number = ASSISTANCE_LIMITS.stream) {
    this.#capacity = capacity;
    this.#binding = binding;
    this.#commandSequence = binding.sequence;
    this.#buffer = buffer;
    this.#send = send;
  }

  setExceptionHandler(handler: (error: unknown, origin: ExceptionOrigin, promise?: Promise<unknown>) => boolean): void {
    if (this.#exception !== undefined) throw new VMError("PROTOCOL_ERROR", "Process exception owner is already set");
    this.#exception = handler;
  }
  applicationException(error: unknown, origin: ExceptionOrigin = "uncaughtException", promise?: Promise<unknown>): void {
    if (this.#schedule === undefined) { this.fail(error); return; }
    this.#schedule(() => { if (this.#exception?.(error, origin, promise) !== true) this.fail(error); });
  }

  ready(): void {
    if (this.#ready) throw new VMError("PROTOCOL_ERROR", "Process readiness was already sent");
    const identity = this.#identity();
    this.#sequence = identity.sequence;
    this.#ready = true;
    this.#send({ kind: "ready", identity });
  }

  #identity(): AssistanceIdentity {
    if (this.#closed !== undefined) throw this.#closed;
    if (this.#sequence === 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Process request sequence exhausted");
    return { ...this.#binding, sequence: this.#sequence + 1 };
  }

  callSync(operation: AssistanceOperation): AssistanceResult {
    // A callback can block this worker before an earlier asynchronous ACK reply
    // runs its continuation. Drain queued supervision through the mailbox first
    // so Linux is not waiting for credits trapped behind this synchronous call.
    for (let next = this.#supervision.shift(); next !== undefined; next = this.#supervision.shift()) {
      try { next.completion.resolve(this.#callSync(next.operation)); }
      catch (error) { next.completion.reject(error); throw error; }
    }
    return this.#callSync(operation);
  }

  #callSync(operation: AssistanceOperation): AssistanceResult {
    const identity = this.#identity();
    const request = { ...identity, operation };
    publishRequest(this.#buffer, request.sequence, encodeAssistanceRequest(request));
    this.#sequence = identity.sequence;
    this.#send({ kind: "pending", identity });
    const reply = decodeAssistanceReply(waitForReply(this.#buffer, request.sequence, null), BROKER_REPLY_VERSION);
    matchAssistanceReply(request, reply);
    return reply.result;
  }

  /** Node's fork() returns with the child's pid: the request waits on the
   * mailbox until control has allocated the child and Linux has its helper. */
  forkSync(request: ForkRequest): ForkReply {
    for (let next = this.#supervision.shift(); next !== undefined; next = this.#supervision.shift()) {
      try { next.completion.resolve(this.#callSync(next.operation)); }
      catch (error) { next.completion.reject(error); throw error; }
    }
    const bytes = encodeForkRequest(request);
    const identity = this.#identity();
    publishRequest(this.#buffer, identity.sequence, bytes);
    this.#sequence = identity.sequence;
    this.#send({ kind: "pending-fork", identity });
    return decodeForkReplyBytes(waitForReply(this.#buffer, identity.sequence, null));
  }

  forkInput(child: number, bytes: Uint8Array<ArrayBuffer> | null): Promise<AssistanceResult> {
    const identity = this.#identity();
    return this.#dispatch({ kind: "fork-input", identity, child, bytes }, undefined, (bytes?.byteLength ?? 0) + 128, false, true, true);
  }

  forkSignal(child: number, signal: ChildSignal): Promise<AssistanceResult> {
    const identity = this.#identity();
    return this.#dispatch({ kind: "fork-signal", identity, child, signal }, undefined, 128, false, true, true);
  }

  forkOutputAck(child: number, chunk: number): void {
    const identity = this.#identity();
    this.#sequence = identity.sequence;
    this.#send({ kind: "fork-output-ack", identity, child, chunk });
  }

  call(operation: AssistanceOperation, referenced = true, signal?: AbortSignal): Promise<AssistanceResult> {
    if (signal !== undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Per-operation cancellation is unavailable in the system agent transport");
    if (isAssistanceSupervisoryOperation(operation)) {
      if (this.#closed !== undefined) throw this.#closed;
      if (this.#supervision.length + Number(this.#supervising) >= 128) throw new VMError("QUOTA_EXCEEDED", "Process supervisory queue exhausted");
      const completion = Promise.withResolvers<AssistanceResult>();
      this.#supervision.push({ operation: decodeAssistanceOperation(operation), completion });
      this.#pumpSupervision();
      return completion.promise;
    }
    const identity = this.#identity();
    const request = { ...identity, operation };
    const bytes = encodeAssistanceRequest(request).byteLength;
    return this.#dispatch({ kind: "request", identity, operation }, request, bytes + assistanceReplyCapacity(operation), false, referenced);
  }

  #pumpSupervision(): void {
    if (this.#supervising || this.#closed !== undefined) return;
    const next = this.#supervision.shift();
    if (next === undefined) return;
    // ponytail: one supervisory request in flight per worker; batch only if
    // profiling justifies it, retaining reserved reply space and FIFO ordering.
    this.#supervising = true;
    void (async () => {
      try {
        const identity = this.#identity();
        const request = { ...identity, operation: next.operation };
        const charge = encodeAssistanceRequest(request).byteLength + ASSISTANCE_LIMITS.request;
        next.completion.resolve(await this.#dispatch({ kind: "request", identity, operation: next.operation }, request, charge, true));
      } catch (error) { next.completion.reject(error); }
      finally { this.#supervising = false; this.#pumpSupervision(); this.#notifyDrained(); }
    })();
  }

  async output(stream: "stdout" | "stderr", bytes: Uint8Array): Promise<void> {
    const release = this.retain();
    try {
      for (let offset = 0; offset < bytes.length; offset += ASSISTANCE_LIMITS.chunk) {
        const chunk = bytes.slice(offset, offset + ASSISTANCE_LIMITS.chunk);
        const identity = this.#identity();
        await this.#dispatch({ kind: "output", identity, stream, bytes: chunk }, undefined, chunk.length);
      }
    } finally { release(); }
  }

  retain(): () => void {
    if (this.#closed !== undefined) throw this.#closed;
    if (this.#activities >= 128) throw new VMError("QUOTA_EXCEEDED", "Process logical I/O capacity exhausted");
    this.#activities += 1;
    let released = false;
    return () => {
      if (released) throw new VMError("PROTOCOL_ERROR", "Process activity released twice");
      released = true;
      this.#activities -= 1;
      this.#notifyDrained();
    };
  }

  #dispatch(event: BrokerEvent, request: AssistanceRequest | undefined, charge: number, control = false, referenced = true, fork = false): Promise<AssistanceResult> {
    const controlCapacity = Math.min(2 * ASSISTANCE_LIMITS.request, this.#capacity * 3 / 8);
    const used = control ? this.#controlBytes : this.#bytes - this.#controlBytes;
    const capacity = control ? controlCapacity : this.#capacity - controlCapacity;
    if (this.#pending.size >= (control ? 128 : 127) || used + charge > capacity) {
      throw new VMError("QUOTA_EXCEEDED", "Process pending traffic exhausted");
    }
    this.#sequence = event.identity.sequence;
    const completion = Promise.withResolvers<AssistanceResult>();
    this.#pending.set(event.identity.sequence, { request, completion, charge, control, referenced, fork });
    this.#bytes += charge;
    if (control) this.#controlBytes += charge;
    try { this.#send(event); }
    catch (error) { this.close(error); }
    return completion.promise;
  }

  setCallbackScheduler(schedule: (callback: () => void) => void): void {
    if (this.#schedule !== undefined) throw new VMError("PROTOCOL_ERROR", "Process callback scheduler already installed");
    this.#schedule = schedule;
  }

  receive(value: unknown): void {
    const command = decodeBrokerCommand(value);
    if (this.#closed !== undefined) throw this.#closed;
    if (this.#schedule === undefined) this.#receive(command);
    else this.#schedule(() => { if (this.#closed === undefined) this.#receive(command); });
  }

  #receive(command: BrokerCommand): void {
    const identity = command.identity;
    if (identity.session !== this.#binding.session
      || identity.generation !== this.#binding.generation || identity.process !== this.#binding.process) {
      throw new VMError("PROTOCOL_ERROR", "Invalid process completion identity");
    }
    if (command.kind === "input") {
      if (identity.sequence !== this.#commandSequence + 1 || this.#input === undefined || this.#inputPending) {
        throw new VMError("PROTOCOL_ERROR", "Invalid or concurrent process input");
      }
      this.#commandSequence = identity.sequence;
      this.#inputPending = true;
      void this.#input(command.bytes).then(() => {
        const acknowledgement = this.#identity(); this.#sequence = acknowledgement.sequence;
        this.#send({ kind: "input-ack", identity: acknowledgement, sequence: identity.sequence });
      }).catch((error: unknown) => this.fail(error)).finally(() => {
        this.#inputPending = false; this.#notifyDrained();
      });
      return;
    }
    if (command.kind === "event") {
      const event = decodeAssistanceEvent(command.bytes);
      if (identity.sequence !== this.#commandSequence + 1 || event.sequence <= this.#guestSequence
        || event.event.kind === "failure" || this.#childEvents === undefined) {
        throw new VMError("PROTOCOL_ERROR", "Invalid process child event");
      }
      this.#commandSequence = identity.sequence;
      this.#guestSequence = event.sequence;
      this.#childEvents(event);
      return;
    }
    if (command.kind === "fork-channel") {
      // Broker-originated: it carries only a port and is not sequenced.
      if (this.#forkEvents === undefined) throw new VMError("PROTOCOL_ERROR", "Fork channel without a fork owner");
      this.#forkEvents.channel(command.child, command.port);
      return;
    }
    if (command.kind === "fork-output" || command.kind === "fork-exit" || command.kind === "signal") {
      if (identity.sequence !== this.#commandSequence + 1) throw new VMError("PROTOCOL_ERROR", "Out-of-order fork command");
      if (command.kind === "signal" ? this.#signals === undefined : this.#forkEvents === undefined) {
        throw new VMError("PROTOCOL_ERROR", "Fork command without an owner");
      }
      this.#commandSequence = identity.sequence;
      if (command.kind === "fork-output") this.#forkEvents?.output(command.child, command.stream, command.bytes, command.chunk);
      else if (command.kind === "fork-exit") this.#forkEvents?.exit(command.child, command.termination);
      else this.#signals?.(command.signal);
      return;
    }
    if (command.kind !== "reply") throw new VMError("PROTOCOL_ERROR", "Invalid process command");
    const pending = this.#pending.get(identity.sequence);
    if (pending === undefined) throw new VMError("PROTOCOL_ERROR", "Duplicate or unknown process completion");
    if (pending.request !== undefined && command.bytes.byteLength > assistanceReplyCapacity(pending.request.operation)) {
      throw new VMError("PROTOCOL_ERROR", "Process reply exceeds its reservation");
    }
    const reply = decodeAssistanceReply(command.bytes, BROKER_REPLY_VERSION);
    if (pending.request !== undefined) matchAssistanceReply(pending.request, reply);
    else if (reply.result.kind !== "unit" && !(pending.fork && reply.result.kind === "error")) throw new VMError("PROTOCOL_ERROR", "Invalid output acknowledgement");
    this.#pending.delete(identity.sequence);
    this.#bytes -= pending.charge;
    if (pending.control) this.#controlBytes -= pending.charge;
    pending.completion.resolve(reply.result);
    this.#notifyDrained();
  }

  setInput(receive: (bytes: Uint8Array | null) => Promise<void>): void {
    if (this.#input !== undefined) throw new VMError("PROTOCOL_ERROR", "Input owner already installed");
    this.#input = receive;
  }

  setChildEvents(receive: (event: ProcessChildEvent) => void): void {
    if (this.#childEvents !== undefined) throw new VMError("PROTOCOL_ERROR", "Child event owner already installed");
    this.#childEvents = receive;
  }

  setForkEvents(receive: ForkEvents): void {
    if (this.#forkEvents !== undefined) throw new VMError("PROTOCOL_ERROR", "Fork event owner already installed");
    this.#forkEvents = receive;
  }

  setSignals(receive: (signal: Exclude<ChildSignal, "KILL">) => void): void {
    if (this.#signals !== undefined) throw new VMError("PROTOCOL_ERROR", "Signal owner already installed");
    this.#signals = receive;
  }

  async drain(): Promise<void> {
    while (this.hasPending) {
      this.#drained ??= Promise.withResolvers<undefined>();
      await this.#drained.promise;
    }
    if (this.#closed !== undefined) throw this.#closed;
  }

  exit(code: number, immediate = false): void {
    if (!immediate && this.hasPending) throw new VMError("PROTOCOL_ERROR", "Process still has pending I/O");
    const identity = this.#identity();
    this.#sequence = identity.sequence;
    this.#send({ kind: immediate ? "exit-request" : "exit", identity, code });
  }

  /** Explicit exit cannot return, throw a catchable sentinel, or leave queued
   * application jobs running. The broker terminates this worker independently. */
  terminate(code: number): never {
    this.exit(code, true);
    return this.halt();
  }

  /** A signal without a listener ends the process; control retires it. */
  signalExit(signal: ExitSignal): void {
    const identity = this.#identity();
    this.#sequence = identity.sequence;
    this.#send({ kind: "exit-signal", identity, signal });
  }

  halt(): never {
    const control = new ControlWords(this.#buffer, 0, 1);
    for (;;) wait(control, 0, load(control, 0));
  }

  get hasPending(): boolean { return [...this.#pending.values()].some(pending => pending.referenced) || this.#activities !== 0 || this.#inputPending || this.#supervising || this.#supervision.length !== 0; }

  fail(error: unknown): void {
    if (this.#closed !== undefined) return;
    const identity = this.#identity();
    this.#sequence = identity.sequence;
    try { this.#send({ kind: "failed", identity, error: failureWithStack(error) }); }
    finally { this.close(error); }
  }

  close(error: unknown): void {
    if (this.#closed !== undefined) return;
    this.#closed = error instanceof Error ? error : deserializeError(serializeUnknownError(error));
    closeMailbox(this.#buffer);
    for (const pending of this.#pending.values()) pending.completion.reject(this.#closed);
    this.#pending.clear();
    for (const pending of this.#supervision.splice(0)) pending.completion.reject(this.#closed);
    this.#bytes = 0;
    this.#controlBytes = 0;
    this.#notifyDrained();
  }

  #notifyDrained(): void {
    if (!this.hasPending) { this.#drained?.resolve(undefined); this.#drained = undefined; }
  }
}

/** The failure event's error keeps a bounded stack of an uncaught error: its
 * message alone cannot locate the fault in application code. */
const FAILURE_STACK_BYTES = 4096;
function failureWithStack(error: unknown): ReturnType<typeof serializeUnknownError> {
  const serialized = serializeUnknownError(error);
  if (!(error instanceof Error) || typeof error.stack !== "string" || error.stack.length === 0) return serialized;
  const stack = error.stack.length > FAILURE_STACK_BYTES ? error.stack.slice(0, FAILURE_STACK_BYTES) : error.stack;
  return { ...serialized, detail: { ...serialized.detail, stack } };
}

/** Shared runtime port. Each transport retains its own identities and message codecs. */
export type NetworkInterfaces = Record<string, { address: string; netmask: string; family: "IPv4" | "IPv6"; mac: string; internal: boolean; cidr: string; scopeid?: number }[]>;
export interface CapturedProcess {
  readonly pid: number;
  readonly status: number | null;
  readonly signal: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly error?: "ENOBUFS";
}
export type ProcessRuntimeIO = Pick<ProcessIO,
  "callSync" | "call" | "retain" | "hasPending" | "drain" | "setCallbackScheduler" |
  "setInput" | "setChildEvents" | "setSignals" | "forkSync" | "forkInput" |
  "forkOutputAck" | "setForkEvents" | "fail" | "terminate" | "signalExit" | "halt" | "setExceptionHandler" | "applicationException"
> & {
  ready(readRequested: Promise<undefined>, closed: AbortSignal): void;
  networkInterfaces?(): NetworkInterfaces;
  signalProcess?(pid: number, signal: number): void;
  readonly copyOpenMode?: 10;
  spawnSync?(input: Extract<AssistanceOperation, { kind: "spawn" }>, stdio: NonNullable<NativeChildSpec["stdio"]>): AssistanceResult;
  captureSync?(input: Extract<AssistanceOperation, { kind: "spawn" }>, bytes: Uint8Array, maxBuffer: number, options?: { readonly runtime: "bun"; readonly path?: string }): CapturedProcess;
  output(stream: "stdout" | "stderr", bytes: Uint8Array): Promise<void> | void;
  forkSignal(child: number, signal: ChildSignal): AssistanceResult | Promise<AssistanceResult>;
};

export type ProcessChildEvent = Pick<AssistanceEvent, "sequence" | "event">;
