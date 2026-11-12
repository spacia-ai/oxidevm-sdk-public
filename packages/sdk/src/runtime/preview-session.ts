import type { PreviewSiteAccess } from "../contracts.js";
import { decodePreviewSiteAccess, sameSiteAccess } from "../preview-site-access.js";
import { VMError } from "./errors.js";
import { PROTOCOL_VERSION } from "./protocol/common.js";
import { encodeExposePreviewPort, PREVIEW_SESSION_PATTERN } from "./protocol/preview.js";
import { exactKeys, integer, record, string } from "./decode.js";
import type { PreviewHandle, PreviewIsolation } from "./vm-types.js";
import type { KeeperMessage, KeeperSource, PreviewKeeper, PreviewKeeperHost } from "./preview-keeper.js";

/** Session identities are 32 lowercase hex characters: they also name the
 * session origin's host label, so no other alphabet is admissible. */
export function previewSessionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** What an open session gives the VM that opened it; the VM's preview handle adds the blocked-site watch. */
export type PreviewSessionHandle = Pick<PreviewHandle, "url" | "setSiteAccess" | "close">;

export interface PreviewSessionOptions {
  readonly previewOrigin: URL;
  readonly isolation: PreviewIsolation;
  readonly runtime: "system" | "userspace";
  readonly port: number;
  readonly network: { postMessage(message: unknown, transfer?: Transferable[]): void };
  readonly host?: PreviewKeeperHost;
  readonly signal?: AbortSignal;
  readonly bootstrapTimeoutMs?: number;
  /** The sites the session's pages may reach besides their own origin (ADR 0030); none when absent. */
  readonly siteAccess?: PreviewSiteAccess;
}

const DEFAULT_BOOTSTRAP_MS = 30_000;
/** How long a session waits for its keeper to answer a site access change. A keeper from a preview
 * host older than site access never answers (ADR 0030 D7). */
export const SITES_REPLY_MS = 10_000;
const MAX_SITES_REVISION = 0x7fff_ffff;
const NO_SITES: PreviewSiteAccess = { kind: "none" };

/** One preview session on its own origin: `https://<session>.<preview host>/`.
 * The hidden keeper iframe registers that origin's Service Worker, hands it
 * the network transport, keeps it alive, and re-attaches after a restart. The
 * handle resolves only once the worker acknowledged the transport, so direct
 * tabs to the URL are already proxied, and, for a session that opens with sites,
 * once the worker applied them. Every failure rejects; nothing throws. */
export function openPreviewSession(options: PreviewSessionOptions): Promise<PreviewSessionHandle> {
  try {
    return start(options);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new VMError("PROTOCOL_ERROR", "Preview session could not start"));
  }
}

