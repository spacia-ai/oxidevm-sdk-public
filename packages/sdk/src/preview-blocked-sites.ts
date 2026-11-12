import type { BlockedPreviewSite } from "./contracts.js";
import { exactKeys, record } from "./runtime/decode.js";
import { VMError } from "./runtime/errors.js";
import { decodeWatchOptions } from "./runtime/listening-ports.js";
import { previewSite } from "./preview-site-access.js";

// Blocked-site reports (ADR 0030 D6). The script the preview host injects into every preview page posts
// `{ type: "oxidevm-preview-blocked-site", version: 1, site, directive }` to the window that frames it, for
// each other https or wss site the page's Content-Security-Policy blocked, at most 32 per document. The page
// is guest-controlled, so a report is an untrusted hint: it is decoded exactly here and grants nothing.
// Every preview handle, public or of the diagnostics runtime, watches them with `watchHandleBlockedSites`.

/** The most distinct sites one watch delivers. */
export const MAX_BLOCKED_SITES_PER_WATCH = 64;
/** The longest canonical site: a 253-character host name and a port. */
const MAX_SITE_LENGTH = 253 + ":65535".length;

/** Where the reports arrive: the window of the document that frames the previews. */
export interface BlockedSiteSource {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

/**
 * Calls `listener` once for each distinct site that pages on `origin` report to `target`, for at most
 * MAX_BLOCKED_SITES_PER_WATCH sites, then stops listening. Anything that is not exactly a report from `origin`
 * is ignored. Resolves when `signal` aborts; rejects with the listener's error the first time it throws.
 */
export function watchBlockedPreviewSites(target: BlockedSiteSource, origin: string, listener: (blocked: BlockedPreviewSite) => void, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const delivered = new Set<string>();
    const stop = (): void => {
      target.removeEventListener("message", onMessage);
      signal.removeEventListener("abort", aborted);
    };
    const aborted = (): void => { stop(); resolve(); };
    const onMessage = (event: MessageEvent<unknown>): void => {
      const blocked = event.origin === origin ? blockedReport(event.data) : undefined;
      if (blocked === undefined || delivered.has(blocked.site)) return;
      delivered.add(blocked.site);
      // The last site this watch delivers: it stops listening, and still ends only when its signal aborts.
      if (delivered.size === MAX_BLOCKED_SITES_PER_WATCH) target.removeEventListener("message", onMessage);
      try { listener(blocked); }
      catch (error: unknown) {
        stop();
        reject(error instanceof Error ? error : new Error("The blocked-site listener failed", { cause: error }));
      }
    };
    signal.addEventListener("abort", aborted, { once: true });
    target.addEventListener("message", onMessage);
  });
}

/** What ends a preview handle, besides the signal of each of its watches. */
export interface PreviewHandleEnds {
  /** Aborts once the handle closes. */
  readonly closed: AbortSignal;
  /** Aborts when the VM's disposal begins. */
  readonly lifetime: AbortSignal;
}

/** Refuses a handle that closed (ABORTED) or whose VM's disposal began (PROTOCOL_ERROR). */
export function requireUsableHandle(ends: PreviewHandleEnds): void {
  if (ends.closed.aborted) throw new VMError("ABORTED", "The preview handle is closed");
  if (ends.lifetime.aborted) throw new VMError("PROTOCOL_ERROR", "VM has been disposed");
}

/**
 * `watchBlockedSites` of the handle of the preview session on `origin` (contracts.ts `PreviewHandle`). It refuses
 * a listener that is not a function or options without exactly an AbortSignal (INVALID_ARGUMENT) before it checks
 * the handle, then watches this document's window, where the previews it frames post their reports, until the
 * watch's signal aborts, the handle closes or the VM's disposal begins.
 */
export async function watchHandleBlockedSites(
  origin: string, ends: PreviewHandleEnds, listener: (blocked: BlockedPreviewSite) => void, options: { readonly signal: AbortSignal },
): Promise<void> {
  if (typeof listener !== "function") throw new VMError("INVALID_ARGUMENT", "watchBlockedSites needs a listener function");
  const { signal } = decodeWatchOptions(options, "watchBlockedSites");
  requireUsableHandle(ends);
  await watchBlockedPreviewSites(globalThis, origin, listener, AbortSignal.any([signal, ends.closed, ends.lifetime]));
}

/** A report with exactly its four fields, a canonical site and a known directive; undefined for anything else. */
function blockedReport(value: unknown): BlockedPreviewSite | undefined {
  let fields: Readonly<Record<string, unknown>>;
  try {
    fields = record(value, "blocked-site report");
    exactKeys(fields, ["type", "version", "site", "directive"]);
  } catch { return undefined; }
  if (fields["type"] !== "oxidevm-preview-blocked-site" || fields["version"] !== 1) return undefined;
  const site = fields["site"];
  if (typeof site !== "string" || site.length > MAX_SITE_LENGTH || previewSite(site) !== site) return undefined;
  const directive = blockedDirective(fields["directive"]);
  return directive === undefined ? undefined : { site, directive };
}

function blockedDirective(value: unknown): BlockedPreviewSite["directive"] | undefined {
  switch (value) {
    case "connect": case "script": case "style": case "image": case "font": case "media": case "frame":
      return value;
    default:
      return undefined;
  }
}
