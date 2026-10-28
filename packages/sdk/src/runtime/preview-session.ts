import { VMError } from "./errors.js";
import { PROTOCOL_VERSION } from "./protocol/common.js";
import { encodeExposePreviewPort, PREVIEW_SESSION_PATTERN } from "./protocol/preview.js";
import { exactKeys, record, string } from "./decode.js";
import type { PreviewHandle, PreviewIsolation } from "./vm-types.js";
import type { KeeperMessage, PreviewKeeper, PreviewKeeperHost } from "./preview-keeper.js";

/** Session identities are 32 lowercase hex characters: they also name the
 * session origin's host label, so no other alphabet is admissible. */
export function previewSessionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export interface PreviewSessionOptions {
  readonly previewOrigin: URL;
  readonly isolation: PreviewIsolation;
  readonly runtime: "system" | "userspace";
  readonly port: number;
  readonly network: { postMessage(message: unknown, transfer?: Transferable[]): void };
  readonly host?: PreviewKeeperHost;
  readonly signal?: AbortSignal;
  readonly bootstrapTimeoutMs?: number;
}

const DEFAULT_BOOTSTRAP_MS = 30_000;

/** One preview session on its own origin: `https://<session>.<preview host>/`.
 * The hidden keeper iframe registers that origin's Service Worker, hands it
 * the network transport, keeps it alive, and re-attaches after a restart. The
 * handle resolves only once the worker acknowledged the transport, so direct
 * tabs to the URL are already proxied. Every failure rejects; nothing throws. */
export function openPreviewSession(options: PreviewSessionOptions): Promise<PreviewHandle> {
  try {
    return start(options);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new VMError("PROTOCOL_ERROR", "Preview session could not start"));
  }
}

function start(options: PreviewSessionOptions): Promise<PreviewHandle> {
  const session = previewSessionId();
  const origin = options.isolation === "shared" ? sharedSessionOrigin(options.previewOrigin) : sessionOrigin(options.previewOrigin, session);
  const host = options.host ?? documentHost();
  const bootstrap = new URL("/__oxidevm/", origin);
  bootstrap.searchParams.set("session", session);
  bootstrap.searchParams.set("parentOrigin", host.origin);
  if (options.isolation === "shared") bootstrap.searchParams.set("isolation", "shared");
  let closed = false;
  let ready = false;
  const settled = Promise.withResolvers<PreviewHandle>();
  const listener = (event: KeeperMessage): void => {
    const source = event.source;
    if (closed || event.origin !== origin.origin || source === null || source.identity !== keeper?.source) return;
    const message = keeperMessage(event.data);
    if (message === undefined || message.session !== session) return;
    if (message.kind === "oxidevm-preview-connect") {
      const channel = new MessageChannel();
      options.network.postMessage(encodeExposePreviewPort({ runtime: options.runtime, isolation: options.isolation, session,
        port: options.port, sessionPort: channel.port1, sessionOrigin: origin.origin }), [channel.port1]);
      source.postMessage({ kind: "oxidevm-preview-port", session, port: channel.port2 }, { targetOrigin: origin.origin, transfer: [channel.port2] });
      return;
    }
    if (message.kind === "oxidevm-preview-failed") {
      // The keeper cannot start this session at all: fail now instead of at the bootstrap timeout.
      if (!ready) settled.reject(keeperFailure(message.reason, origin.origin));
      void close();
      return;
    }
    if (!ready) {
      ready = true;
      settled.resolve(handle);
    }
  };
  let keeper: PreviewKeeper | undefined;
  let unlisten = (): void => {};
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    unlisten();
    options.signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
    keeper?.retire(session);
    keeper?.close();
    options.network.postMessage({ version: PROTOCOL_VERSION, type: "close-preview-session", session });
    if (!ready) settled.reject(new VMError("ABORTED", "Preview session closed before it was ready"));
    return Promise.resolve();
  };
  const handle: PreviewHandle = { url: new URL("/", origin), close };
  const abort = (): void => { void close(); };
  const timer = setTimeout(() => {
    if (ready) return;
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

type KeeperReport =
  | { readonly kind: "oxidevm-preview-connect" | "oxidevm-preview-ready"; readonly session: string }
  | { readonly kind: "oxidevm-preview-failed"; readonly session: string; readonly reason: KeeperFailure };

function keeperMessage(value: unknown): KeeperReport | undefined {
  try {
    const message = record(value, "preview keeper message");
    const kind = message["kind"];
    const session = string(message["session"], "preview session");
    if (!PREVIEW_SESSION_PATTERN.test(session)) return undefined;
    if (kind === "oxidevm-preview-failed") {
      exactKeys(message, ["kind", "session", "reason"]);
      const reason = message["reason"];
      return reason === "service-worker-blocked" || reason === "service-worker-failed" ? { kind, session, reason } : undefined;
    }
    exactKeys(message, ["kind", "session"]);
    return kind === "oxidevm-preview-connect" || kind === "oxidevm-preview-ready" ? { kind, session } : undefined;
  } catch { return undefined; }
}

/** A browser that refuses the worker (Brave's Shields on a cross-site preview origin) denies
 * permission; a worker that failed to start is the preview host's failure. */
function keeperFailure(reason: KeeperFailure, origin: string): VMError {
  return reason === "service-worker-blocked"
    ? new VMError("PERMISSION_DENIED", "The browser refused the preview origin's Service Worker", { reason, origin })
    : new VMError("RELAY_ERROR", "The preview origin's Service Worker failed to start", { reason, origin });
}
