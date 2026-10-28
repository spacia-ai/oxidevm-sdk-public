import { nodeQuerystring } from "./node-querystring.ts";
import { resolveLegacyUrl } from "./node-url-resolve.ts";

/** Node's legacy `url.parse` model: one field per component, `null` when the
 * input has no such component. Protocol-relative inputs only denote a host
 * when the caller asks (`slashesDenoteHost`), exactly as in Node. */
export class Url {
  protocol: string | null = null;
  slashes: boolean | null = null;
  auth: string | null = null;
  host: string | null = null;
  port: string | null = null;
  hostname: string | null = null;
  hash: string | null = null;
  search: string | null = null;
  query: string | Record<string, unknown> | null = null;
  pathname: string | null = null;
  path: string | null = null;
  href: string | null = null;

  parse(input: unknown, parseQueryString = false, slashesDenoteHost = false): this {
    if (typeof input !== "string") throw invalidArgument(`The "url" argument must be of type string. Received ${describe(input)}`);
    let rest = trimAndForwardSlash(input);
    const hasHash = rest.includes("#");
    if (!slashesDenoteHost && !hasHash) {
      const simple = /^(\/\/?(?!\/)[^?\s]*)(\?[^\s]*)?$/u.exec(rest);
      if (simple !== null) {
        this.path = rest; this.href = rest; this.pathname = simple[1] ?? null;
        const search = simple[2];
        if (search !== undefined) { this.search = search; this.query = parseQueryString ? nodeQuerystring.parse(search.slice(1)) : search.slice(1); }
        else if (parseQueryString) { this.search = null; this.query = {}; }
        return this;
      }
    }
    const protocolMatch = /^[a-z0-9.+-]+:/iu.exec(rest);
    const proto = protocolMatch?.[0];
    const lowerProto = proto?.toLowerCase();
    if (proto !== undefined && lowerProto !== undefined) { this.protocol = lowerProto; rest = rest.slice(proto.length); }
    let slashes = false;
    if (slashesDenoteHost || proto !== undefined || /^\/\/[^@/]+@[^@/]+/u.test(rest)) {
      slashes = rest.startsWith("//");
      if (slashes && !(proto !== undefined && HOSTLESS.has(lowerProto ?? ""))) { rest = rest.slice(2); this.slashes = true; }
    }
    if (!HOSTLESS.has(lowerProto ?? "") && (slashes || (proto !== undefined && !SLASHED.has(proto)))) rest = this.parseAuthority(rest, input);
    if (!UNSAFE.has(lowerProto ?? "")) rest = autoEscape(rest);
    const hashIndex = rest.indexOf("#");
    if (hashIndex !== -1) this.hash = rest.slice(hashIndex);
    const questionIndex = rest.indexOf("?");
    if (questionIndex !== -1 && (hashIndex === -1 || questionIndex < hashIndex)) {
      this.search = hashIndex === -1 ? rest.slice(questionIndex) : rest.slice(questionIndex, hashIndex);
      this.query = parseQueryString ? nodeQuerystring.parse(this.search.slice(1)) : this.search.slice(1);
    } else if (parseQueryString) { this.search = null; this.query = {}; }
    const firstIndex = questionIndex !== -1 && (hashIndex === -1 || questionIndex < hashIndex) ? questionIndex : hashIndex;
    if (firstIndex === -1) { if (rest.length > 0) this.pathname = rest; }
    else if (firstIndex > 0) this.pathname = rest.slice(0, firstIndex);
    if (SLASHED.has(lowerProto ?? "") && this.hostname !== null && this.hostname !== "" && this.pathname === null) this.pathname = "/";
    if (this.pathname !== null || this.search !== null) this.path = `${this.pathname ?? ""}${this.search ?? ""}`;
    this.href = this.format();
    return this;
  }

