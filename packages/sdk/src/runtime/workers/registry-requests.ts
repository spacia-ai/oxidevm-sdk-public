import { VMError } from "../errors.js";
import type { GrantedTraffic } from "./assistance/traffic.js";
import { openRegistryResponse, type RegistryGatewayPolicy, type RegistryRelayFetch } from "./registry-fetch.js";
import type { RegistryNetworkProfile, RegistryRepresentation } from "../protocol/registry.js";

type ResponseOwner = Awaited<ReturnType<typeof openRegistryResponse>>;
interface Request {
  readonly controller: AbortController;
  readonly acquisition: AbortController;
  readonly lifetime: number;
  working: number | undefined;
  response?: ResponseOwner;
  opening?: Promise<void>;
  reading?: Promise<void>;
  closing?: Promise<void>;
  pending?: number;
  delivered: boolean;
  closed: boolean;
  failed: boolean;
  retired: boolean;
}

/** One installation's network requests spend issued credit, never a separate
 * budget. Each reply permits one acknowledgement before another read. */
export class RegistryRequests {
  readonly #traffic: GrantedTraffic;
  readonly #policy: RegistryGatewayPolicy;
  readonly #requests = new Map<number, Request>();
  readonly #now: () => number;
  readonly #relay:RegistryRelayFetch|undefined;
  readonly #profile = { requests: 0, bytes: 0, creditWaitMs: 0, upstreamMs: 0 };
  #sequence = 0;
  #retiring: Promise<void> | undefined;

  constructor(traffic: GrantedTraffic, policy: RegistryGatewayPolicy, now: () => number = () => performance.now(), relay?:RegistryRelayFetch) {
    this.#traffic = traffic;
    this.#policy = policy;
    this.#now = now;this.#relay=relay;
  }

