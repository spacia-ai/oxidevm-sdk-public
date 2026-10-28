/** One preview session's HttpOnly cookie jar. HttpOnly cookies never reach the
 * page: they live here, keyed by the session host, and shadow any same-name
 * cookie the page could forge. Visible cookies are handed to the Service Worker
 * for the browser's own store, so `document.cookie` and the browser's
 * SameSite handling stay real. Pure: time is injected. */

export interface ClientContext {
  /** Where the request's client document sits: a top-level page, a frame, or unknown (worker, or no client yet). */
  readonly frame: "top" | "nested" | "none";
  /** The embedder's origin for a frame when the browser exposes it. */
  readonly ancestor: string | null;
  /** True for navigation requests. */
  readonly navigate: boolean;
}

export const UNKNOWN_CLIENT: ClientContext = { frame: "none", ancestor: null, navigate: false };

export type SameSite = "strict" | "lax" | "none";

/** A cookie decision the browser store must apply; `value: null` deletes. */
export interface BrowserCookie {
  readonly name: string;
  readonly value: string | null;
  readonly path: string;
  readonly sameSite: SameSite;
  /** Milliseconds since the epoch, or null for a session cookie. */
  readonly expires: number | null;
}

export interface ParsedCookie {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: SameSite;
  readonly expires: number | null;
}

interface JarCookie extends ParsedCookie { readonly created: number }

export const COOKIE_LIMITS = { cookies: 64, bytes: 4096 } as const;
const NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
// No control characters, separators that would break the Cookie header, or DQUOTE.
const VALUE = /^[!#-+\--:<-[\]-~]*$/u;

/** RFC 6265 §5.2 parsing with the browser rules that matter for isolation:
 * a Domain other than the session host or the guest's localhost, a
 * `SameSite=None` cookie without `Secure`, or a broken `__Secure-`/`__Host-` prefix rejects the cookie. */
export function parseSetCookie(header: string, requestPath: string, host: string, now: number): ParsedCookie | undefined {
  const [pair = "", ...attributes] = header.split(";");
  const separator = pair.indexOf("=");
  if (separator <= 0) return undefined;
  const name = pair.slice(0, separator).trim();
  let value = pair.slice(separator + 1).trim();
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) value = value.slice(1, -1);
  if (!NAME.test(name) || !VALUE.test(value) || new TextEncoder().encode(`${name}=${value}`).byteLength > COOKIE_LIMITS.bytes) return undefined;
  let path: string | undefined;
  let domain: string | undefined;
  let secure = false;
  let httpOnly = false;
  let sameSite: SameSite | undefined;
  let expires: number | null = null;
  let maxAge: number | undefined;
  for (const attribute of attributes) {
    const split = attribute.indexOf("=");
    const key = (split === -1 ? attribute : attribute.slice(0, split)).trim().toLowerCase();
    const content = split === -1 ? "" : attribute.slice(split + 1).trim();
    switch (key) {
      case "expires": { const time = Date.parse(content); if (Number.isFinite(time)) expires = time; break; }
      case "max-age": if (/^-?\d{1,15}$/u.test(content)) maxAge = Number(content); break;
      case "domain": domain = content.replace(/^\./u, "").toLowerCase(); break;
      case "path": path = content.startsWith("/") ? content : undefined; break;
      case "secure": secure = true; break;
      case "httponly": httpOnly = true; break;
      case "samesite": {
        const lowered = content.toLowerCase();
        sameSite = lowered === "strict" || lowered === "none" ? lowered : "lax";
        break;
      }
      default: break;
    }
  }
  // The guest sees Host: localhost:<port> (preview-http-codec), so a Domain it
  // derives from the request names localhost: host-only, as a browser there keeps it.
  if (domain !== undefined && domain !== host.toLowerCase() && domain !== "localhost") return undefined;
  if (name.startsWith("__Secure-") && !secure) return undefined;
  if (name.startsWith("__Host-") && (!secure || path !== "/" || domain !== undefined)) return undefined;
  sameSite ??= "lax";
  if (sameSite === "none" && !secure) return undefined;
  if (maxAge !== undefined) expires = maxAge <= 0 ? now - 1 : now + maxAge * 1000;
  return { name, value, path: path ?? defaultPath(requestPath), secure, httpOnly, sameSite, expires };
}

/** RFC 6265 §5.1.4 default-path. */
export function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith("/")) return "/";
  const end = requestPath.indexOf("?") === -1 ? requestPath.length : requestPath.indexOf("?");
  const last = requestPath.lastIndexOf("/", end - 1);
  return last <= 0 ? "/" : requestPath.slice(0, last);
}

