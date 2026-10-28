import { Buffer } from "buffer";

const encode = encodeURIComponent;
const decode = decodeURIComponent;

function text(value: unknown): string {
  if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
  return String(value);
}
function property(value: unknown, key: string): unknown {
  return ((typeof value === "object" && value !== null) || typeof value === "function") ? Reflect.get(value, key) : undefined;
}
function primitive(value: unknown): string {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "bigint"
    || (typeof value === "number" && Number.isFinite(value)) ? text(value) : "";
}
function escape(value: unknown): string { return encode(text(value)); }

/** Node's forgiving fallback preserves invalid escapes and decodes the bytes
 * with the existing Buffer implementation; valid UTF-8 uses the native decoder. */
function unescapeBuffer(value: string, decodeSpaces = false): Buffer {
  const bytes = Buffer.allocUnsafe(value.length);
  let size = 0;
  for (let offset = 0; offset < value.length; offset++) {
    const character = value.charCodeAt(offset);
    if (character === 37 && /^[\da-f]{2}$/iu.test(value.slice(offset + 1, offset + 3))) {
      bytes[size++] = Number.parseInt(value.slice(offset + 1, offset + 3), 16); offset += 2;
    } else bytes[size++] = character === 43 && decodeSpaces ? 32 : character;
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, size);
}
function unescape(value: string, decodeSpaces = false): string {
  try { return decode(value); }
  catch { return unescapeBuffer(value, decodeSpaces).toString("utf8"); }
}
function parse(value: unknown, separator = "&", equals = "=", options?: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  Object.setPrototypeOf(result, null);
  if (typeof value !== "string" || value.length === 0) return result;
  const limit = property(options, "maxKeys");
  let remaining = typeof limit === "number" ? (limit > 0 ? limit : -1) : 1000;
  const custom = property(options, "decodeURIComponent");
  function component(part: string): unknown {
    const escaped = part.replace(/\+/gu, typeof custom === "function" ? "%20" : " ");
    if (typeof custom === "function") {
      try { return Reflect.apply(custom, undefined, [escaped]); }
      catch { /* Invalid custom decoding uses Node's forgiving fallback. */ }
    }
    return typeof custom !== "function" && !/%[\da-f]{2}/iu.test(escaped) ? escaped : unescape(escaped, true);
  }
  for (const part of value.split(separator || "&")) {
    if (part !== "") {
      const delimiter = equals || "=";
      const index = part.indexOf(delimiter);
      const key = text(component(index === -1 ? part : part.slice(0, index)));
      const decoded = component(index === -1 ? "" : part.slice(index + delimiter.length));
      if (!Object.hasOwn(result, key)) result[key] = decoded;
      else {
        const previous = result[key];
        if (Array.isArray(previous)) { const values: unknown[] = previous; values.push(decoded); }
        else result[key] = [previous, decoded];
      }
    }
    if (--remaining === 0) break;
  }
  return result;
}
function stringify(value: unknown, separator = "&", equals = "=", options?: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const custom = property(options, "encodeURIComponent");
  const component = (value: string): string => typeof custom === "function" ? text(Reflect.apply(custom, undefined, [value])) : escape(value);
  const pairs: string[] = [];
  for (const key of Object.keys(value)) {
    const field: unknown = Reflect.get(value, key);
    const values: readonly unknown[] = Array.isArray(field) ? field : [field];
    const prefix = component(key) + (equals || "=");
    for (const item of values) pairs.push(prefix + component(primitive(item)));
  }
  return pairs.join(separator || "&");
}

export const nodeQuerystring = { parse, decode: parse, stringify, encode: stringify, escape, unescape, unescapeBuffer };
