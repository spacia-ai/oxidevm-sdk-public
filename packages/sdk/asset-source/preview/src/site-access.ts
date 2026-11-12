// The site rule of the preview host, decoded at its own trust boundary. The SDK keeps a twin of
// the rule in src/preview-site-access.ts; asset-source/preview/site-cases.json holds the shared cases.

export type SiteAccess =
  | { readonly kind: "none" }
  | { readonly kind: "sites"; readonly sites: readonly string[] }
  | { readonly kind: "any" };

const MAX_SITES = 64;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** The canonical site of a host name with an optional port, or of an https/wss URL; null when it is not one. */
export function canonicalSite(value: string): string | null {
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

/** Decodes site access from an untrusted value; null unless it is exactly canonical. */
export function decodeSiteAccess(value: unknown): SiteAccess | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const kind: unknown = Reflect.get(value, "kind");
  if (kind === "none" || kind === "any") return keys.length === 1 ? { kind } : null;
  if (kind !== "sites" || keys.length !== 2) return null;
  const sites: unknown = Reflect.get(value, "sites");
  if (!Array.isArray(sites) || sites.length < 1 || sites.length > MAX_SITES) return null;
  const listed: string[] = [];
  const items: readonly unknown[] = sites;
  for (const site of items) {
    if (typeof site !== "string" || canonicalSite(site) !== site) return null;
    const previous = listed[listed.length - 1];
    if (previous !== undefined && previous >= site) return null;
    listed.push(site);
  }
  return { kind: "sites", sites: listed };
}

/** The CSP source expressions a granted access adds, each with a leading space. */
export function siteSources(access: SiteAccess): string {
  switch (access.kind) {
    case "none": return "";
    case "any": return " https: wss:";
    case "sites": return access.sites.map((site) => ` https://${site} wss://${site}`).join("");
  }
}

/** The other site a CSP violation's blocked URI names, or null (keywords, other schemes, the page itself). */
export function reportedSite(blockedURI: string, self: string): string | null {
  if (!blockedURI.includes("://")) return null;
  const site = canonicalSite(blockedURI);
  return site === null || site === canonicalSite(self) ? null : site;
}
