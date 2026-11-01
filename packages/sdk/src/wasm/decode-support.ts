import { VMError } from "../runtime/errors.js";
import { string } from "../runtime/decode.js";

/** Stable `detail.reason` for every module declaration, manifest, lock and descriptor failure. */
export const MANIFEST_INVALID = "wasm-manifest-invalid";

export function invalid(label: string, message: string): never {
  throw new VMError("INVALID_ARGUMENT", `${label}: ${message}`, { reason: MANIFEST_INVALID });
}

/** Runs a decoder and reports every decode failure as INVALID_ARGUMENT with a stable reason. */
export function decoding<T>(label: string, run: () => T): T {
  try {
    return run();
  } catch (error: unknown) {
    if (error instanceof VMError && (error.code === "PROTOCOL_ERROR" || error.code === "INVALID_ARGUMENT" && error.detail?.["reason"] !== MANIFEST_INVALID)) {
      throw new VMError("INVALID_ARGUMENT", `${label}: ${error.message}`, { ...error.detail, reason: MANIFEST_INVALID });
    }
    throw error;
  }
}

export function text(value: unknown, label: string, pattern: RegExp, maximum = 256): string {
  const result = string(value, label);
  if (result.length === 0 || result.length > maximum || result.includes("\0") || !pattern.test(result)) {
    return invalid(label, "has an unsupported format");
  }
  return result;
}

/** Control, format (bidi, zero-width, tag, byte order mark) and line or paragraph separator characters. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Rejects those characters anywhere in a decoded document, keys included. They have no place in a manifest or a lock and
 * only serve to change what a person is shown: an escape sequence can repaint the consent card, a bidi override can
 * reverse a path, a zero-width character can make two names look alike.
 */
export function plainStrings(value: unknown, label: string, depth = 0): void {
  if (typeof value === "string") {
    if (INVISIBLE.test(value)) invalid(label, "contains a control or invisible character");
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (depth > 16) return invalid(label, "is nested too deeply");
  for (const [key, item] of Object.entries(value)) {
    if (INVISIBLE.test(key)) invalid(label, "contains a control or invisible character in a name");
    plainStrings(item, label, depth + 1);
  }
}

export function list(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid(label, `must be an array of at most ${String(maximum)} entries`);
  return Array.from<unknown>(value);
}

export function choice<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  const found = allowed.find(item => item === value);
  return found ?? invalid(label, `must be one of ${allowed.join(", ")}`);
}

