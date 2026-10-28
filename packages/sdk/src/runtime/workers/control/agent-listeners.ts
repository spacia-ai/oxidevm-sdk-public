// The guest's listening ports for the page (ADR 0015, capability 64): at most one subscription
// to the guest agent, shared by the page's watchers over one port and carried across restores
// and agent restarts. The agent's events become ListeningPort lists.
import { decodeAgentListeners, encodeWatchListeners, previewableAddress, type AgentListenerSnapshot } from "../../protocol/agent-listeners.js";
import type { ListeningPortsMessage } from "../../protocol/listening-ports.js";
import { serializeUnknownError, VMError } from "../../errors.js";
import type { ListeningPort } from "../../vm-types.js";

/** How long one list waits for the guest when nothing watches. */
export const LISTENER_LIST_TIMEOUT_MS = 10_000;

/** What the owner needs from the guest agent. */
export interface ListenerAgentPort {
  /** Sends a WATCH_LISTENERS request; its id is known before any frame of the reply arrives. */
  begin(payload: Uint8Array<ArrayBuffer>): { readonly id: number; readonly reply: Promise<void> };
  /** Greets a restarted agent, whose capabilities then arrive through `agentReady`. */
  greet(): Promise<void>;
  /** Whether `id` belongs to the agent session before a restore. */
  belowFloor(id: number): boolean;
  /** Counts a frame dropped because it belongs to an earlier subscription or session. */
  dropped(): void;
}

type Subscription =
  | { readonly kind: "none" }
  | { readonly kind: "subscribing"; readonly id: number }
  | { readonly kind: "open"; readonly id: number }
  /** `id` is the unsubscribe request's. */
  | { readonly kind: "closing"; readonly id: number };

interface Waiter {
  readonly resolve: (ports: readonly ListeningPort[]) => void;
  readonly reject: (error: VMError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class AgentListeners {
  readonly #agent: ListenerAgentPort;
  #state: Subscription = { kind: "none" };
  /** Undefined until the agent greets, then whether it has capability 64. */
  #supported: boolean | undefined;
  #page: MessagePort | undefined;
  /** The last list of the open subscription. */
  #latest: readonly ListeningPort[] | undefined;
  /** Whether the page's last list named any port, which a gone agent retracts. */
  #pageHasPorts = false;
  readonly #waiters = new Set<Waiter>();
  /**
   * Subscriptions of this agent session that were replaced, closed or failed: their events may
   * still be on their way and are dropped. A successful reply to a later request prunes them,
   * because the agent sends every event of a subscription before its next reply.
   */
  readonly #earlier = new Set<number>();
  /** A restored agent may still hold the subscription it had when the restore point was taken. */
  #endOnGreeting = false;

  constructor(agent: ListenerAgentPort) {
    this.#agent = agent;
  }

  /** Whether frames may arrive while no request is pending, so the session must keep draining. */
  get draining(): boolean {
    return this.#state.kind !== "none";
  }

  /** The page watches through `port`; a later port replaces it. */
  watch(port: MessagePort): void {
    if (this.#supported === false) {
      port.close();
      throw updateRequired();
    }
    this.#page?.close();
    this.#page = port;
    this.#pageHasPorts = false;
    if (this.#latest !== undefined) this.#post({ type: "ports", ports: this.#latest });
    this.#want();
  }

  unwatch(): void {
    this.#page?.close();
    this.#page = undefined;
    this.#pageHasPorts = false;
    this.#release();
  }

  /** One list: the latest while subscribed, otherwise a subscription held until the first list. */
  list(): Promise<readonly ListeningPort[]> {
    if (this.#supported === undefined) {
      return Promise.reject(new VMError("FEATURE_NOT_AVAILABLE", "the guest agent has not started yet", { reason: "agent-not-ready" }));
    }
    if (!this.#supported) return Promise.reject(updateRequired());
    if (this.#state.kind === "open" && this.#latest !== undefined) return Promise.resolve(this.#latest);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new VMError("GUEST_CRASH", "the guest agent did not list its listening ports in time", { reason: "listeners-timeout" }));
          this.#release();
        }, LISTENER_LIST_TIMEOUT_MS),
      };
      this.#waiters.add(waiter);
      this.#want();
    });
  }

