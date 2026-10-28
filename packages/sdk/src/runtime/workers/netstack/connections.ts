import { createFrameTransport, type FrameTransport } from "../../frame-transport.js";
import { NetstackEgress } from "./egress.js";
import type { RelayConnection } from "../relay-protocol.js";
// The router in the network worker (ADR 0015). It drains the to-router ring into smoltcp when
// the control worker rings, flushes the router's frames into the to-Linux ring, polls on
// smoltcp's own timers, starts over for every new bridge generation, and opens TCP connections
// into Linux for previews. A router that traps ends every connection and fails later opens.
import { VMError } from "../../errors.js";
import {
  decodeFrameBridgeNotice,
  type FrameBridgeReply,
  MAX_FRAME_BYTES,
  type NetworkLinkConnection,
  type RouterFailure,
} from "../../frame-bridge.js";
import { NetstackRouter, type NetstackLoader, type NetstackRouterApi } from "./router.js";

export type RouterOpenResult =
  | { readonly kind: "connected"; readonly connection: RouterConnection }
  | { readonly kind: "refused" }
  | { readonly kind: "timed-out" }
  | { readonly kind: "busy" };

export type RouterRead =
  | { readonly kind: "data"; readonly bytes: Uint8Array }
  | { readonly kind: "eof" }
  | { readonly kind: "blocked" }
  | { readonly kind: "reset" };

export interface RouterConnection {
  readonly id: number;
  /** Bytes accepted now; 0 when the send buffer is full or the connection ended. */
  write(bytes: Uint8Array): number;
  read(maxBytes: number, waitMs: number, signal?: AbortSignal): Promise<RouterRead>;
  /** Waits for Rust router readiness without consuming bytes or adding a timer. */
  wait(interest: "read" | "write", signal?: AbortSignal): Promise<void>;
  /** Sends a FIN; closing again does nothing. */
  close(): void;
}

export interface NetstackOptions {
  readonly load?: NetstackLoader;
  readonly now?: () => number;
  readonly seed?: () => bigint;
  readonly setTimer?: (run: () => void, ms: number) => () => void;
}

const MAX_READ_BYTES = 256 * 1024;
const MAX_WAIT_MS = 60_000;
/** How soon frames the to-Linux ring had no room for are tried again. */
const FLUSH_RETRY_MS = 4;
const COUNTERS_INTERVAL_MS = 250;
const BATCH_BYTES = 256 * 1024;
const RECORD_ROOM = 2 + MAX_FRAME_BYTES;

interface PendingOpen {
  readonly resolve: (result: RouterOpenResult) => void;
  readonly reject: (error: VMError) => void;
  readonly release: () => void;
}

/** What a connection needs from its owner. */
interface ConnectionHost {
  readonly router: NetstackRouterApi;
  readonly setTimer: (run: () => void, ms: number) => () => void;
  /** Runs the router now, after a write. */
  readonly pump: () => void;
  /** Runs the router soon, after a read opened the window. */
  readonly requestPump: () => void;
  readonly forget: (id: number) => void;
  readonly fail: (error: unknown) => void;
}

export class NetstackConnections {
  readonly #router: NetstackRouterApi;
  readonly #egress: NetstackEgress;
  onRuntimeReset: (() => void) | undefined;
  readonly #bridge: FrameTransport;
  readonly #doorbell: MessagePort;
  readonly #toRouter: FrameTransport["toRouter"];
  readonly #toLinux: FrameTransport["toLinux"];
  readonly #now: () => number;
  readonly #seed: () => bigint;
  readonly #setTimer: (run: () => void, ms: number) => () => void;
  readonly #scratch = new Uint8Array(BATCH_BYTES);
  readonly #pending = new Map<number, PendingOpen>();
  readonly #connections = new Map<number, LinkConnection>();
  readonly #host: ConnectionHost;
  #generation: number;
  #cancelTimer: () => void = () => undefined;
  #countersAt = Number.NEGATIVE_INFINITY;
  #failure: VMError | undefined;
  #pumping = false;
  #again = false;
  #pumpQueued = false;
  #disposed = false;

