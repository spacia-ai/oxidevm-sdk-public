import { VMError } from "../../errors.ts";
import { createNodePath } from "./node-path.ts";
import { formatLegacy, Url } from "./node-url-legacy.ts";

const NativeURL = URL;
const NativeURLSearchParams = URLSearchParams;

/** WHATWG parsing belongs to the browser. Only the Linux path/URL boundary is
 * adapted here; these operations never read files or grant network access. */
export function createNodeUrl(cwd: () => string) {
  const paths = createNodePath(cwd);
  return {
    URL: NativeURL, URLSearchParams: NativeURLSearchParams, fileURLToPath, format, Url, parse, resolve, resolveObject,
    pathToFileURL(path: unknown, options?: unknown): URL {
      posixOptions(options);
      if (typeof path !== "string") throw invalidType("path");
      let resolved = paths.resolve(path);
      if (path.endsWith("/") && !resolved.endsWith("/")) resolved += "/";
      // Encode filesystem characters that URL parsing would treat specially;
      // native URL parsing then supplies Unicode/control normalization.
      const encoded = resolved.replace(/[%\\?#\r\n\t\0 \u005B\u005D|~]/gu, character =>
        `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
      return new NativeURL(`file://${encoded}`);
    },
  };
}

export function fileURLToPath(value: unknown, options?: unknown): string {
  posixOptions(options);
  if (typeof value !== "string" && !(value instanceof NativeURL)) throw invalidType("path");
  let url: URL;
  try { url = typeof value === "string" ? new NativeURL(value) : value; }
  catch { throw Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL" }); }
  if (url.protocol !== "file:") throw Object.assign(new TypeError("URL must use the file protocol"), { code: "ERR_INVALID_URL_SCHEME" });
  if (url.hostname !== "") throw Object.assign(new TypeError("File URL host must be local"), { code: "ERR_INVALID_FILE_URL_HOST" });
  if (/%2f/iu.test(url.pathname)) throw Object.assign(new TypeError("File URL must not contain encoded slashes"), { code: "ERR_INVALID_FILE_URL_PATH" });
  return decodeURIComponent(url.pathname);
}

function posixOptions(options: unknown): void {
  const windows: unknown = typeof options === "object" && options !== null ? Reflect.get(options, "windows") : undefined;
  if (windows !== undefined && typeof windows !== "boolean") throw invalidType("options.windows");
  if (windows === true) throw new VMError("FEATURE_NOT_AVAILABLE", "Windows file URLs are not supported by the Linux profile", { api: "node:url" });
}
function invalidType(name: string): TypeError {
  return Object.assign(new TypeError(`Invalid ${name} argument`), { code: "ERR_INVALID_ARG_TYPE" });
}

/** Node's legacy `url.parse(input, parseQueryString, slashesDenoteHost)`. */
export function parse(input: unknown, parseQueryString?: unknown, slashesDenoteHost?: unknown): Url {
  if (input instanceof Url) return input;
  return new Url().parse(input, parseQueryString === true, slashesDenoteHost === true);
}
export function resolve(from: unknown, to: unknown): string { return parse(from, false, true).resolve(to); }
export function resolveObject(from: unknown, to: unknown): unknown {
  if (from === null || from === undefined || from === "") return to;
  return parse(from, false, true).resolveObject(to);
}

/** `url.format`: a WHATWG URL with Node's `auth`, `fragment`, `search` and
 * `unicode` toggles, a string re-parsed and re-assembled the legacy way, or a
 * legacy url object assembled from its components. */
export function format(input: unknown, options?: unknown): string {
  if (typeof input === "string") return parse(input).format();
  if (input instanceof URL) {
    const option = (name: string): boolean => typeof options !== "object" || options === null || Reflect.get(options, name) !== false;
    let text = `${input.protocol}${input.protocol === "" || /^[a-z][a-z0-9+.-]*:$/iu.test(input.protocol) && input.host !== "" ? "//" : ""}`;
    if (option("auth") && (input.username !== "" || input.password !== "")) text += `${input.username}${input.password === "" ? "" : `:${input.password}`}@`;
    text += input.host;
    text += input.pathname;
    if (option("search")) text += input.search;
    if (option("fragment")) text += input.hash;
    return text;
  }
  if (typeof input !== "object" || input === null) throw Object.assign(new TypeError("The \"urlObject\" argument must be one of type object or string"), { code: "ERR_INVALID_ARG_TYPE" });
  return formatLegacy(input);
}