function start(options: PreviewSessionOptions): Promise<PreviewSessionHandle> {
  // Decoded before anything opens, so an invalid access posts nothing.
  const opening = options.siteAccess === undefined ? NO_SITES : decodePreviewSiteAccess(options.siteAccess, "INVALID_ARGUMENT");
  const session = previewSessionId();
  const origin = options.isolation === "shared" ? sharedSessionOrigin(options.previewOrigin) : sessionOrigin(options.previewOrigin, session);
  const host = options.host ?? documentHost();
  const bootstrap = new URL("/__oxidevm/", origin);
  bootstrap.searchParams.set("session", session);
  bootstrap.searchParams.set("parentOrigin", host.origin);
  if (options.isolation === "shared") bootstrap.searchParams.set("isolation", "shared");
  // bootstrap: until the keeper is ready; granting: until it applied the opening sites; open: the handle resolved.
  let phase: "bootstrap" | "granting" | "open" | "closed" = "bootstrap";
  // The keeper document, as its first trusted message named it: site access changes are posted to it.
  let keeperSource: KeeperSource | undefined;
  const settled = Promise.withResolvers<PreviewSessionHandle>();
  const sites = new SessionSites(session, origin.origin, message => {
    if (keeperSource === undefined) throw new VMError("PROTOCOL_ERROR", "The preview keeper has not reported yet");
    keeperSource.postMessage(message, { targetOrigin: origin.origin, transfer: [] });
  });
  const listener = (event: KeeperMessage): void => {
    const source = event.source;
    if (phase === "closed" || event.origin !== origin.origin || source === null || source.identity !== keeper?.source) return;
    const message = keeperMessage(event.data);
    if (message === undefined || message.session !== session) return;
    keeperSource ??= source;
    switch (message.kind) {
      case "oxidevm-preview-connect":
        connectTransport(options, session, origin.origin, source);
        return;
      case "oxidevm-preview-failed":
        // The keeper cannot start this session at all: fail now instead of at the bootstrap timeout.
        fail(keeperFailure(message.reason, origin.origin));
        return;
      case "oxidevm-preview-ready":
        if (phase === "bootstrap") attached();
        return;
      case "oxidevm-preview-sites-applied":
      case "oxidevm-preview-sites-refused":
        sites.answer(message);
        return;
    }
  };
  // The keeper attached its worker. The opening sites go out only now: before its first attach it answers "no-worker".
  const attached = (): void => {
    clearTimeout(timer);
    if (opening.kind === "none") { resolveHandle(); return; }
    phase = "granting";
    void sites.set(opening).then(resolveHandle, (error: unknown) => { fail(error instanceof Error ? error : new VMError("PROTOCOL_ERROR", "Preview site access failed")); });
  };
  const resolveHandle = (): void => {
    if (phase === "closed") return;
    phase = "open";
    settled.resolve(handle);
  };
  // Rejects the opening while it is pending, and ends the session.
  const fail = (error: Error): void => {
    if (phase !== "open") settled.reject(error);
    void close();
  };
  let keeper: PreviewKeeper | undefined;
  let unlisten = (): void => {};
  const close = (): Promise<void> => {
    if (phase === "closed") return Promise.resolve();
    const opened = phase === "open";
    phase = "closed";
    unlisten();
    options.signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
    sites.close();
    keeper?.retire(session);
    keeper?.close();
    options.network.postMessage({ version: PROTOCOL_VERSION, type: "close-preview-session", session });
    if (!opened) settled.reject(new VMError("ABORTED", "Preview session closed before it was ready"));
    return Promise.resolve();
  };
  const handle: PreviewSessionHandle = { url: new URL("/", origin), setSiteAccess: (access, request) => sites.set(access, request?.signal), close };
  const abort = (): void => { void close(); };
  const timer = setTimeout(() => {
    if (phase !== "bootstrap") return;
    settled.reject(new VMError("RELAY_ERROR", "Preview session did not bootstrap in time", { origin: origin.origin }));
    void close();
  }, options.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_MS);
  if (options.signal?.aborted === true) { clearTimeout(timer); return Promise.reject(new VMError("ABORTED", "Preview session cancelled")); }
  options.signal?.addEventListener("abort", abort, { once: true });
  unlisten = host.listen(listener);
  void settled.promise.catch(() => { /* Reported to the caller below. */ });
  try { keeper = host.open(bootstrap); }
  catch (error) { void close(); throw error; }
  return settled.promise;
}

/** Hands the network worker one end of a fresh session transport and the keeper the other. */
function connectTransport(options: PreviewSessionOptions, session: string, origin: string, source: KeeperSource): void {
  const channel = new MessageChannel();
  options.network.postMessage(encodeExposePreviewPort({ runtime: options.runtime, isolation: options.isolation, session,
    port: options.port, sessionPort: channel.port1, sessionOrigin: origin }), [channel.port1]);
  source.postMessage({ kind: "oxidevm-preview-port", session, port: channel.port2 }, { targetOrigin: origin, transfer: [channel.port2] });
}

export function sessionOrigin(previewOrigin: URL, session: string): URL {
  if (!PREVIEW_SESSION_PATTERN.test(session)) throw new VMError("INVALID_ARGUMENT", "Invalid preview session identity");
  if (previewOrigin.origin !== previewOrigin.href.replace(/\/$/u, "") || /^[\d.]+$|^\[/u.test(previewOrigin.hostname) || previewOrigin.hostname.length === 0) {
    throw new VMError("INVALID_ARGUMENT", "previewOrigin must be a bare origin with a DNS host that admits session subdomains");
  }
  return new URL(`${previewOrigin.protocol}//${session}.${previewOrigin.host}/`);
}

/** The shared address is the preview origin itself, so it needs no DNS host for session
 * subdomains and may be an IP literal. */
export function sharedSessionOrigin(previewOrigin: URL): URL {
  if (previewOrigin.origin !== previewOrigin.href.replace(/\/$/u, "")) {
    throw new VMError("INVALID_ARGUMENT", "previewOrigin must be a bare origin");
  }
  return new URL(`${previewOrigin.origin}/`);
}

/** Whether `url` is on an origin this preview origin hands to sessions: a session's own
 * subdomain, or the shared address itself. For embedders that pass a preview URL through their
 * own addresses, such as a page that opens a preview in a tab of its own. */
export function isPreviewSessionOrigin(url: URL, previewOrigin: string, isolation: PreviewIsolation): boolean {
  if (!URL.canParse(previewOrigin)) return false;
  const preview = new URL(previewOrigin);
  try {
    if (isolation === "shared") return sharedSessionOrigin(preview).origin === url.origin;
    const label = url.hostname.split(".", 1)[0] ?? "";
    return PREVIEW_SESSION_PATTERN.test(label) && sessionOrigin(preview, label).origin === url.origin;
  } catch {
    return false;
  }
}

function documentHost(): PreviewKeeperHost {
  return {
    origin: globalThis.location.origin,
    listen: listener => {
      const handler = (event: MessageEvent<unknown>): void => {
        const source = event.source;
        listener({ origin: event.origin, data: event.data,
          source: source === null ? null : { identity: source, postMessage: (message, options) => { source.postMessage(message, options); } } });
      };
      globalThis.addEventListener("message", handler);
      return () => { globalThis.removeEventListener("message", handler); };
    },
    open: url => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
      frame.setAttribute("aria-hidden", "true");
      frame.style.display = "none";
      frame.title = "OxideVM preview session keeper";
      frame.src = url.href;
      document.body.append(frame);
      return {
        source: frame.contentWindow,
        retire: session => { try { frame.contentWindow?.postMessage({ kind: "oxidevm-preview-retire", session }, url.origin); } catch { /* The keeper may already be gone. */ } },
        close: () => { frame.remove(); },
      };
    },
  };
}

