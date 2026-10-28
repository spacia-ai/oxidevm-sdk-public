import { SLASHED, Url } from "./node-url-legacy.ts";

const HOSTLESS: ReadonlySet<string> = new Set(["javascript", "javascript:"]);
const FIELDS = ["protocol", "slashes", "auth", "host", "port", "hostname", "hash", "search", "query", "pathname", "path", "href"] as const;

/** Node's legacy `Url#resolveObject`: the relative url's components replace
 * the base's from the first one it carries, dot segments collapse, and a
 * non-slashed base protocol keeps its host inside the path. */
export function resolveLegacyUrl(base: Url, relative: Url): Url {
  const result = new Url();
  copy(result, base, null);
  result.hash = relative.hash;
  if (relative.href === "") return finish(result);
  if (relative.slashes === true && relative.protocol === null) {
    copy(result, relative, "protocol");
    if (SLASHED.has(result.protocol ?? "") && truthy(result.hostname) && !truthy(result.pathname)) { result.path = "/"; result.pathname = "/"; }
    return finish(result);
  }
  if (relative.protocol !== null && relative.protocol !== result.protocol) return resolveProtocolChange(result, relative);
  const isSourceAbs = result.pathname?.startsWith("/") ?? false;
  const isRelAbs = truthy(relative.host) || (relative.pathname?.startsWith("/") ?? false);
  let mustEndAbs = isRelAbs || isSourceAbs || (truthy(result.host) && truthy(relative.pathname));
  const removeAllDots = mustEndAbs;
  let srcPath = truthy(result.pathname) ? result.pathname.split("/") : [];
  const relPath = truthy(relative.pathname) ? relative.pathname.split("/") : [];
  const noLeadingSlashes = truthy(result.protocol) && !SLASHED.has(result.protocol);
  if (noLeadingSlashes) {
    result.hostname = ""; result.port = null;
    if (truthy(result.host)) { if (srcPath[0] === "") srcPath[0] = result.host; else srcPath.unshift(result.host); }
    result.host = "";
    if (truthy(relative.protocol)) {
      relative.hostname = null; relative.port = null; result.auth = null;
      if (truthy(relative.host)) { if (relPath[0] === "") relPath[0] = relative.host; else relPath.unshift(relative.host); }
      relative.host = null;
    }
    mustEndAbs = mustEndAbs && (relPath[0] === "" || srcPath[0] === "");
  }
  if (isRelAbs) {
    if (relative.host !== null) { if (result.host !== relative.host) result.auth = null; result.host = relative.host; result.port = relative.port; }
    if (relative.hostname !== null) { if (result.hostname !== relative.hostname) result.auth = null; result.hostname = relative.hostname; }
    result.search = relative.search; result.query = relative.query;
    srcPath = relPath;
  } else if (relPath.length > 0) {
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search; result.query = relative.query;
  } else if (relative.search !== null) {
    if (noLeadingSlashes) { const head = srcPath.shift() ?? null; result.hostname = head; result.host = head; splitAuth(result); }
    result.search = relative.search; result.query = relative.query;
    result.path = `${result.pathname ?? ""}${relative.search}`;
    return finish(result);
  }
  if (srcPath.length === 0) { result.pathname = null; result.path = truthy(result.search) ? `/${result.search}` : null; return finish(result); }
  let last = srcPath[srcPath.length - 1];
  const hasTrailingSlash = ((truthy(result.host) || truthy(relative.host) || srcPath.length > 1) && (last === "." || last === "..")) || last === "";
  let up = 0;
  for (let index = srcPath.length - 1; index >= 0; index -= 1) {
    last = srcPath[index];
    if (last === ".") srcPath.splice(index, 1);
    else if (last === "..") { srcPath.splice(index, 1); up += 1; }
    else if (up > 0) { srcPath.splice(index, 1); up -= 1; }
  }
  if (!mustEndAbs && !removeAllDots) { while (up > 0) { srcPath.unshift(".."); up -= 1; } }
  if (mustEndAbs && srcPath[0] !== "" && !(srcPath[0]?.startsWith("/") ?? false)) srcPath.unshift("");
  if (hasTrailingSlash && !srcPath.join("/").endsWith("/")) srcPath.push("");
  const isAbsolute = srcPath[0] === "" || (srcPath[0]?.startsWith("/") ?? false);
  if (noLeadingSlashes) { const head = isAbsolute ? "" : srcPath.length > 0 ? srcPath.shift() ?? "" : ""; result.hostname = head; result.host = head; splitAuth(result); }
  mustEndAbs = mustEndAbs || (truthy(result.host) && srcPath.length > 0);
  if (mustEndAbs && !isAbsolute) srcPath.unshift("");
  if (srcPath.length === 0) { result.pathname = null; result.path = null; } else result.pathname = srcPath.join("/");
  if (result.pathname !== null || result.search !== null) result.path = `${result.pathname ?? ""}${result.search ?? ""}`;
  result.auth = truthy(relative.auth) ? relative.auth : result.auth;
  result.slashes = result.slashes === true || relative.slashes === true ? true : result.slashes ?? relative.slashes;
  return finish(result);
}

function resolveProtocolChange(result: Url, relative: Url): Url {
  const protocol = relative.protocol ?? "";
  if (!SLASHED.has(protocol)) { copy(result, relative, null); return finish(result); }
  result.protocol = protocol;
  if (!truthy(relative.host) && !/^file:?$/u.test(protocol) && !HOSTLESS.has(protocol)) {
    const relPath = (relative.pathname ?? "").split("/");
    let host: string | undefined;
    while (relPath.length > 0 && !truthy(host = relPath.shift())) { /* skip empty segments up to the host */ }
    relative.host = host ?? "";
    if (!truthy(relative.hostname)) relative.hostname = "";
    if (relPath[0] !== "") relPath.unshift("");
    if (relPath.length < 2) relPath.unshift("");
    result.pathname = relPath.join("/");
  } else result.pathname = relative.pathname;
  result.search = relative.search; result.query = relative.query;
  result.host = relative.host ?? "";
  result.auth = relative.auth;
  result.hostname = truthy(relative.hostname) ? relative.hostname : relative.host;
  result.port = relative.port;
  if (truthy(result.pathname) || truthy(result.search)) result.path = `${result.pathname ?? ""}${result.search ?? ""}`;
  result.slashes = result.slashes === true || relative.slashes === true ? true : result.slashes ?? relative.slashes;
  return finish(result);
}

function splitAuth(result: Url): void {
  const host = result.host;
  if (host === null || host.indexOf("@") <= 0) return;
  const parts = host.split("@");
  result.auth = parts.shift() ?? null;
  const next = parts.shift() ?? "";
  result.host = next; result.hostname = next;
}
function copy(target: Url, source: Url, except: "protocol" | null): void {
  for (const field of FIELDS) { if (field === except) continue; Reflect.set(target, field, source[field]); }
}
function finish(result: Url): Url { result.href = result.format(); return result; }
function truthy(value: string | null | undefined): value is string { return value !== null && value !== undefined && value !== ""; }