  /** The agent greeted; `supported` is whether it advertised capability 64. */
  agentReady(supported: boolean): void {
    this.#supported = supported;
    const endRestored = this.#endOnGreeting;
    this.#endOnGreeting = false;
    if (!supported) {
      this.#refuse(updateRequired());
      return;
    }
    if (this.#needed()) this.#want();
    else if (endRestored && this.#state.kind === "none") this.#unsubscribe();
  }

  /**
   * The agent this owner talked to is gone: the machine was replaced, a restore point resumed, or
   * init restarted the agent. The page keeps watching and is told no port is known.
   */
  agentGone(reason: "replaced" | "resumed" | "restarted"): void {
    this.#state = { kind: "none" };
    this.#supported = undefined;
    this.#latest = undefined;
    this.#earlier.clear();
    this.#endOnGreeting = reason === "resumed";
    const gone = new VMError("ABORTED", "the guest agent was replaced while listing its ports");
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(gone);
    }
    this.#waiters.clear();
    if (this.#pageHasPorts) this.#post({ type: "ports", ports: [] });
    if (reason === "restarted" && this.#page !== undefined) {
      // Greets once the restart's READY has been handled; a failed greeting leaves the page waiting.
      void Promise.resolve().then(() => this.#agent.greet()).catch(() => undefined);
    }
  }

  /** A LISTENERS event for subscription `requestId`. */
  receive(requestId: number, payload: Uint8Array): void {
    const current = this.#state.kind === "subscribing" || this.#state.kind === "open" ? this.#state.id : undefined;
    if (requestId === current) {
      const ports = listeningPortsOf(decodeAgentListeners(payload));
      this.#latest = ports;
      this.#post({ type: "ports", ports });
      for (const waiter of this.#waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(ports);
      }
      this.#waiters.clear();
      this.#release();
      return;
    }
    if (this.#earlier.has(requestId) || this.#agent.belowFloor(requestId)) {
      this.#agent.dropped();
      return;
    }
    throw new VMError("PROTOCOL_ERROR", "the guest agent reported listening ports for a subscription it was not asked for");
  }

  #needed(): boolean {
    return this.#page !== undefined || this.#waiters.size > 0;
  }

  /** Subscribes once the agent is known to support it, unless a subscription is already open. */
  #want(): void {
    if (this.#supported !== true || this.#state.kind === "subscribing" || this.#state.kind === "open") return;
    let begun: { readonly id: number; readonly reply: Promise<void> };
    try {
      begun = this.#agent.begin(encodeWatchListeners("subscribe"));
    } catch (error) {
      this.#rejectWaiters(error);
      return;
    }
    const { id, reply } = begun;
    this.#state = { kind: "subscribing", id };
    reply.then(() => {
      this.#prune(id);
      if (this.#state.kind !== "subscribing" || this.#state.id !== id) return;
      this.#state = { kind: "open", id };
      this.#release();
    }, (error: unknown) => {
      // The page keeps watching; the agent's next greeting subscribes again.
      this.#earlier.add(id);
      if (this.#state.kind !== "subscribing" || this.#state.id !== id) return;
      this.#state = { kind: "none" };
      this.#rejectWaiters(error);
    });
  }

  /** Ends the subscription once neither the page nor a list needs it. */
  #release(): void {
    if (!this.#needed() && (this.#state.kind === "subscribing" || this.#state.kind === "open")) this.#unsubscribe();
  }

  #unsubscribe(): void {
    if (this.#state.kind === "subscribing" || this.#state.kind === "open") this.#earlier.add(this.#state.id);
    // A list is current only while subscribed.
    this.#latest = undefined;
    let begun: { readonly id: number; readonly reply: Promise<void> };
    try {
      begun = this.#agent.begin(encodeWatchListeners("unsubscribe"));
    } catch {
      this.#state = { kind: "none" };
      return;
    }
    const { id, reply } = begun;
    this.#state = { kind: "closing", id };
    const closed = (): void => {
      if (this.#state.kind === "closing" && this.#state.id === id) this.#state = { kind: "none" };
    };
    reply.then(() => {
      this.#prune(id);
      closed();
    }, closed);
  }

  /** Forgets earlier subscriptions whose events cannot follow the reply to request `id`. */
  #prune(id: number): void {
    for (const earlier of this.#earlier) if (earlier < id) this.#earlier.delete(earlier);
  }

  /** The agent cannot report ports: the page and every list hear why. */
  #refuse(error: VMError): void {
    this.#post({ type: "failed", error: serializeUnknownError(error) });
    this.#page?.close();
    this.#page = undefined;
    this.#pageHasPorts = false;
    this.#rejectWaiters(error);
  }

  #rejectWaiters(error: unknown): void {
    const failure = error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", "listing the guest's ports failed");
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
    this.#waiters.clear();
  }

  #post(message: ListeningPortsMessage): void {
    if (this.#page === undefined) return;
    this.#page.postMessage(message);
    this.#pageHasPorts = message.type === "ports" && message.ports.length > 0;
  }
}

/** The ports of an agent snapshot as the page sees them. */
export function listeningPortsOf(snapshot: AgentListenerSnapshot): ListeningPort[] {
  return snapshot.listeners.map((listener) => ({
    port: listener.port,
    address: listener.address,
    program: listener.program,
    previewable: previewableAddress(listener.address),
  }));
}

function updateRequired(): VMError {
  return new VMError("FEATURE_NOT_AVAILABLE", "this Linux image does not report listening ports; update Linux", {
    reason: "image-update-required",
  });
}
