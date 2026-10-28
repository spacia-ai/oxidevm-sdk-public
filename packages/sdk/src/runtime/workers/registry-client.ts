import { REGISTRY_PROTOCOL_VERSION } from "../protocol/registry.js";
import type { RegistryRepresentation } from "../protocol/registry.js";
import { VMError, deserializeError, serializeUnknownError } from "../errors.js";
import type { AssistanceCredit } from "../protocol/assistance-credit.js";
import { decodeRegistryReply, decodeRegistryRequest, type RegistryBinding, type RegistryReply, type RegistryRequest } from "../protocol/registry.js";
import type { RegistryBudget, RegistryTransport } from "./registry-transport.js";

type Headers = Extract<RegistryReply, { kind: "headers" }>;
type Data = Extract<RegistryReply, { kind: "data" }>;
export interface RegistryDelivery<T> {
  readonly value: T;
  /** Transfer ownership only after the downstream consumer has accepted it. */
  acknowledge(): void;
}
interface Pending {
  readonly kind: "start" | "read" | "cancel";
  readonly request: number | undefined;
  readonly control: number;
  data: number | undefined;
  readonly result: PromiseWithResolvers<RegistryReply>;
  readonly identity: PromiseWithResolvers<number> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly dispatch: AbortController;
  started: number | undefined;
}
interface RequestState { readonly reservation: number; pending: boolean; closed: boolean }

/** Control-side registry transport. Sender buffers and downstream-held replies
 * spend the same VM budget as the network producer's separately issued grants. */