  /** Attribution only: cumulative credit waits and upstream fetch/read time. */
  profile(): RegistryNetworkProfile { return { ...this.#profile }; }

  start(url: string, representation: RegistryRepresentation = "full") {
    if (this.#retiring !== undefined) throw new VMError("ABORTED", "Registry transport retired");
    if (this.#sequence === 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Registry request identities exhausted");
    for (const [id, owner] of this.#requests) {
      if (owner.retired && owner.pending === undefined) this.#requests.delete(id);
    }
    const lifetime = this.#traffic.reserve("control", 128);
    const request = ++this.#sequence;
    const state: Request = { controller: new AbortController(), acquisition: new AbortController(), lifetime, working: undefined,
      delivered: false, closed: false, failed: false, retired: false };
    this.#requests.set(request, state);
    const ready = Promise.withResolvers<undefined>();
    const opening = this.#open(state, url, representation, () => ready.resolve(undefined));
    state.opening = opening.then(() => undefined, () => undefined);
    return { request, response: this.#wait(state, this.#headers(state, opening, request), "headers", ready.promise) };
  }

  async #headers(state: Request, opening: Promise<ResponseOwner>, request: number) {
    const response = await opening;
    requireOpen(state);
    const reservation = state.pending;
    if (reservation === undefined) throw new VMError("PROTOCOL_ERROR", "Registry header credit is missing");
    state.delivered = true;
    return { request, reservation, status: response.status, headers: response.headers };
  }

  async #open(state: Request, url: string, representation: RegistryRepresentation, ready: () => void): Promise<ResponseOwner> {
    try {
      // Acquire rewriting workspace and header copies together: partial
      // acquisitions across concurrent opens can otherwise exhaust the window.
      const working = this.#policy.gatewayOrigin === undefined ? 0 : 128 * 1024;
      const acquiring = this.#now();
      state.pending = await this.#traffic.acquire(512 * 1024 + working, state.acquisition.signal);
      this.#profile.creditWaitMs += this.#now() - acquiring;
      requireOpen(state);
      if (working !== 0) state.working = this.#traffic.split(state.pending, working);
      ready();
      const fetching = this.#now();
      const response = await openRegistryResponse(url, this.#policy, state.controller.signal, representation, this.#relay);
      this.#profile.upstreamMs += this.#now() - fetching;
      this.#profile.requests += 1;
      state.response = response;
      if (state.closed) {
        await response.close();
        throw new VMError("ABORTED", "Registry request cancelled");
      }
      return response;
    } catch (error) {
      state.failed = error instanceof VMError && error.detail?.["cleanupFailed"] === true;
      if (!state.failed) {
        this.#releasePending(state);
        this.#traffic.release(state.lifetime);
        if (state.working !== undefined) this.#traffic.release(state.working);
        state.retired = true;
        for (const [id, owner] of this.#requests) if (owner === state) this.#requests.delete(id);
      }
      throw error;
    }
  }

  async read(request: number) {
    const state = this.#get(request);
    requireOpen(state);
    if (state.pending !== undefined || state.response === undefined || state.reading !== undefined) {
      throw new VMError("PROTOCOL_ERROR", "Registry reply is still pending");
    }
    state.delivered = false;
    const ready = Promise.withResolvers<undefined>();
    const reading = this.#read(state, state.response, () => ready.resolve(undefined));
    state.reading = reading.then(() => undefined, () => undefined);
    try {
      const result = await this.#wait(state, reading, "body", ready.promise);
      requireOpen(state);
      state.delivered = true;
      // EOF is terminal only after upstream cleanup; retain the reply buffer
      // until acknowledgement, but retire the producer and its lifetime now.
      if (result.done) await this.cancel(request);
      return result;
    } finally { delete state.reading; }
  }

  async #read(state: Request, response: ResponseOwner, ready: () => void) {
    // Acquire before allocating BYOB storage, encoding, or transport copies.
    const acquiring = this.#now();
    const reservation = await this.#traffic.acquire(192 * 1024 + 1024, state.acquisition.signal);
    this.#profile.creditWaitMs += this.#now() - acquiring;
    state.pending = reservation;
    requireOpen(state);
    ready();
    const reading = this.#now();
    const result = await response.read(new Uint8Array(64 * 1024));
    this.#profile.upstreamMs += this.#now() - reading;
    this.#profile.bytes += result.bytes.byteLength;
    return { ...result, reservation };
  }

  acknowledge(request: number, reservation: number): void {
    const state = this.#get(request);
    if (!state.delivered || state.pending !== reservation) throw new VMError("PROTOCOL_ERROR", "Invalid registry acknowledgement");
    this.#releasePending(state);
    if (state.retired) this.#requests.delete(request);
  }

  cancel(request: number): Promise<void> {
    const state = this.#requests.get(request);
    if (state === undefined) {
      // IDs are consecutive and never reused. Removed requests have confirmed
      // retirement, so delayed cancellation needs no tombstone or second release.
      if (Number.isInteger(request) && request >= 1 && request <= this.#sequence) return Promise.resolve();
      throw new VMError("PROTOCOL_ERROR", "Unknown registry request");
    }
    if (state.closing !== undefined) return state.closing;
    state.closing = this.#close(state);
    return state.closing;
  }

  async #close(state: Request): Promise<void> {
    state.closed = true;
    state.acquisition.abort();
    const reading = state.reading;
    if (state.response === undefined) state.controller.abort();
    await state.opening;
    if (state.retired) return;
    if (state.failed) throw new VMError("RELAY_ERROR", "Registry startup cleanup failed");
    if (state.response === undefined) return;
    // Close first: aborting first would hide a pre-existing upstream failure.
    await state.response.close();
    await reading;
    state.controller.abort();
    if (!state.delivered) this.#releasePending(state);
    this.#traffic.release(state.lifetime);
    if (state.working !== undefined) this.#traffic.release(state.working);
    state.retired = true;
  }

  /** Call after fencing/closing the receiving transport, so undelivered and
   * unacknowledged replies can no longer remain owned by its peer. */
  retire(): Promise<void> {
    this.#retiring ??= this.#retire();
    return this.#retiring;
  }

  async #retire(): Promise<void> {
    const results = await deadline(Promise.allSettled([...this.#requests.keys()].map(id => this.cancel(id))), "retirement");
    for (const result of results) if (result.status === "rejected") throw result.reason;
    for (const state of this.#requests.values()) this.#releasePending(state);
    this.#requests.clear();
  }

  #wait<T>(state: Request, operation: Promise<T>, phase: "headers" | "body", ready: Promise<undefined>): Promise<T> {
    // Cancellation may finish before credit is available. Only actual network
    // work starts the deadline, while its owner still retains late completions.
    return Promise.race([operation, ready.then(() => deadline(operation, phase, () => {
      if (state.closing === undefined) state.closing = this.#close(state);
      // Preserve failed cleanup for the supervising retirement operation.
      void state.closing.catch(() => { state.failed = true; });
    }))]);
  }

  #get(request: number): Request {
    const state = this.#requests.get(request);
    if (state === undefined) throw new VMError("PROTOCOL_ERROR", "Unknown registry request");
    return state;
  }

  #releasePending(state: Request): void {
    if (state.pending !== undefined) this.#traffic.release(state.pending);
    delete state.pending;
    state.delivered = false;
  }
}

function requireOpen(state: Request): void {
  if (state.closed) throw new VMError("ABORTED", "Registry request cancelled");
}

/** Only network acquisition/read/cleanup waits have a deadline. Receiver
 * backpressure between reads and application execution have no such timeout. */
function deadline<T>(operation: Promise<T>, phase: "headers" | "body" | "retirement", expired?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new VMError("RELAY_ERROR", "Registry network deadline exceeded", { phase }));
      expired?.();
    }, 60_000);
    void operation.then(
      value => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new VMError("RELAY_ERROR", "Registry operation failed")); },
    );
  });
}