  /** Splits `[auth@]host[:port]` off `rest`. The first `/`, `?` or `#` ends
   * the host; a later `@` re-opens it as auth, so `a@b@c/` is user `a@b` on
   * host `c` but `a@b?@c` is user `a` on host `b`. */
  private parseAuthority(rest: string, input: string): string {
    let hostEnd = -1; let atSign = -1; let nonHost = -1;
    for (let index = 0; index < rest.length && hostEnd === -1; index += 1) {
      const character = rest[index] ?? "";
      if ("#/?".includes(character)) { if (nonHost === -1) nonHost = index; hostEnd = index; }
      else if (character === "@") { atSign = index; nonHost = -1; }
      else if ("\t\n\r \"%';<>\\^`{|}".includes(character) && nonHost === -1) nonHost = index;
    }
    let start = 0;
    if (atSign !== -1) { this.auth = decodeURIComponent(rest.slice(0, atSign)); start = atSign + 1; }
    if (nonHost === -1) { this.host = rest.slice(start); rest = ""; } else { this.host = rest.slice(start, nonHost); rest = rest.slice(nonHost); }
    const portMatch = /:[0-9]*$/u.exec(this.host);
    let host = this.host;
    if (portMatch !== null) { if (portMatch[0] !== ":") this.port = portMatch[0].slice(1); host = host.slice(0, host.length - portMatch[0].length); }
    this.hostname = host;
    const ipv6 = host.startsWith("[") && host.endsWith("]");
    if (!ipv6) {
      const invalid = /[/\\#?:]/u.exec(host);
      if (invalid !== null) { this.hostname = host.slice(0, invalid.index); rest = `/${host.slice(invalid.index)}${rest}`; }
    }
    this.hostname = this.hostname.length > 255 ? "" : this.hostname.toLowerCase();
    if (this.hostname !== "") {
      if (ipv6) { if (hasForbiddenHostCharacter(this.hostname, " #%/<>?@\\^|")) throw invalidUrl(input); }
      else {
        this.hostname = toAscii(this.hostname, input);
        if (this.hostname === "" || hasForbiddenHostCharacter(this.hostname, " #%/:<>?@[\\]^|")) throw invalidUrl(input);
      }
    }
    this.host = `${this.hostname}${this.port === null ? "" : `:${this.port}`}`;
    if (ipv6) { this.hostname = this.hostname.slice(1, -1); if (!rest.startsWith("/")) rest = `/${rest}`; }
    return rest;
  }

  format(): string { return formatLegacy(this); }
  resolve(relative: unknown): string { return this.resolveObject(relative).format(); }
  resolveObject(relative: unknown): Url {
    const parsed = relative instanceof Url ? relative : new Url().parse(relative, false, true);
    return resolveLegacyUrl(this, parsed);
  }
}

/** Fields `Url.prototype.format` reads from a plain object or a `Url`. */
export function formatLegacy(input: object): string {
  const text = (name: string): string => { const value: unknown = Reflect.get(input, name); return typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : ""; };
  const rawAuth = text("auth");
  const auth = rawAuth === "" ? "" : `${encodeAuth(rawAuth)}@`;
  let protocol = text("protocol");
  let pathname = text("pathname");
  let hash = text("hash");
  let host = "";
  if (text("host") !== "") host = auth + text("host");
  else if (text("hostname") !== "") {
    const hostname = text("hostname");
    host = auth + (hostname.includes(":") && !(hostname.startsWith("[") && hostname.endsWith("]")) ? `[${hostname}]` : hostname);
    if (text("port") !== "") host += `:${text("port")}`;
  }
  const query: unknown = Reflect.get(input, "query");
  const queryText = query !== null && typeof query === "object" ? nodeQuerystring.stringify(query) : "";
  let search = text("search") !== "" ? text("search") : queryText !== "" ? `?${queryText}` : "";
  if (protocol !== "" && !protocol.endsWith(":")) protocol += ":";
  pathname = pathname.replace(/#/gu, "%23").replace(/\?/gu, "%3F");
  const slashes = Reflect.get(input, "slashes") === true;
  if (slashes || SLASHED.has(protocol)) {
    if (slashes || host !== "") { if (pathname !== "" && !pathname.startsWith("/")) pathname = `/${pathname}`; host = `//${host}`; }
    else if (protocol.startsWith("file")) host = "//";
  }
  search = search.replace(/#/gu, "%23");
  if (hash !== "" && !hash.startsWith("#")) hash = `#${hash}`;
  if (search !== "" && !search.startsWith("?")) search = `?${search}`;
  return `${protocol}${host}${pathname}${search}${hash}`;
}

export const SLASHED: ReadonlySet<string> = new Set(["http", "http:", "https", "https:", "ftp", "ftp:", "gopher", "gopher:", "file", "file:", "ws", "ws:", "wss", "wss:"]);
const HOSTLESS: ReadonlySet<string> = new Set(["javascript", "javascript:"]);
const UNSAFE = HOSTLESS;

/** Node trims surrounding whitespace and converts backslashes before the
 * first `?` or `#` into forward slashes. */
function trimAndForwardSlash(input: string): string {
  let start = 0; let end = input.length;
  while (start < end && isWhitespace(input.charCodeAt(start))) start += 1;
  while (end > start && isWhitespace(input.charCodeAt(end - 1))) end -= 1;
  const trimmed = input.slice(start, end);
  const split = /[?#]/u.exec(trimmed);
  if (split === null) return trimmed.replace(/\\/gu, "/");
  return `${trimmed.slice(0, split.index).replace(/\\/gu, "/")}${trimmed.slice(split.index)}`;
}

/** Userinfo keeps RFC 3986 unreserved characters, sub-delims and `:`. */
function encodeAuth(auth: string): string {
  return auth.replace(/[^A-Za-z0-9!$&'()*+,\-.:;=_~]+/gu, run => encodeURIComponent(run).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`));
}

function isAscii(text: string): boolean { for (let index = 0; index < text.length; index += 1) { if (text.charCodeAt(index) > 0x7f) return false; } return true; }
function isWhitespace(code: number): boolean { return code < 33 || code === 0xa0 || code === 0xfeff; }
/** NUL, tab, line feed and carriage return are forbidden in every host; the
 * remaining forbidden set differs between IPv6 literals and names. */
function hasForbiddenHostCharacter(hostname: string, forbidden: string): boolean {
  for (const character of hostname) { const code = character.charCodeAt(0); if (code === 0 || code === 9 || code === 10 || code === 13 || forbidden.includes(character)) return true; }
  return false;
}

function autoEscape(rest: string): string {
  return rest.replace(/[\t\n\r "'<>\\^`{|}]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** IDNA through the browser's URL parser; Node applies the same `toASCII`. */
function toAscii(hostname: string, input: string): string {
  if (isAscii(hostname)) return hostname;
  try { return new URL(`http://${hostname}`).hostname; } catch { throw invalidUrl(input); }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") {
    const constructor: unknown = Reflect.get(value, "constructor");
    const name: unknown = typeof constructor === "function" ? Reflect.get(constructor, "name") : undefined;
    return `an instance of ${typeof name === "string" && name !== "" ? name : "Object"}`;
  }
  if (typeof value === "function") return "an instance of Function";
  if (typeof value === "string") return `type string (${JSON.stringify(value)})`;
  if (typeof value === "symbol") return `type symbol (${value.toString()})`;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return `type ${typeof value} (${String(value)})`;
  }
  return "type undefined (undefined)";
}
function invalidArgument(message: string): TypeError { return Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" }); }
function invalidUrl(input: string): TypeError { return Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL", input }); }