/** RFC 6265 §5.1.4 path-match. */
export function pathMatches(cookiePath: string, requestPath: string): boolean {
  const end = requestPath.indexOf("?") === -1 ? requestPath.length : requestPath.indexOf("?");
  const path = requestPath.slice(0, end);
  return path === cookiePath || (path.startsWith(cookiePath) && (cookiePath.endsWith("/") || path.charAt(cookiePath.length) === "/"));
}

/** Whether a request from this client counts as same-site for the session
 * host. A frame under a foreign or unknown embedder is cross-site. */
export function sameSiteRequest(context: ClientContext, host: string): boolean {
  if (context.frame !== "nested") return true;
  if (context.ancestor === null || !URL.canParse(context.ancestor)) return false;
  return new URL(context.ancestor).hostname.toLowerCase() === host.toLowerCase();
}

export class PreviewCookieJar {
  readonly #host: string;
  readonly #now: () => number;
  readonly #cookies = new Map<string, JarCookie>();

  constructor(host: string, now: () => number = () => Date.now()) {
    this.#host = host.toLowerCase();
    this.#now = now;
  }

  get size(): number { return this.#cookies.size; }

  /** Applies a response's Set-Cookie headers: HttpOnly cookies stay here and
   * the browser's same-name copy is purged; visible cookies move to the browser
   * (a flip out of the jar deletes the jar copy). Returns the browser's work. */
  receive(setCookies: readonly string[], requestPath: string): BrowserCookie[] {
    const now = this.#now();
    const browser: BrowserCookie[] = [];
    for (const header of setCookies) {
      const cookie = parseSetCookie(header, requestPath, this.#host, now);
      if (cookie === undefined) continue;
      const key = `${cookie.name}\u0000${cookie.path}`;
      const expired = cookie.expires !== null && cookie.expires <= now;
      if (cookie.httpOnly) {
        this.#cookies.delete(key);
        if (!expired) this.#store(key, { ...cookie, created: now });
        // The page must not keep a same-name copy the server made private.
        browser.push({ name: cookie.name, value: null, path: cookie.path, sameSite: cookie.sameSite, expires: null });
        continue;
      }
      this.#cookies.delete(key);
      browser.push({ name: cookie.name, value: expired ? null : cookie.value, path: cookie.path, sameSite: cookie.sameSite, expires: cookie.expires });
    }
    return browser;
  }

  /** The Cookie header for a request: jar cookies that match the path and the
   * SameSite context, followed by the browser's cookies minus any name the
   * jar owns. Undefined when nothing applies. */
  cookieHeader(requestPath: string, context: ClientContext, browserCookies: string | undefined): string | undefined {
    const now = this.#now();
    const sameSite = sameSiteRequest(context, this.#host);
    const topLevelNavigation = context.navigate && context.frame !== "nested";
    const sent: JarCookie[] = [];
    for (const [key, cookie] of this.#cookies) {
      if (cookie.expires !== null && cookie.expires <= now) { this.#cookies.delete(key); continue; }
      if (!pathMatches(cookie.path, requestPath)) continue;
      if (cookie.sameSite === "strict" && !sameSite) continue;
      if (cookie.sameSite === "lax" && !sameSite && !topLevelNavigation) continue;
      sent.push(cookie);
    }
    sent.sort((left, right) => right.path.length - left.path.length || left.created - right.created);
    const owned = new Set([...this.#cookies.values()].map(cookie => cookie.name));
    const pairs = sent.map(cookie => `${cookie.name}=${cookie.value}`);
    for (const pair of browserCookies?.split(";") ?? []) {
      const trimmed = pair.trim();
      if (trimmed.length === 0) continue;
      const name = trimmed.slice(0, trimmed.indexOf("=") === -1 ? trimmed.length : trimmed.indexOf("=")).trim();
      if (owned.has(name)) continue;
      pairs.push(trimmed);
    }
    return pairs.length === 0 ? undefined : pairs.join("; ");
  }

  #store(key: string, cookie: JarCookie): void {
    if (this.#cookies.size >= COOKIE_LIMITS.cookies) {
      let oldest: [string, JarCookie] | undefined;
      for (const entry of this.#cookies) if (oldest === undefined || entry[1].created < oldest[1].created) oldest = entry;
      if (oldest !== undefined) this.#cookies.delete(oldest[0]);
    }
    this.#cookies.set(key, cookie);
  }
}
