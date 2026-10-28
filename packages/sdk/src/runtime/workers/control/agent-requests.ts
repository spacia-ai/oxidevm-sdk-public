import { AGENT_RESPONSE_BIT, type AgentFrame } from "../../agent-protocol.js";
import { VMError } from "../../errors.js";

const MAX_REQUESTS = 1024;

type Outcome =
  | { readonly kind: "response"; readonly frame: AgentFrame }
  | { readonly kind: "failure"; readonly error: VMError };

/** A wakeup never rejects: polling and passive consumers inspect the same outcome. */
export class AgentRequest {
  readonly completed: Promise<void>;
  #wake: () => void = () => {};
  #outcome: Outcome | undefined;

  constructor(readonly id: number, readonly kind: number, readonly workerRequestId: number | undefined) {
    this.completed = new Promise(resolve => { this.#wake = resolve; });
  }

  response(): AgentFrame | undefined {
    if (this.#outcome?.kind === "failure") throw this.#outcome.error;
    return this.#outcome?.frame;
  }

  get settled(): boolean { return this.#outcome !== undefined; }

  complete(frame: AgentFrame): void {
    if (this.settled) throw new VMError("PROTOCOL_ERROR", "guest agent returned a duplicate response");
    this.#outcome = { kind: "response", frame };
    this.#wake();
  }

  fail(error: VMError): void {
    if (this.settled) return;
    this.invalidate(error);
  }

  invalidate(error: VMError): void {
    this.#outcome = { kind: "failure", error };
    this.#wake();
  }
}

/** Single correlation owner for polling startup calls and passive live-VM calls. */
export class AgentRequests {
  readonly #pending = new Map<number, AgentRequest>();
  readonly #abandoned = new Map<number, number>();
  #nextId = 1;
  /** Ids below the floor belong to a session before a restore; their late replies are dropped. */
  #floor = 1;
  #dropped = 0;
  #completed = 0;

  get size(): number { return this.#pending.size; }

  /** The id the next request takes. */
  get nextId(): number { return this.#nextId; }

  /** Replies dropped because they answered a request from before a restore. */
  get dropped(): number { return this.#dropped; }

  /** Replies that completed a waiting request. Its waiter continues after the current run slice. */
  get completed(): number { return this.#completed; }

  /** Continues a restored session whose guest may still answer requests below `nextId`. */
  resume(nextId: number): void {
    if (!Number.isInteger(nextId) || nextId < 1 || nextId > 0x1_0000_0000) {
      throw new VMError("PROTOCOL_ERROR", "guest request id floor is invalid");
    }
    this.reset();
    this.#nextId = Math.max(this.#nextId, nextId);
    this.#floor = nextId;
  }

  /** Whether `id` belongs to the session before a restore. */
  belowFloor(id: number): boolean { return id < this.#floor; }

  /** Counts a frame dropped because it belongs to the session before a restore. */
  drop(): void { this.#dropped += 1; }

  open(kind: number, workerRequestId?: number): AgentRequest {
    if (this.#pending.size + this.#abandoned.size >= MAX_REQUESTS) {
      throw new VMError("QUOTA_EXCEEDED", "guest agent request limit exceeded");
    }
    // Never reuse an ID, including after reset: a delayed v3 frame cannot match
    // a replacement task. Newer dialects additionally carry VM generation.
    if (this.#nextId > 0xffff_ffff) {
      throw new VMError("QUOTA_EXCEEDED", "guest request id space is exhausted");
    }
    const request = new AgentRequest(this.#nextId++, kind, workerRequestId);
    this.#pending.set(request.id, request);
    return request;
  }

  get(id: number): AgentRequest {
    const request = this.#pending.get(id);
    if (request === undefined) throw new VMError("PROTOCOL_ERROR", "guest request is not pending");
    return request;
  }

  receive(frame: AgentFrame): void {
    const request = this.#pending.get(frame.requestId);
    if (request === undefined) {
      const kind = this.#abandoned.get(frame.requestId);
      if (kind !== undefined) {
        if (frame.kind !== (kind | AGENT_RESPONSE_BIT)) {
          throw new VMError("PROTOCOL_ERROR", "guest agent returned the wrong response kind");
        }
        this.#abandoned.delete(frame.requestId);
        return;
      }
      if (this.belowFloor(frame.requestId)) {
        this.drop();
        return;
      }
      throw new VMError("PROTOCOL_ERROR", "guest agent returned an unknown response");
    }
    if (frame.kind !== (request.kind | AGENT_RESPONSE_BIT)) {
      throw new VMError("PROTOCOL_ERROR", "guest agent returned the wrong response kind");
    }
    request.complete(frame);
    this.#completed += 1;
  }

  finish(request: AgentRequest): void {
    if (!request.settled) throw new VMError("PROTOCOL_ERROR", "guest request has not completed");
    if (this.#pending.get(request.id) === request) this.#pending.delete(request.id);
  }

  abandon(request: AgentRequest, error = new VMError("ABORTED", "guest request was cancelled")): void {
    if (this.#pending.get(request.id) !== request) return;
    this.#pending.delete(request.id);
    if (!request.settled) {
      this.#abandoned.set(request.id, request.kind);
      request.fail(error);
    }
  }

  reset(): void {
    for (const request of this.#pending.values()) {
      request.invalidate(new VMError("ABORTED", "guest generation was replaced"));
    }
    this.#pending.clear();
    this.#abandoned.clear();
  }

  cancelWorker(workerRequestId: number): void {
    for (const request of this.#pending.values()) {
      if (request.workerRequestId === workerRequestId && !request.settled) this.abandon(request);
    }
  }

  failPending(error: VMError): void {
    for (const request of this.#pending.values()) this.abandon(request, error);
  }

  /** No core access or execution pump: the live VM delivers replies independently. */
  async wait(request: AgentRequest, timeoutMilliseconds: number | null, signal?: AbortSignal): Promise<AgentFrame> {
    if (timeoutMilliseconds !== null && (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0 || timeoutMilliseconds > 0x7fff_ffff)) {
      this.abandon(request);
      throw new VMError("INVALID_ARGUMENT", "invalid guest request timeout");
    }
    const abort = () => {
      if (!request.settled) this.abandon(request);
    };
    const timer = timeoutMilliseconds === null ? undefined : setTimeout(() => {
      if (!request.settled) this.abandon(request, new VMError("GUEST_CRASH", "guest agent response deadline exceeded", {
        requestId: request.id, kind: request.kind,
      }));
    }, timeoutMilliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    try {
      await request.completed;
      const frame = request.response();
      if (frame === undefined) throw new VMError("PROTOCOL_ERROR", "guest request completed without a response");
      return frame;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.finish(request);
    }
  }
}
