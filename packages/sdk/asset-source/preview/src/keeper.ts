// The keeper's decisions, apart from the document that runs them (main.ts): which bootstrap it
// accepts, how it grants the session's worker a transport, and when it grants a fresh one.

const SESSION = /^[a-f0-9]{32}$/u;
/** How often the keeper checks that its worker still holds a transport. */
export const PING_MS = 20_000;
/** How long the worker has to acknowledge an attach or answer a ping. */
export const REPLY_MS = 5_000;

export interface KeeperBootstrap {
  readonly session: string;
  readonly parentOrigin: string;
  /** "shared": the one preview address of a one-person setup (ADR 0015); sessions take turns. */
  readonly isolation: "per-session" | "shared";
}

/** The keeper's URL parameters: its session, which must name this origin unless the address is
 * shared, and the Playground origin that embeds it (https, or http on this machine, never this
 * origin; on the shared address, a Playground on this same host). */
export function decodeKeeperBootstrap(search: string, location: { readonly origin: string; readonly hostname: string }): KeeperBootstrap {
  const parameters = new URLSearchParams(search);
  const session = parameters.get("session");
  const parentOrigin = parameters.get("parentOrigin");
  const isolationValue = parameters.get("isolation");
  if (session === null || !SESSION.test(session) || parentOrigin === null || (isolationValue !== null && isolationValue !== "shared")) {
    throw new TypeError("invalid preview bootstrap");
  }
  const isolation = isolationValue === null ? "per-session" : "shared";
  if (isolation === "per-session" && location.hostname.split(".")[0] !== session) throw new TypeError("preview session does not match its origin");
  if (!URL.canParse(parentOrigin)) throw new TypeError("unsafe preview parent origin");
  const parent = new URL(parentOrigin);
  const localHttp = parent.protocol === "http:" && (parent.hostname === "127.0.0.1" || parent.hostname === "localhost");
  if ((parent.protocol !== "https:" && !localHttp) || parent.origin === location.origin || parent.href !== `${parent.origin}/`
    || (isolation === "shared" && parent.hostname !== location.hostname)) {
    throw new TypeError("unsafe preview parent origin");
  }
  return { session, parentOrigin: parent.origin, isolation };
}

/** Why the keeper could not start; the owner fails the session at once instead of waiting. */
export type KeeperFailure = "service-worker-blocked" | "service-worker-failed";

/** Chromium refuses a worker its settings forbid (Brave's Shields in a cross-site frame) with
 * NotSupportedError, "The user denied permission to use Service Worker". */
export function registrationFailure(error: unknown): KeeperFailure {
  return error instanceof DOMException && error.name === "NotSupportedError" ? "service-worker-blocked" : "service-worker-failed";
}

export interface KeeperEnvironment {
  /** The Playground window that embedded this keeper. */
  readonly owner: { postMessage(message: unknown, targetOrigin: string): void };
  /** The session's worker, once registered. */
  worker(): { postMessage(message: unknown, transfer: Transferable[]): void } | null;
  /** A fresh transport, granted by the owner. */
  requestPort(): Promise<MessagePort>;
  sleep(ms: number): Promise<void>;
}

interface Pong {
  readonly attached: boolean;
  readonly retired: boolean;
}

export class Keeper {
  readonly #session: string;
  readonly #parentOrigin: string;
  readonly #environment: KeeperEnvironment;
  #attaching: Promise<void> | undefined;
  #retired = false;

  constructor(bootstrap: KeeperBootstrap, environment: KeeperEnvironment) {
    this.#session = bootstrap.session;
    this.#parentOrigin = bootstrap.parentOrigin;
    this.#environment = environment;
  }

  /** Grants the worker a fresh transport; calls made while one is in flight share it. */
  attach(): Promise<void> {
    this.#attaching ??= this.#attach().finally(() => { this.#attaching = undefined; });
    return this.#attaching;
  }

  /** The worker lost its transport and asks for another at once. */
  onWorkerMessage(data: unknown): void {
    if (this.#retired || !isRecord(data) || !exactKeys(data, ["kind", "session"]) || data["kind"] !== "reattach" || data["session"] !== this.#session) return;
    this.attach().catch(() => { /* The next ping retries; a closed owner ends the session. */ });
  }

  /** The owner closed the session: the worker answers its pages as retired from now on. */
  retire(): void {
    this.#retired = true;
    this.#environment.worker()?.postMessage({ kind: "retire", session: this.#session }, []);
  }

  /** Keeps the worker alive and re-attaches when a ping finds it without a transport. */
  async run(): Promise<void> {
    while (!this.#isRetired()) {
      await this.#environment.sleep(PING_MS);
      if (this.#isRetired()) return;
      const pong = await this.#ping();
      if (pong?.retired === true) return;
      if (pong === undefined || !pong.attached) {
        try { await this.attach(); } catch { /* The owner will retry through the next ping; a closed owner ends the session. */ }
      }
    }
  }

  /** Read through a call: retire() may run while the loop waits. */
  #isRetired(): boolean {
    return this.#retired;
  }

  async #attach(): Promise<void> {
    const port = await this.#environment.requestPort();
    const target = this.#environment.worker();
    if (target === null) {
      port.close();
      throw new TypeError("preview Service Worker is unavailable");
    }
    const acknowledgement = new MessageChannel();
    const attached = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        acknowledgement.port1.close();
        reject(new TypeError("preview Service Worker did not attach"));
      }, REPLY_MS);
      acknowledgement.port1.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (!isRecord(message) || message["session"] !== this.#session) return;
        clearTimeout(timeout);
        acknowledgement.port1.close();
        if (message["kind"] === "attached") resolve();
        else reject(new TypeError(message["kind"] === "refused" ? "preview session refused by this address" : "preview session retired"));
      };
    });
    const message = { kind: "attach", session: this.#session, port, acknowledgement: acknowledgement.port2, parentOrigin: this.#parentOrigin };
    target.postMessage(message, [port, acknowledgement.port2]);
    await attached;
  }

  #ping(): Promise<Pong | undefined> {
    const target = this.#environment.worker();
    if (target === null) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => {
        channel.port1.close();
        resolve(undefined);
      }, REPLY_MS);
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        clearTimeout(timeout);
        channel.port1.close();
        const message = event.data;
        resolve(isRecord(message) && message["kind"] === "pong" && message["session"] === this.#session
          && typeof message["attached"] === "boolean" && typeof message["retired"] === "boolean"
          ? { attached: message["attached"], retired: message["retired"] }
          : undefined);
      };
      target.postMessage({ kind: "ping", session: this.#session, acknowledgement: channel.port2 }, [channel.port2]);
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
