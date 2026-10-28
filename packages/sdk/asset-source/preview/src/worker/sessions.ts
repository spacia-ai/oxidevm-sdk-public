// Which preview session the worker serves, and for which pages. A session origin
// (<session>.<preview host>) serves its one session. The shared address serves the session that
// attached last: it retires the session it replaced, for good, and sends that session's pages to
// a "moved" page. The current session and its parent are kept in a store, so a restarted worker
// still serves them and still frames their pages for that parent alone.
import { isParentOrigin } from "./policy";
import type { SessionTransport } from "./transport";

const SESSION = /^[a-f0-9]{32}$/u;
/** Pages remembered on the shared address; the oldest are forgotten first. */
const MAX_BINDINGS = 256;

export type WorkerScope = { readonly kind: "per-session"; readonly session: string } | { readonly kind: "shared" };

/** A first host label that is a session id names a session origin; anything else is the shared address. */
export function workerScope(hostname: string): WorkerScope {
  const label = hostname.split(".")[0] ?? "";
  return SESSION.test(label) ? { kind: "per-session", session: label } : { kind: "shared" };
}

/** What must survive a worker restart. What it reads back is untrusted. */
export interface SessionStore {
  readCurrent(): Promise<unknown>;
  writeCurrent(current: { readonly session: string; readonly parentOrigin: string }): Promise<void>;
  isRetired(key: string): Promise<boolean>;
  markRetired(key: string): Promise<void>;
}

export interface CurrentSession {
  readonly session: string;
  readonly transport: SessionTransport;
  /** The Playground origin that may frame its pages; null until a keeper names one. */
  readonly parentOrigin: string | null;
}

export type Route =
  | { readonly kind: "session"; readonly session: string; readonly transport: SessionTransport }
  | { readonly kind: "moved" }
  | { readonly kind: "retired" }
  | { readonly kind: "none" };

export type AttachResult = "attached" | "retired" | "refused";

export class SessionRegistry {
  readonly #scope: WorkerScope;
  readonly #transport: (session: string) => SessionTransport;
  readonly #store: SessionStore;
  readonly #retired = new Set<string>();
  readonly #bindings = new Map<string, string>();
  #current: CurrentSession | null;
  #restoring: Promise<void> | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(scope: WorkerScope, transport: (session: string) => SessionTransport, store: SessionStore) {
    this.#scope = scope;
    this.#transport = transport;
    this.#store = store;
    this.#current = scope.kind === "per-session" ? { session: scope.session, transport: transport(scope.session), parentOrigin: null } : null;
  }

  current(): CurrentSession | null {
    return this.#current;
  }

  async parent(): Promise<string | null> {
    await this.#restored();
    return this.#current?.parentOrigin ?? null;
  }

  /** A keeper grants its session's transport. On the shared address the session becomes the
   * current one and the session it replaces is retired. */
  attach(session: string, port: MessagePort, keeperId: string, parentOrigin: string): Promise<AttachResult> {
    return this.#serial(async () => {
      await this.#restored();
      if (this.#scope.kind === "per-session" && session !== this.#scope.session) {
        port.close();
        return "refused";
      }
      if (await this.#isRetired(session)) {
        port.close();
        return "retired";
      }
      const previous = this.#current;
      if (previous !== null && previous.session !== session) await this.#retire(previous.session);
      const transport = previous?.session === session ? previous.transport : this.#transport(session);
      this.#current = { session, transport, parentOrigin };
      transport.attach(port, keeperId);
      await this.#store.writeCurrent({ session, parentOrigin });
      return "attached";
    });
  }

  retire(session: string): Promise<void> {
    return this.#serial(() => this.#retire(session));
  }

  /** What a keeper's ping learns: whether its session holds a transport, and whether it ended. */
  async status(session: string): Promise<{ readonly attached: boolean; readonly retired: boolean }> {
    await this.#restored();
    const current = this.#current;
    return { attached: current?.session === session && current.transport.attached, retired: await this.#isRetired(session) };
  }

  /** A navigation opened a page in `session`; on the shared address its requests stay with it. */
  bind(clientId: string, session: string): void {
    if (this.#scope.kind === "per-session") return;
    this.#bindings.delete(clientId);
    this.#bindings.set(clientId, session);
    if (this.#bindings.size <= MAX_BINDINGS) return;
    const oldest = this.#bindings.keys().next();
    if (oldest.done !== true) this.#bindings.delete(oldest.value);
  }

  /** Where a request from `clientId` (null for a navigation) goes. */
  async route(clientId: string | null): Promise<Route> {
    await this.#restored();
    const current = this.#current;
    if (current === null) return { kind: "none" };
    const session = (clientId === null ? undefined : this.#bindings.get(clientId)) ?? current.session;
    if (session !== current.session) return { kind: "moved" };
    if (await this.#isRetired(session)) return { kind: "retired" };
    return { kind: "session", session, transport: current.transport };
  }

  async #retire(session: string): Promise<void> {
    this.#retired.add(session);
    if (this.#current?.session === session) this.#current.transport.drop();
    await this.#store.markRetired(this.#retiredKey(session));
  }

  async #isRetired(session: string): Promise<boolean> {
    return this.#retired.has(session) || await this.#store.isRetired(this.#retiredKey(session));
  }

  #retiredKey(session: string): string {
    return this.#scope.kind === "per-session" ? "retired" : `retired/${session}`;
  }

  /** Reads the stored session once per worker life; it never replaces one a keeper attached. */
  #restored(): Promise<void> {
    this.#restoring ??= this.#store.readCurrent().then((value) => {
      const stored = decodeStoredSession(value);
      if (stored === null) return;
      const current = this.#current;
      if (this.#scope.kind === "shared") {
        if (current === null) this.#current = { ...stored, transport: this.#transport(stored.session) };
      } else if (current !== null && current.session === stored.session && current.parentOrigin === null) {
        this.#current = { ...current, parentOrigin: stored.parentOrigin };
      }
    }, () => { /* An unreadable store leaves the worker as it started. */ });
    return this.#restoring;
  }

  /** Attaches and retirements run one at a time, so each sees the session the previous one left. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

function decodeStoredSession(value: unknown): { readonly session: string; readonly parentOrigin: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !("session" in value) || !("parentOrigin" in value)) return null;
  const { session, parentOrigin } = value;
  return typeof session === "string" && SESSION.test(session) && isParentOrigin(parentOrigin) ? { session, parentOrigin } : null;
}
