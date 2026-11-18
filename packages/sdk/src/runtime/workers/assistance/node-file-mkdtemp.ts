import { Buffer } from "buffer";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { invalidArgType, type Inspect } from "./node-arg-type.js";
import { nodeResult, type FileOperation } from "./node-file-operations.js";
import { fileURLToPath } from "./node-url.js";
import { unavailableNodeApi } from "./node-capability.js";

/** musl's `mkdtemp(3)`, which Node 24 on Alpine calls through libuv: a directory of mode 0700 named by the prefix and
 * six letters, each `'A' + (r & 15) + (r & 16) * 2` for five bits of `r` (A to P, a to p), retried up to 100 times
 * while the name exists. musl seeds `r` from the clock and thread; this takes it from the browser's random source.
 * Failures name the template, as Node reports it: the prefix and `XXXXXX`. */
export function* mkdtemp(prefix: unknown, options: unknown, inspect: Inspect, random: () => number = randomWord): FileOperation<string | Buffer> {
  const encoding = encodingOf(options, inspect);
  const base = prefixPath(prefix, inspect);
  const template = `${base}XXXXXX`;
  let result: AssistanceResult | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const path = base + name(random());
    result = yield { kind: "mkdir", path, mode: 0o700 };
    if (result.kind === "unit") return encoding === "buffer" ? Buffer.from(path) : Buffer.from(path).toString(encoding.name);
    if (result.kind !== "error" || result.code !== "EEXIST") break;
  }
  if (result === undefined || result.kind !== "error") throw new TypeError("Linux returned a non-directory result for mkdir");
  return nodeResult({ ...result, syscall: "mkdtemp", path: template, destination: null });
}

function name(seed: number): string {
  let r = seed >>> 0, text = "";
  for (let index = 0; index < 6; index += 1, r >>>= 5) text += String.fromCharCode(65 + (r & 15) + (r & 16) * 2);
  return text;
}
function randomWord(): number { return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0; }

/** The names `Buffer.isEncoding` accepts, in any letter case. */
const ENCODINGS = ["utf8", "utf-8", "hex", "base64", "base64url", "ascii", "latin1", "binary", "ucs2", "ucs-2", "utf16le", "utf-16le"] as const;
type Encoding = (typeof ENCODINGS)[number];

/** Node's `getOptions` for mkdtemp: an encoding name, or an object whose `encoding` names one. */
function encodingOf(options: unknown, inspect: Inspect): { readonly name: Encoding } | "buffer" {
  const selected: unknown = typeof options === "string" ? options
    : typeof options === "object" && options !== null ? Reflect.get(options, "encoding") ?? "utf8" : options ?? "utf8";
  if (typeof options !== "string" && options !== undefined && options !== null && typeof options !== "object") {
    throw invalidArgType("options", "string or an instance of Object", options, inspect);
  }
  if (selected === "buffer") return "buffer";
  const name = typeof selected === "string" ? ENCODINGS.find(encoding => encoding === selected.toLowerCase()) : undefined;
  if (name !== undefined) return { name };
  throw Object.assign(new TypeError(`The argument 'encoding' is invalid encoding. Received ${inspect(selected, { depth: -1 })}`), { code: "ERR_INVALID_ARG_VALUE" });
}

/** Node's `getValidatedPath(prefix, "prefix")`. The layer's paths are strings, so a Buffer prefix must be UTF-8. */
function prefixPath(prefix: unknown, inspect: Inspect): string {
  let path: string;
  if (typeof prefix === "string") path = prefix;
  else if (prefix instanceof URL) path = fileURLToPath(prefix);
  else if (prefix instanceof Uint8Array) {
    const text = Buffer.from(prefix).toString("utf8");
    if (!Buffer.from(text).equals(prefix)) unavailableNodeApi("fs.mkdtemp with a non-UTF-8 Buffer prefix");
    path = text;
  } else throw invalidArgType("prefix", "string or an instance of Buffer or URL", prefix, inspect);
  if (path.includes("\0")) {
    throw Object.assign(new TypeError(`The argument 'prefix' must be a string, Uint8Array, or URL without null bytes. Received ${inspect(prefix, { depth: -1 })}`), { code: "ERR_INVALID_ARG_VALUE" });
  }
  return path;
}
