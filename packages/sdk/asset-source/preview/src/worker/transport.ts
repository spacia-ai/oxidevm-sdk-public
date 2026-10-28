// The session's transport to the Playground, held by the worker. A keeper document grants it;
// when it is lost (the worker restarted, or its keeper closed) the worker asks every keeper of
// the session for a fresh one at once and stops waiting after 10 s without one.

/** How long a request waits for a keeper to grant a transport. */
export const ATTACH_WAIT_MS = 10_000;
/** How often a request waiting for its response checks that the transport's keeper is open. */
export const LIVENESS_INTERVAL_MS = 2_000;
/** How long a request waits for its response head. Chromium stops a Service Worker whose fetch
 * event has not settled within five minutes, so the worker answers itself before then; the
 * guest's server keeps going (a first compile in Userspace can take longer) for the next try. */
export const HEAD_WAIT_MS = 240_000;

/** A keeper document, as the worker sees it among its window clients. */
export interface KeeperClient {
  readonly id: string;
  postMessage(message: unknown): void;
}

/** The worker's view of the keeper documents of a session. */
export interface KeeperDirectory {
  keepers(session: string): Promise<readonly KeeperClient[]>;
  isOpen(clientId: string): Promise<boolean>;
}

export type Watched<T> =
  | { readonly kind: "settled"; readonly value: T }
  | { readonly kind: "lost" }
  | { readonly kind: "late" };

export class SessionTransport {
  readonly #session: string;
  readonly #directory: KeeperDirectory;
  #port: MessagePort | undefined;
  #keeperId: string | undefined;
  #waiting: Promise<MessagePort | null> | undefined;
  #wake: ((port: MessagePort | null) => void) | undefined;

  constructor(session: string, directory: KeeperDirectory) {
    this.#session = session;
    this.#directory = directory;
  }

  get attached(): boolean {
    return this.#port !== undefined;
  }

  /** A keeper granted a transport: it replaces any earlier one and wakes waiting requests. */
  attach(port: MessagePort, keeperId: string): void {
    if (this.#port !== port) this.#port?.close();
    this.#port = port;
    this.#keeperId = keeperId;
    port.start();
    this.#wake?.(port);
  }

  /** Forgets the transport (the session retired, or its keeper closed); waiting requests get none. */
  drop(): void {
    this.#port?.close();
    this.#port = undefined;
    this.#keeperId = undefined;
    this.#wake?.(null);
  }

  /** A live transport: the current one while its keeper is open, else a fresh one asked of every
   * keeper of the session (at most 10 s); null at once when none is open. */
  async acquire(): Promise<MessagePort | null> {
    if (await this.alive() && this.#port !== undefined) return this.#port;
    this.#waiting ??= this.#request();
    return this.#waiting;
  }

  /** Whether the transport's keeper is still open; the transport of a closed keeper is dropped. */
  async alive(): Promise<boolean> {
    const port = this.#port;
    const keeperId = this.#keeperId;
    if (port === undefined || keeperId === undefined) return false;
    if (await this.#directory.isOpen(keeperId)) return true;
    if (this.#port === port) this.drop();
    return false;
  }

  /** Settles with `pending`; "lost" once the transport's keeper closes (checked every 2 s), or
   * "late" once `deadlineMs` passes first. */
  async whileAlive<T>(pending: Promise<T>, deadlineMs: number): Promise<Watched<T>> {
    let timer: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const ended = new Promise<Watched<T>>((resolve) => {
      timer = setInterval(() => {
        this.alive().then((alive) => {
          if (!alive) resolve({ kind: "lost" });
        }, () => { /* A failed lookup proves nothing; the next check asks again. */ });
      }, LIVENESS_INTERVAL_MS);
      deadline = setTimeout(() => { resolve({ kind: "late" }); }, deadlineMs);
    });
    try {
      return await Promise.race([pending.then((value): Watched<T> => ({ kind: "settled", value })), ended]);
    } finally {
      clearInterval(timer);
      clearTimeout(deadline);
    }
  }

  #request(): Promise<MessagePort | null> {
    const waiting = (async () => {
      const keepers = await this.#directory.keepers(this.#session);
      if (this.#port !== undefined) return this.#port;
      if (keepers.length === 0) return null;
      return new Promise<MessagePort | null>((resolve) => {
        const finish = (port: MessagePort | null): void => {
          clearTimeout(timer);
          if (this.#wake === finish) this.#wake = undefined;
          resolve(port);
        };
        const timer = setTimeout(() => { finish(null); }, ATTACH_WAIT_MS);
        this.#wake = finish;
        for (const keeper of keepers) keeper.postMessage({ kind: "reattach", session: this.#session });
      });
    })().finally(() => {
      if (this.#waiting === waiting) this.#waiting = undefined;
    });
    return waiting;
  }
}

/** One forwarded HTTP request's inbox and cancellation, owned by its Service Worker. */
export class RequestInbox {
  readonly #port: MessagePort;
  readonly #signal: AbortSignal;
  readonly #abort: () => void;
  readonly #messages: unknown[] = [];
  readonly #waiters: Array<(value: unknown) => void> = [];
  #closed = false;

  constructor(port: MessagePort, signal: AbortSignal) {
    this.#port = port;
    this.#signal = signal;
    this.#abort = () => port.postMessage({ kind: "cancel" });
    port.onmessage = (event: MessageEvent<unknown>) => this.#push(event.data);
    signal.addEventListener("abort", this.#abort, { once: true });
    port.start();
  }

  next(): Promise<unknown> {
    if (this.#closed) return Promise.resolve(CLOSED_REQUEST);
    const value = this.#messages.shift();
    return value === undefined ? new Promise(resolve => this.#waiters.push(resolve)) : Promise.resolve(value);
  }

  responseHead(body: Promise<void>): Promise<unknown> {
    return body.then(() => this.next(), () => {
      this.failRequestBody();
      return this.next();
    });
  }

  failRequestBody(): void {
    if (this.#closed) return;
    this.#abort();
    this.#push({ kind: "error", code: "request-body", reason: "read" });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#signal.removeEventListener("abort", this.#abort);
    this.#port.close();
    this.#messages.length = 0;
    for (const waiter of this.#waiters.splice(0)) waiter(CLOSED_REQUEST);
  }

  #push(value: unknown): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#messages.push(value);
    else waiter(value);
  }
}

const CLOSED_REQUEST = Object.freeze({ kind: "error", code: "request-body", reason: "channel" });