type KeeperFailure = "service-worker-blocked" | "service-worker-failed";
type SitesRefusal = "stale" | "retired" | "no-worker";

/** The keeper's answer to a site access revision the session posted. */
type SitesAnswer =
  | { readonly kind: "oxidevm-preview-sites-applied"; readonly session: string; readonly revision: number }
  | { readonly kind: "oxidevm-preview-sites-refused"; readonly session: string; readonly revision: number; readonly reason: SitesRefusal };

type KeeperReport =
  | { readonly kind: "oxidevm-preview-connect" | "oxidevm-preview-ready"; readonly session: string }
  | { readonly kind: "oxidevm-preview-failed"; readonly session: string; readonly reason: KeeperFailure }
  | SitesAnswer;

function keeperMessage(value: unknown): KeeperReport | undefined {
  try {
    const message = record(value, "preview keeper message");
    const kind = message["kind"];
    const session = string(message["session"], "preview session");
    if (!PREVIEW_SESSION_PATTERN.test(session)) return undefined;
    switch (kind) {
      case "oxidevm-preview-connect":
      case "oxidevm-preview-ready":
        exactKeys(message, ["kind", "session"]);
        return { kind, session };
      case "oxidevm-preview-failed": {
        exactKeys(message, ["kind", "session", "reason"]);
        const reason = message["reason"];
        return reason === "service-worker-blocked" || reason === "service-worker-failed" ? { kind, session, reason } : undefined;
      }
      case "oxidevm-preview-sites-applied":
        exactKeys(message, ["kind", "session", "revision"]);
        return { kind, session, revision: integer(message["revision"], "site access revision", 1, MAX_SITES_REVISION) };
      case "oxidevm-preview-sites-refused": {
        exactKeys(message, ["kind", "session", "revision", "reason"]);
        const revision = integer(message["revision"], "site access revision", 1, MAX_SITES_REVISION);
        const reason = message["reason"];
        return reason === "stale" || reason === "retired" || reason === "no-worker" ? { kind, session, revision, reason } : undefined;
      }
      default:
        return undefined;
    }
  } catch { return undefined; }
}

/** A browser that refuses the worker (Brave's Shields on a cross-site preview origin) denies
 * permission; a worker that failed to start is the preview host's failure. */
function keeperFailure(reason: KeeperFailure, origin: string): VMError {
  return reason === "service-worker-blocked"
    ? new VMError("PERMISSION_DENIED", "The browser refused the preview origin's Service Worker", { reason, origin })
    : new VMError("RELAY_ERROR", "The preview origin's Service Worker failed to start", { reason, origin });
}

interface PendingChange {
  readonly reply: PromiseWithResolvers<undefined>;
  /** Stops the change's reply timer and its signal listener. */
  readonly release: () => void;
}

/**
 * One session's site access (ADR 0030). Each change posts the next revision to the keeper, which hands
 * it to the session origin's Service Worker; the worker keeps the highest revision it applied, so the
 * last change wins. A change resolves once the keeper reports it applied. A change without an answer
 * within SITES_REPLY_MS fails as a preview host that predates site access until the keeper answered
 * one, and as a change no Service Worker took (RELAY_ERROR "no-answer") from then on.
 */