  private constructor(connection: NetworkLinkConnection, router: NetstackRouterApi, options: Required<Omit<NetstackOptions, "load">>) {
    this.#router = router;
    this.#egress = new NetstackEgress(router, () => { this.#requestPump(); });
    this.#bridge = createFrameTransport(connection.bridge, connection.doorbell, "router");
    this.#doorbell = connection.doorbell;
    this.#toRouter = this.#bridge.toRouter;
    this.#toLinux = this.#bridge.toLinux;
    this.#now = options.now;
    this.#seed = options.seed;
    this.#setTimer = options.setTimer;
    this.#generation = this.#bridge.generation;
    this.#host = {
      router,
      setTimer: options.setTimer,
      pump: () => { this.#pump(); },
      requestPump: () => { this.#requestPump(); },
      forget: (id) => { this.#connections.delete(id); },
      fail: (error) => { this.#fail(error); },
    };
  }

  /** Loads the router and answers the control worker: ready, or failed with the load's reason. */
  static async start(connection: NetworkLinkConnection, options: NetstackOptions = {}): Promise<NetstackConnections> {
    const now = options.now ?? (() => performance.now());
    const seed = options.seed ?? randomSeed;
    const load = options.load ?? ((url, routerSeed, at) => NetstackRouter.load(url, routerSeed, at));
    let router: NetstackRouterApi;
    try {
      router = await load(connection.netstackWasmUrl, seed(), now());
    } catch (error: unknown) {
      reply(connection.doorbell, { version: 1, type: "router-failed", reason: loadFailure(error) });
      connection.doorbell.close();
      throw error;
    }
    const connections = new NetstackConnections(connection, router, { now, seed, setTimer: options.setTimer ?? defaultTimer });
    connections.#bridge.publishGeneration(connections.#generation);
    reply(connection.doorbell, { version: 1, type: "router-ready" });
    connection.doorbell.onmessage = (event: MessageEvent) => {
      try {
        if (!connections.#bridge.receive(event.data)) decodeFrameBridgeNotice(event.data);
      } catch (error: unknown) {
        connections.#fail(error);
        return;
      }
      connections.#pump();
    };
    connections.#pump();
    return connections;
  }

  /** Opens a connection to `port` in Linux: the guest address first, then 127.0.0.1. */
  open(port: number, signal?: AbortSignal): Promise<RouterOpenResult> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return Promise.reject(new VMError("INVALID_ARGUMENT", "the port must be an integer from 1 to 65535"));
    }
    if (signal?.aborted === true) return Promise.reject(aborted("the open was aborted"));
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#disposed) return Promise.reject(new VMError("RELAY_ERROR", "the network link was closed"));
    let id: number;
    try {
      const opened = this.#router.open(port);
      if (opened.kind === "busy") return Promise.resolve({ kind: "busy" });
      id = opened.id;
    } catch (error: unknown) {
      return Promise.reject(this.#fail(error));
    }
    const { promise, resolve, reject } = Promise.withResolvers<RouterOpenResult>();
    const abort = (): void => {
      if (!this.#pending.delete(id)) return;
      this.#closeQuietly(id);
      reject(aborted("the open was aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.#pending.set(id, { resolve, reject, release: () => { signal?.removeEventListener("abort", abort); } });
    this.#pump();
    return promise;
  }

  setRelay(connection: RelayConnection | undefined, generation: number): Promise<void> { return this.#egress.setRelay(connection, generation); }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#egress.reset();
    this.#cancelTimer();
    this.#doorbell.onmessage = null;
    this.#doorbell.close();
    this.#endAll(aborted("the network link was closed"));
  }

  #pump(): void {
    if (this.#failure !== undefined || this.#disposed) return;
    if (this.#pumping) {
      this.#again = true;
      return;
    }
    this.#pumping = true;
    this.#again = false;
    try {
      do this.#pumpOnce();
      while (this.#takeAgain());
    } catch (error: unknown) {
      this.#fail(error);
    } finally {
      this.#pumping = false;
    }
  }

  /** Whether a pump was asked for while one ran, and the router can still run. */
  #takeAgain(): boolean {
    const again = this.#again && this.#failure === undefined && !this.#disposed;
    this.#again = false;
    return again;
  }

  #pumpOnce(): void {
    this.#applyGeneration();
    this.#bridge.clearKick();
    for (let peek = this.#toRouter.peek(this.#scratch); peek.length > 0; peek = this.#toRouter.peek(this.#scratch)) {
      this.#router.framesIn(this.#scratch.subarray(0, peek.length));
      this.#toRouter.advance(peek.length);
    }
    const now = this.#now();
    const delay = this.#router.poll(now);
    const waitsForRoom = this.#flushToLinux();
    this.#settle();
    this.#egress.wake();
    this.#publishCounters(now);
    this.#schedule(waitsForRoom ? Math.min(delay ?? FLUSH_RETRY_MS, FLUSH_RETRY_MS) : delay);
  }

  /** A replaced machine: the router starts over, its connections and attempts end, and records
   * the old machine sent are dropped. */
  #applyGeneration(): void {
    const generation = this.#bridge.generation;
    if (generation === this.#generation) return;
    this.#egress.reset();
    this.#router.init(this.#seed(), this.#now());
    this.onRuntimeReset?.();
    this.#toRouter.skipAll();
    this.#generation = generation;
    for (const [id, pending] of this.#pending) {
      this.#router.close(id);
      pending.release();
      pending.resolve({ kind: "refused" });
    }
    this.#pending.clear();
    for (const [id, connection] of this.#connections) {
      this.#router.close(id);
      connection.reset();
    }
    this.#connections.clear();
    this.#bridge.publishGeneration(generation);
  }

  /** Writes the router's frames into the to-Linux ring; true when some wait for room. */
  #flushToLinux(): boolean {
    for (let free = this.#toLinux.freeBytes(); free >= RECORD_ROOM; free = this.#toLinux.freeBytes()) {
      const records = this.#router.framesOut(Math.min(free, BATCH_BYTES));
      if (records.byteLength === 0) return false;
      this.#toLinux.write(records);
    }
    return true;
  }

  /** Settles attempts the router decided and lets waiting reads look again. */
  #settle(): void {
    for (const [id, pending] of [...this.#pending]) {
      const { state } = this.#router.status(id);
      if (state === "opening") continue;
      this.#pending.delete(id);
      pending.release();
      if (state === "connected" || state === "peer-closed") {
        const connection = new LinkConnection(id, this.#host);
        this.#connections.set(id, connection);
        pending.resolve({ kind: "connected", connection });
      } else {
        this.#router.close(id);
        pending.resolve({ kind: state === "timed-out" ? "timed-out" : "refused" });
      }
    }
    for (const connection of [...this.#connections.values()]) connection.wake();
  }

  #publishCounters(now: number): void {
    if (now - this.#countersAt < COUNTERS_INTERVAL_MS) return;
    this.#countersAt = now;
    this.#bridge.publishCounters(this.#router.counters());
  }

  #schedule(delay: number | undefined): void {
    this.#cancelTimer();
    this.#cancelTimer = delay === undefined ? () => undefined : this.#setTimer(() => { this.#pump(); }, delay);
  }

  #requestPump(): void {
    if (this.#pumpQueued) return;
    this.#pumpQueued = true;
    queueMicrotask(() => {
      this.#pumpQueued = false;
      this.#pump();
    });
  }

  #closeQuietly(id: number): void {
    try {
      this.#router.close(id);
      this.#pump();
    } catch (error: unknown) {
      this.#fail(error);
    }
  }

  /** The router trapped or broke the bridge: tell control, end everything, refuse later opens.
   * Returns the failure every caller now sees. */
  #fail(error: unknown): VMError {
    if (this.#failure !== undefined) return this.#failure;
    const reason = runFailure(error);
    const failure = new VMError("RELAY_ERROR", `the network router stopped (${reason})`, { reason });
    this.#failure = failure;
    if (this.#disposed) return failure;
    this.#cancelTimer();
    reply(this.#doorbell, { version: 1, type: "router-failed", reason });
    this.#endAll(failure);
    return failure;
  }

  #endAll(error: VMError): void {
    for (const pending of this.#pending.values()) {
      pending.release();
      pending.reject(error);
    }
    this.#pending.clear();
    for (const connection of this.#connections.values()) connection.reset();
    this.#connections.clear();
  }
}

/** One established connection, read and written through the router. */
class LinkConnection implements RouterConnection {
  readonly id: number;
  readonly #host: ConnectionHost;
  readonly #waiters = new Set<() => void>();
  #state: "open" | "reset" | "closed" = "open";

  constructor(id: number, host: ConnectionHost) {
    this.id = id;
    this.#host = host;
  }

  write(bytes: Uint8Array): number {
    if (this.#state !== "open" || bytes.byteLength === 0) return 0;
    let accepted: number;
    try {
      accepted = this.#host.router.send(this.id, bytes);
    } catch (error: unknown) {
      this.#host.fail(error);
      return 0;
    }
    if (accepted > 0) this.#host.pump();
    return accepted;
  }

  read(maxBytes: number, waitMs: number, signal?: AbortSignal): Promise<RouterRead> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) {
      return Promise.reject(new VMError("INVALID_ARGUMENT", "a read takes 1 to 262,144 bytes"));
    }
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
      return Promise.reject(new VMError("INVALID_ARGUMENT", "a read waits 0 to 60,000 ms"));
    }
    if (signal?.aborted === true) return Promise.reject(aborted("the read was aborted"));
    const ready = this.#tryRead(maxBytes);
    if (ready !== undefined) return Promise.resolve(ready);
    if (waitMs === 0) return Promise.resolve({ kind: "blocked" });
    const { promise, resolve, reject } = Promise.withResolvers<RouterRead>();
    let cancel = (): void => undefined;
    const finish = (): void => {
      cancel();
      this.#waiters.delete(wake);
      signal?.removeEventListener("abort", abort);
    };
    const wake = (): void => {
      const result = this.#tryRead(maxBytes);
      if (result === undefined) return;
      finish();
      resolve(result);
    };
    const abort = (): void => {
      finish();
      reject(aborted("the read was aborted"));
    };
    cancel = this.#host.setTimer(() => {
      finish();
      resolve(this.#tryRead(maxBytes) ?? { kind: "blocked" });
    }, waitMs);
    this.#waiters.add(wake);
    signal?.addEventListener("abort", abort, { once: true });
    return promise;
  }

  async wait(interest: "read" | "write", signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw aborted("the readiness wait was aborted");
    const ready = (): boolean => {
      if (this.#state !== "open") return true;
      const status = this.#host.router.status(this.id);
      return status.state !== "connected" || (interest === "read" ? status.readable : status.writable);
    };
    if (ready()) return;
    if (this.#waiters.size >= 256) throw new VMError("QUOTA_EXCEEDED", "Router readiness waiter capacity exhausted");
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => { this.#waiters.delete(wake); signal?.removeEventListener("abort", abort); };
      const wake = (): void => {
        try { if (!ready()) return; finish(); resolve(); }
        catch (error) { finish(); reject(error instanceof Error ? error : new VMError("RELAY_ERROR", "Router readiness failed")); }
      };
      const abort = (): void => { finish(); reject(aborted("the readiness wait was aborted")); };
      this.#waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) abort(); else wake();
    });
  }

  close(): void {
    if (this.#state === "closed") return;
    const open = this.#state === "open";
    this.#state = "closed";
    this.#host.forget(this.id);
    if (open) {
      try {
        this.#host.router.close(this.id);
        this.#host.pump();
      } catch (error: unknown) {
        this.#host.fail(error);
      }
    }
    this.wake();
  }

  /** The router ended the connection: reads answer reset and writes take nothing. */
  reset(): void {
    if (this.#state === "open") this.#state = "reset";
    this.wake();
  }

  wake(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }

  #tryRead(maxBytes: number): RouterRead | undefined {
    if (this.#state === "reset") return { kind: "reset" };
    if (this.#state === "closed") return { kind: "eof" };
    try {
      const bytes = this.#host.router.receive(this.id, maxBytes);
      if (bytes.byteLength > 0) {
        this.#host.requestPump();
        return { kind: "data", bytes };
      }
      const { state } = this.#host.router.status(this.id);
      if (state === "connected") return undefined;
      if (state === "peer-closed") return { kind: "eof" };
    } catch (error: unknown) {
      this.#host.fail(error);
    }
    this.#state = "reset";
    return { kind: "reset" };
  }
}

function reply(port: MessagePort, message: FrameBridgeReply): void {
  port.postMessage(message);
}

/** The reason a load failure reports: its own, or fetch for anything else. */
function loadFailure(error: unknown): RouterFailure {
  const reason = error instanceof VMError ? error.detail?.["reason"] : undefined;
  return reason === "fetch" || reason === "compile" || reason === "exports" || reason === "version" || reason === "init" ? reason : "fetch";
}

/** The reason a running router stopped: a trap, a failed restart, or a broken bridge. */
function runFailure(error: unknown): RouterFailure {
  const reason = error instanceof VMError ? error.detail?.["reason"] : undefined;
  if (reason === "trap" || reason === "init") return reason;
  return "protocol";
}

function aborted(message: string): VMError {
  return new VMError("ABORTED", message);
}

function randomSeed(): bigint {
  return crypto.getRandomValues(new BigUint64Array(1))[0] ?? 0n;
}

function defaultTimer(run: () => void, ms: number): () => void {
  const handle = setTimeout(run, ms);
  return () => { clearTimeout(handle); };
}
