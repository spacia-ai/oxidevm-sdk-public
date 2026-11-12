import type { PreviewSiteAccess } from "./contracts.js";
import { exactKeys, record, string } from "./runtime/decode.js";
import { VMError } from "./runtime/errors.js";

/** The most sites one preview may be granted. */
export const MAX_PREVIEW_SITES = 64;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * The canonical site of a DNS host name with an optional port, or of an https/wss URL: lowercase,
 * punycode, no trailing dot, port 443 omitted. Null for IP literals, localhost, single-label and
 * `.local` names and anything else that is not a site.
 */
export function previewSite(value: string): string | null {
  const full = value.includes("://");
  if (!full && /[/?#@\\]/.test(value)) return null;
  let url: URL;
  try { url = new URL(full ? value : `https://${value}`); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "wss:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  if (host.length === 0 || host.length > 253 || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => label.length <= 63 && LABEL.test(label))) return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1] ?? "")) return null;
  if (url.port === "0") return null;
  return url.port === "" ? host : `${host}:${url.port}`;
}

/** Decodes site access from an untrusted value into its canonical form. */
export function decodePreviewSiteAccess(value: unknown, code: "INVALID_ARGUMENT" | "PROTOCOL_ERROR"): PreviewSiteAccess {
  try {
    const fields = record(value, "site access");
    const kind = string(fields["kind"], "site access kind");
    if (kind === "none" || kind === "any") {
      exactKeys(fields, ["kind"]);
      return { kind };
    }
    if (kind !== "sites") throw new VMError("PROTOCOL_ERROR", `unknown site access kind ${kind}`);
    exactKeys(fields, ["kind", "sites"]);
    const listed = fields["sites"];
    if (!Array.isArray(listed)) throw new VMError("PROTOCOL_ERROR", "site access sites must be an array");
    if (listed.length > MAX_PREVIEW_SITES) throw new VMError("PROTOCOL_ERROR", `at most ${MAX_PREVIEW_SITES} sites are allowed`);
    const sites = new Set<string>();
    const items: readonly unknown[] = listed;
    for (const item of items) {
      const text = string(item, "site");
      const site = previewSite(text);
      if (site === null) throw new VMError("PROTOCOL_ERROR", `${JSON.stringify(text)} is not a site`);
      sites.add(site);
    }
    return sites.size === 0 ? { kind: "none" } : { kind: "sites", sites: [...sites].sort() };
  } catch (error) {
    if (error instanceof VMError) throw new VMError(code, error.message);
    throw error;
  }
}

/** Whether two canonical accesses grant the same thing. */
export function sameSiteAccess(left: PreviewSiteAccess, right: PreviewSiteAccess): boolean {
  if (left.kind !== "sites" || right.kind !== "sites") return left.kind === right.kind;
  return left.sites.length === right.sites.length && left.sites.every((site, index) => site === right.sites[index]);
}