export function integerIn(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return invalid(label, `must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return value;
}

export function unique(items: readonly string[], label: string): void {
  if (new Set(items).size !== items.length) invalid(label, "contains duplicates");
}

interface PathRules {
  /** The path must equal one of these directories (when `self`) or lie strictly below one. */
  readonly under?: readonly string[];
  readonly self?: boolean;
  readonly maxBytes?: number;
}

const encoder = new TextEncoder();

export function absolutePath(value: unknown, label: string, rules: PathRules = {}): string {
  const path = string(value, label);
  const segments = path.split("/");
  const bounded = encoder.encode(path).length <= (rules.maxBytes ?? 4096);
  if (!path.startsWith("/") || path.includes("\0") || !bounded) return invalid(label, "must be a bounded absolute path");
  const inner = segments.slice(1);
  if (path !== "/" && inner.some(part => part === "" || part === "." || part === "..")) return invalid(label, "must be normalized");
  if (rules.under === undefined) return path;
  const allowed = rules.under.some(root => path.startsWith(`${root}/`) || rules.self === true && path === root);
  return allowed ? path : invalid(label, `must be inside ${rules.under.join(" or ")}`);
}

/** A repository-relative POSIX path: no leading slash, no dot segments. */
export function relativePath(value: unknown, label: string): string {
  const path = string(value, label);
  const parts = path.split("/");
  if (path.length === 0 || path.length > 512 || path.includes("\0") || path.startsWith("/") || path.includes("\\") || parts.some(part => part === "" || part === "." || part === "..")) {
    return invalid(label, "must be a normalized relative path");
  }
  return path;
}

export function httpsURL(value: unknown, label: string): string {
  const input = string(value, label);
  let url: URL;
  try { url = new URL(input); } catch { return invalid(label, "must be an https URL"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || input.length > 512) return invalid(label, "must be an https URL without credentials");
  return input;
}

/** An absolute http(s) URL without credentials: where the page serves a pinned file from. */
export function httpURL(value: unknown, label: string): string {
  const input = string(value, label);
  let url: URL;
  try { url = new URL(input); } catch { return invalid(label, "must be an absolute http or https URL"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || input.length > 2048) return invalid(label, "must be an absolute http or https URL without credentials");
  return input;
}

const MAX_DATA_URL = 256 * 1024;
/**
 * Where the page serves a pinned file from: an http(s) URL, or a data URL, which is what a bundler turns a small file
 * into when it inlines it. The scheme does not matter for safety: the bytes are checked against their sha256 either way.
 */
export function pinURL(value: unknown, label: string): string {
  const input = string(value, label);
  if (!input.startsWith("data:")) return httpURL(value, label);
  if (input.length > MAX_DATA_URL || !/^data:[a-z0-9.+/-]*(?:;[a-z0-9=.+-]+)*,/iu.test(input)) return invalid(label, "must be a bounded data URL");
  return input;
}

/** Canonical form: two-space JSON followed by exactly one newline. */
export function canonicalBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/**
 * The text of a JSON document, after checking that no object names a key twice. JSON.parse keeps the last of two equal
 * keys, so a reviewer who reads the first and a tool that reads the last would disagree about the same file. The text has
 * already parsed, so it is well formed and only the keys need walking; two spellings of one key (`"a"` and `"\u0061"`) are
 * one key, which is how JSON.parse reads them.
 */
function rejectRepeatedKeys(json: string, label: string): void {
  const objects: (Set<string> | undefined)[] = []; // one entry per open container; undefined marks an array
  let expectKey = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json.charAt(index);
    if (char === "{") { objects.push(new Set()); expectKey = true; }
    else if (char === "[") { objects.push(undefined); expectKey = false; }
    else if (char === "}" || char === "]") { objects.pop(); expectKey = false; }
    else if (char === ",") expectKey = true; // a string after a comma is a key only when the container is an object, which `keys` checks
    else if (char === "\"") {
      let end = index + 1;
      while (end < json.length && json.charAt(end) !== "\"") end += json.charAt(end) === "\\" ? 2 : 1;
      if (end >= json.length) return invalid(label, "is not UTF-8 JSON");
      const keys = objects.at(-1);
      if (expectKey && keys !== undefined) {
        const key: unknown = JSON.parse(json.slice(index, end + 1));
        if (typeof key !== "string") return invalid(label, "is not UTF-8 JSON");
        if (keys.has(key)) return invalid(label, `names the key ${JSON.stringify(key)} more than once in one object`);
        keys.add(key);
      }
      expectKey = false;
      index = end;
    }
  }
}

export function parseJSON(bytes: Uint8Array, label: string, maximum: number): unknown {
  if (bytes.byteLength > maximum) return invalid(label, `exceeds ${String(maximum)} bytes`);
  let json: string, parsed: unknown;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(json);
  } catch {
    return invalid(label, "is not UTF-8 JSON");
  }
  rejectRepeatedKeys(json, label);
  return parsed;
}

/** Order by UTF-16 code unit. Unlike `localeCompare` this gives every machine the same bytes, and the files are committed. */
export function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// GitHub names. The repository part excludes `.` and `..`, which would walk out of the API path repos/<owner>/<repo>.
const OWNER_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPO_PATTERN = "(?!\\.{1,2}$)[A-Za-z0-9._-]{1,100}";
export const GITHUB_OWNER = new RegExp(`^${OWNER_PATTERN}$`, "u");
export const GITHUB_REPO = new RegExp(`^${REPO_PATTERN}$`, "u");
export const GITHUB_REPOSITORY = new RegExp(`^${OWNER_PATTERN}/${REPO_PATTERN}$`, "u");
export const GITHUB_OWNER_OR_REPOSITORY = new RegExp(`^${OWNER_PATTERN}(?:/${REPO_PATTERN})?$`, "u");
