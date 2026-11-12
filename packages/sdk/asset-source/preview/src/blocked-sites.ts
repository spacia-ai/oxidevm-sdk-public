// Reports the other sites this page's CSP blocked, so the embedding window can offer to grant them.
// The report is advisory and untrusted: it grants nothing, and the receiver decodes it exactly.
import { reportedSite } from "./site-access";

export const MAX_REPORTED_SITES = 32;

export type BlockedDirective = "connect" | "script" | "style" | "image" | "font" | "media" | "frame";

export interface BlockedSiteMessage {
  readonly type: "oxidevm-preview-blocked-site";
  readonly version: 1;
  readonly site: string;
  readonly directive: BlockedDirective;
}

/** The closed directive a violated CSP directive reports as; null for any other. */
export function blockedDirective(effectiveDirective: string): BlockedDirective | null {
  switch (effectiveDirective) {
    case "connect-src": return "connect";
    case "script-src":
    case "script-src-elem": return "script";
    case "style-src":
    case "style-src-elem": return "style";
    case "img-src": return "image";
    case "font-src": return "font";
    case "media-src": return "media";
    case "frame-src":
    case "child-src": return "frame";
    default: return null;
  }
}

/** A violation handler that posts each other site once per document, up to MAX_REPORTED_SITES. */
export function blockedSiteReporter(
  self: string,
  post: (message: BlockedSiteMessage) => void,
): (violation: { readonly blockedURI: string; readonly effectiveDirective: string }) => void {
  const seen = new Set<string>();
  return (violation) => {
    const directive = blockedDirective(violation.effectiveDirective);
    if (directive === null || seen.size >= MAX_REPORTED_SITES) return;
    const site = reportedSite(violation.blockedURI, self);
    if (site === null || seen.has(site)) return;
    seen.add(site);
    post({ type: "oxidevm-preview-blocked-site", version: 1, site, directive });
  };
}
