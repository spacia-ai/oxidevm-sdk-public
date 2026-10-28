import type { PreviewRuntimePort } from "./preview-http.js";
import { servePreviewSession } from "./preview-http.js";
import { PreviewCookieJar } from "./preview-cookies.js";

const MAX_PREVIEW_TRANSPORTS = 8;

interface Session {
  readonly origin: URL;
  /** One jar per session origin, shared by every transport of the session. */
  readonly jar: PreviewCookieJar;
  readonly transports: Set<() => void>;
}

/** Network-owned preview sessions for every runtime. A session is one exposed
 * guest port on its own origin with a bounded set of browser transports; the
 * oldest transport retires when a session exceeds its bound, and closing a
 * session ends them all and drops its cookie jar. */
export class PreviewSessions {
  readonly #sessions = new Map<string, Session>();

  expose(session: string, guestPort: number, sessionPort: MessagePort, runtime: PreviewRuntimePort, origin: URL): void {
    const state = this.#sessions.get(session) ?? { origin, jar: new PreviewCookieJar(origin.hostname), transports: new Set<() => void>() };
    if (state.transports.size >= MAX_PREVIEW_TRANSPORTS) {
      const oldest = state.transports.values().next().value;
      if (oldest !== undefined) { oldest(); state.transports.delete(oldest); }
    }
    state.transports.add(servePreviewSession(sessionPort, guestPort, runtime, { origin: state.origin, jar: state.jar }));
    this.#sessions.set(session, state);
  }

  close(session: string): void {
    for (const close of this.#sessions.get(session)?.transports ?? []) close();
    this.#sessions.delete(session);
  }

  closeAll(): void {
    for (const session of [...this.#sessions.keys()]) this.close(session);
  }

  get size(): number { return this.#sessions.size; }
}