export class RegistryClient {
  readonly #port: RegistryTransport;
  readonly #binding: RegistryBinding;
  readonly #traffic: RegistryBudget;
  readonly #peerRetired: (credits: readonly AssistanceCredit[]) => void;
  readonly #grants: readonly AssistanceCredit[];
  readonly #failed: (error: VMError) => void;
  readonly #owned = new Set<number>();
  readonly #pending = new Map<number, Pending>();
  readonly #queued = new Set<Pending>();
  readonly #dispatches = new Set<Promise<void>>();
  readonly #dispatch = new AbortController();
  readonly #requests = new Map<number, RequestState>();
  readonly #completion = Promise.withResolvers<undefined>();
  readonly done = this.#completion.promise;
  #sequence = 0;
  #received = 0;
  #lastRequest = 0;
  #closing = false;
  #retired = false;
  #failure: VMError | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(port: RegistryTransport, binding: RegistryBinding, traffic: RegistryBudget,
    grants: readonly AssistanceCredit[], failed: (error: VMError) => void,
    peerRetired: (credits: readonly AssistanceCredit[]) => void) {
    this.#port = port; this.#binding = binding; this.#traffic = traffic;
    this.#grants = grants; this.#failed = failed;
    this.#peerRetired = peerRetired;
    // Covers bounded acknowledgement/cancellation/retirement traffic even when
    // every data reservation is held by a downstream guest consumer.
    this.#reserve("control", 64 * 1024);
    void this.done.catch(() => undefined);
    port.start(value => {
      try { this.#receive(decodeRegistryReply(value)); }
      catch (error) { this.fail(error); }
    }, error => this.fail(error));
  }

  start(url: string, signal?: AbortSignal, representation: RegistryRepresentation = "full"): { readonly identity: Promise<number>; readonly response: Promise<RegistryDelivery<Headers>> } {
    this.#active();
    signal?.throwIfAborted();
    // Validate before reserving or copying user-controlled URL data.
    decodeRegistryRequest({ version: REGISTRY_PROTOCOL_VERSION, ...this.#binding, sequence: 1, kind: "start", url, representation });
    const pending = this.#command("start", undefined, url, representation);
    if (signal !== undefined) {
      // Before dispatch there is no remote request identity to cancel. Abort
      // the existing credit waiter; after dispatch the early identity owns
      // cancellation and independent producer retirement as usual.
      const abort = (): void => pending.dispatch.abort();
      const detach = (): void => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void pending.result.promise.then(detach, detach);
    }
    if (pending.identity === undefined) throw new VMError("PROTOCOL_ERROR", "Missing registry startup identity");
    return { identity: pending.identity.promise, response: pending.result.promise.then(reply => {
      if (reply.kind !== "headers") throw new VMError("PROTOCOL_ERROR", "Missing registry headers");
      return this.#delivery(reply, pending);
    }) };
  }

  read(request: number): Promise<RegistryDelivery<Data>> {
    this.#active();
    const state = this.#requests.get(request);
    if (state === undefined || state.closed) throw new VMError("ABORTED", "Registry request is closed");
    if (state.pending) throw new VMError("PROTOCOL_ERROR", "Registry delivery requires acknowledgement");
    const pending = this.#command("read", request);
    state.pending = true;
    return pending.result.promise.then(reply => {
      if (reply.kind !== "data") throw new VMError("PROTOCOL_ERROR", "Missing registry data");
      return this.#delivery(reply, pending);
    });
  }

  cancel(request: number): Promise<void> {
    this.#active();
    const state = this.#requests.get(request);
    if (!Number.isInteger(request) || request < 1 || request > this.#lastRequest) throw new VMError("PROTOCOL_ERROR", "Unknown registry request");
    if (state === undefined) return Promise.resolve();
    const pending = this.#command("cancel", request);
    state.closed = true;
    for (const queued of this.#queued) if (queued.request === request) queued.dispatch.abort();
    return pending.result.promise.then(() => {
      if (this.#requests.get(request) === state) {
        this.#release(state.reservation);
        this.#requests.delete(request);
      }
    });
  }

  #command(kind: Pending["kind"], request?: number, url?: string, representation?: RegistryRepresentation): Pending {
    const control = this.#reserve("control", kind === "cancel" ? 1024 : 32 * 1024);
    const identity = kind === "start" ? Promise.withResolvers<number>() : undefined;
    if (identity !== undefined) void identity.promise.catch(() => undefined);
    const pending: Pending = { kind, request, control, data: undefined, identity, result: Promise.withResolvers<RegistryReply>(), started: undefined, dispatch: new AbortController(),
      timer: undefined };
    this.#queued.add(pending);
    const dispatch = this.#dispatchCommand(pending, url, representation).finally(() => this.#dispatches.delete(dispatch));
    this.#dispatches.add(dispatch);
    return pending;
  }

  async #dispatchCommand(pending: Pending, url?: string, representation?: RegistryRepresentation): Promise<void> {
    try {
      if (pending.kind !== "cancel") {
        pending.data = await this.#traffic.acquire(
          pending.kind === "start" ? 512 * 1024 : 192 * 1024 + 1024,
          AbortSignal.any([this.#dispatch.signal, pending.dispatch.signal]));
        this.#owned.add(pending.data);
      }
      this.#active();
      if (pending.dispatch.signal.aborted) throw new VMError("ABORTED", "Registry dispatch cancelled");
      // Allocate sequence at dispatch, so supervision can overtake queued data.
      const sequence = this.#next();
      this.#queued.delete(pending);
      this.#pending.set(sequence, pending);
      // The network owner times actual I/O, excluding its receive-credit wait.
      // Cancellation uses reserved control capacity and must not wait for data.
      if (pending.kind === "cancel") pending.timer = setTimeout(() => this.fail(new VMError("RELAY_ERROR", "Registry reply deadline exceeded")), 60_000);
      this.#send({ version: REGISTRY_PROTOCOL_VERSION, ...this.#binding, sequence, kind: pending.kind,
        ...(pending.kind === "start" ? { url, representation } : { request: pending.request }) });
    } catch (error) {
      if (this.#queued.delete(pending)) {
        clearTimeout(pending.timer);
        if (pending.data !== undefined) this.#release(pending.data);
        this.#release(pending.control);
        pending.identity?.reject(error); pending.result.reject(error);
      }
      if (!this.#closing && !pending.dispatch.signal.aborted) this.fail(error);
    }
  }

  #receive(reply: RegistryReply): void {
    if (reply.version !== REGISTRY_PROTOCOL_VERSION || reply.session !== this.#binding.session || reply.generation !== this.#binding.generation
      || reply.installation !== this.#binding.installation || reply.sequence !== this.#received + 1) {
      throw new VMError("PROTOCOL_ERROR", "Wrong registry reply identity or sequence");
    }
    this.#received = reply.sequence;
    if (this.#closing) {
      if (reply.kind === "retired") this.#finish(reply);
      // The receiver is fenced. The retirement receipt covers queued replies.
      return;
    }
    const pending = this.#pending.get(reply.correlation);
    if (pending === undefined) throw new VMError("PROTOCOL_ERROR", "Unknown registry reply correlation");
    if (reply.kind === "started") {
      if (pending.kind !== "start" || pending.started !== undefined || reply.request !== this.#lastRequest + 1) {
        throw new VMError("PROTOCOL_ERROR", "Invalid registry startup identity");
      }
      const reservation = this.#reserve("control", 128);
      this.#requests.set(reply.request, { reservation, pending: true, closed: false });
      this.#lastRequest = reply.request; pending.started = reply.request;
      this.#ackControl(reply);
      pending.identity?.resolve(reply.request);
      return;
    }
    if (reply.kind === "failure") {
      if (reply.error.detail?.["cleanupFailed"] === true) throw deserializeError(reply.error);
      this.#ackControl(reply);
      const error = deserializeError(reply.error);
      pending.identity?.reject(error); pending.result.reject(error);
      if (pending.data !== undefined) this.#release(pending.data);
      const state = this.#requests.get(pending.started ?? pending.request ?? 0);
      if (state !== undefined) state.closed = true;
    } else {
      if ((reply.kind === "headers" && (pending.kind !== "start" || pending.started !== reply.request))
        || (reply.kind === "data" && (pending.kind !== "read" || pending.request !== reply.request))
        || (reply.kind === "cancelled" && (pending.kind !== "cancel" || pending.request !== reply.request))
        || reply.kind === "retired") throw new VMError("PROTOCOL_ERROR", "Wrong registry completion");
      if (reply.kind === "cancelled") this.#ackControl(reply);
      pending.result.resolve(reply);
    }
    clearTimeout(pending.timer); this.#pending.delete(reply.correlation); this.#release(pending.control);
  }

  #delivery<T extends Headers | Data>(value: T, pending: Pending): RegistryDelivery<T> {
    this.#active();
    const reservation = pending.data;
    if (reservation === undefined) throw new VMError("PROTOCOL_ERROR", "Missing registry receive reservation");
    let acknowledged = false;
    return { value, acknowledge: () => {
      this.#active();
      if (acknowledged) throw new VMError("PROTOCOL_ERROR", "Duplicate registry acknowledgement");
      this.#send({ version: REGISTRY_PROTOCOL_VERSION, ...this.#binding, sequence: this.#next(), kind: "acknowledge", request: value.request, reservation: value.reservation });
      this.#active();
      acknowledged = true;
      this.#release(reservation);
      const state = this.#requests.get(value.request);
      if (state !== undefined) {
        state.pending = false;
        if (value.kind === "data" && value.done) {
          this.#release(state.reservation);
          this.#requests.delete(value.request);
        }
      }
    } };
  }

  #ackControl(reply: Extract<RegistryReply, { kind: "started" | "cancelled" | "failure" }>): void {
    this.#send({ version: REGISTRY_PROTOCOL_VERSION, ...this.#binding, sequence: this.#next(), kind: "acknowledge-control",
      correlation: reply.correlation, reservation: reply.reservation });
    this.#active();
  }

  close(): Promise<undefined> {
    if (!this.#closing && this.#failure === undefined) {
      this.#closing = true;
      this.#dispatch.abort();
      this.#rejectPending(new VMError("ABORTED", "Registry installation retired"));
      this.#timer = setTimeout(() => this.fail(new VMError("RELAY_ERROR", "Registry retirement deadline exceeded")), 60_000);
      void this.#retire().catch((error: unknown) => this.fail(error));
    }
    return this.done;
  }

  async #retire(): Promise<void> {
    await Promise.all(this.#dispatches);
    if (this.#failure === undefined) this.#send({ version: REGISTRY_PROTOCOL_VERSION, ...this.#binding, sequence: this.#next(), kind: "retire" });
  }

  #finish(reply: Extract<RegistryReply, { kind: "retired" }>): void {
    if (reply.correlation !== this.#sequence || reply.credits.length !== this.#grants.length
      || reply.credits.some(credit => !this.#grants.some(grant => grant.reservation === credit.reservation
        && grant.sequence === credit.sequence && grant.pool === credit.pool && grant.bytes === credit.bytes && grant.entries === credit.entries))) {
      throw new VMError("PROTOCOL_ERROR", "Wrong registry retirement credits");
    }
    this.#peerRetired(reply.credits);
    for (const reservation of this.#owned) this.#traffic.release(reservation);
    this.#owned.clear(); this.#pending.clear(); this.#requests.clear();
    this.#retired = true; this.#detach(); this.#completion.resolve(undefined);
  }

  fail(error: unknown): void {
    if (this.#failure !== undefined || this.#retired) return;
    this.#failure = deserializeError(serializeUnknownError(error));
    this.#dispatch.abort();
    this.#closing = true; this.#detach(); this.#rejectPending(this.#failure);
    this.#completion.reject(this.#failure); this.#failed(this.#failure);
  }

  #rejectPending(error: VMError): void {
    for (const pending of [...this.#queued, ...this.#pending.values()]) {
      clearTimeout(pending.timer); pending.identity?.reject(error); pending.result.reject(error);
    }
  }
  #detach(): void {
    clearTimeout(this.#timer); this.#port.close();
  }
  #active(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closing) throw new VMError("ABORTED", "Registry installation retired");
  }
  #next(): number {
    if (this.#sequence === 0xffff_ffff) throw new VMError("PROTOCOL_ERROR", "Registry request sequence exhausted");
    return ++this.#sequence;
  }
  #reserve(pool: "data" | "control", bytes: number): number {
    const reservation = this.#traffic.reserve(pool, bytes); this.#owned.add(reservation); return reservation;
  }
  #release(reservation: number): void {
    this.#traffic.release(reservation); this.#owned.delete(reservation);
  }
  #send(value: unknown): void {
    try { const request: RegistryRequest = decodeRegistryRequest(value); this.#port.send(request); }
    catch (error) { this.fail(error); }
  }
}