class SessionSites {
  readonly #session: string;
  readonly #origin: string;
  readonly #post: (message: Readonly<Record<string, unknown>>) => void;
  readonly #pending = new Map<number, PendingChange>();
  /** The last revision posted; before any, the worker's own default of none. */
  #latest: { readonly revision: number; readonly access: PreviewSiteAccess; readonly applied: boolean } = { revision: 0, access: NO_SITES, applied: true };
  /** The keeper answered a change, applied or refused: its preview host takes site access. */
  #answered = false;
  #closed = false;

  constructor(session: string, origin: string, post: (message: Readonly<Record<string, unknown>>) => void) {
    this.#session = session;
    this.#origin = origin;
    this.#post = post;
  }

  /** Posts `access` unless it is the access the worker applied last; even none, so a revoke reaches it. */
  set(access: PreviewSiteAccess, signal?: AbortSignal): Promise<void> {
    let canonical: PreviewSiteAccess;
    try { canonical = decodePreviewSiteAccess(access, "INVALID_ARGUMENT"); }
    catch (error) { return Promise.reject(error instanceof Error ? error : new VMError("INVALID_ARGUMENT", "Invalid preview site access")); }
    if (this.#closed) return Promise.reject(new VMError("ABORTED", "Preview session is closed"));
    if (signal?.aborted === true) return Promise.reject(new VMError("ABORTED", "Preview site access change cancelled"));
    // A change that failed, timed out or was cancelled may still apply later, so only an applied one is skipped.
    if (this.#latest.applied && sameSiteAccess(this.#latest.access, canonical)) return Promise.resolve();
    const revision = this.#latest.revision + 1;
    if (revision > MAX_SITES_REVISION) return Promise.reject(new VMError("PROTOCOL_ERROR", "Preview session has no site access revisions left"));
    this.#latest = { revision, access: canonical, applied: false };
    const reply = Promise.withResolvers<undefined>();
    const timer = setTimeout(() => { this.#settle(revision, this.#answered ? unanswered(this.#origin) : hostOutdated(this.#origin)); }, SITES_REPLY_MS);
    const abort = (): void => { this.#settle(revision, new VMError("ABORTED", "Preview site access change cancelled")); };
    signal?.addEventListener("abort", abort, { once: true });
    this.#pending.set(revision, { reply, release: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } });
    try { this.#post({ kind: "oxidevm-preview-sites", session: this.#session, revision, access: canonical }); }
    catch { this.#settle(revision, new VMError("RELAY_ERROR", "The preview keeper could not be reached", { origin: this.#origin })); }
    return reply.promise;
  }

  /** The keeper's answer. One for a revision that is not waiting (late or repeated) settles nothing, but
   * it shows, like any other, that the keeper takes site access. */
  answer(answer: SitesAnswer): void {
    this.#answered = true;
    if (!this.#pending.has(answer.revision)) return;
    if (answer.kind === "oxidevm-preview-sites-refused") {
      this.#settle(answer.revision, sitesRefusal(answer.reason, this.#origin));
      return;
    }
    if (answer.revision === this.#latest.revision) this.#latest = { ...this.#latest, applied: true };
    this.#settle(answer.revision, null);
  }

  /** The session closed: every change still waiting fails, and so does every later one. */
  close(): void {
    this.#closed = true;
    for (const revision of [...this.#pending.keys()]) this.#settle(revision, new VMError("ABORTED", "Preview session closed"));
  }

  #settle(revision: number, failure: VMError | null): void {
    const pending = this.#pending.get(revision);
    if (pending === undefined) return;
    this.#pending.delete(revision);
    pending.release();
    if (failure === null) pending.reply.resolve(undefined);
    else pending.reply.reject(failure);
  }
}

/** A keeper from a preview host older than site access ignores the change and never answers. */
function hostOutdated(origin: string): VMError {
  return new VMError("FEATURE_NOT_AVAILABLE", "The preview host did not answer the site access change; it may predate site access", { reason: "preview-host-outdated", origin });
}

/** A keeper that answered an earlier change answers each one within its own wait, so its silence means the
 * change never reached it or its Service Worker. The keeper sends its last access again when it reattaches. */
function unanswered(origin: string): VMError {
  return new VMError("RELAY_ERROR", "The preview keeper did not answer the site access change", { reason: "no-answer", origin });
}

function sitesRefusal(reason: SitesRefusal, origin: string): VMError {
  switch (reason) {
    case "stale":
      return new VMError("PROTOCOL_ERROR", "The preview Service Worker already holds this or a newer site access revision", { reason, origin });
    case "retired":
      return new VMError("ABORTED", "The preview session ended before its site access applied", { reason, origin });
    case "no-worker":
      return new VMError("RELAY_ERROR", "The preview origin's Service Worker did not take the site access", { reason, origin });
  }
}
