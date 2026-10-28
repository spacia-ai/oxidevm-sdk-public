import { VMError } from "../../errors.ts";
import { createNodeBase64 } from "./node-base64.js";

/** The `buffer` builtin: the Buffer implementation plus Node's other exports,
 * the platform's Blob and File, base64 helpers and the encoding probes. */
export function createNodeBuffer(globals: unknown, buffer: object, runtime: "node" | "bun" = "node") {
  if (typeof globals !== "object" || globals === null) throw new VMError("FEATURE_NOT_AVAILABLE", "buffer requires the platform's global scope");
  const prototype: unknown = Reflect.get(buffer, "prototype");
  if (typeof prototype === "object" && prototype !== null) base64url(buffer, prototype);
  for (const [name, encoding] of [["latin1Slice", "latin1"], ["utf8Slice", "utf8"], ["ucs2Slice", "ucs2"], ["base64Slice", "base64"]] as const) {
    if (typeof prototype === "object" && prototype !== null && Reflect.get(prototype, name) === undefined) Object.defineProperty(prototype, name, { configurable: true, writable: true,
      value(this: { toString(encoding: string, start?: number, end?: number): string }, start?: number, end?: number): string { return this.toString(encoding, start, end); } });
  }
  const platform = (name: string): unknown => {
    const value: unknown = Reflect.get(globals, name);
    if (typeof value !== "function") throw new VMError("FEATURE_NOT_AVAILABLE", `buffer is unavailable: the platform lacks ${name}`, { builtin: "buffer", missing: name });
    return value;
  };
  const number = (value: unknown): number | undefined => typeof value === "number" ? value : undefined;
  const constants: unknown = Reflect.get(buffer, "constants");
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const bytes = (value: unknown): Uint8Array => {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw Object.assign(new TypeError("The \"input\" argument must be an instance of ArrayBuffer, Buffer, or TypedArray"), { code: "ERR_INVALID_ARG_TYPE" });
  };
  const kMaxLength = number(Reflect.get(buffer, "kMaxLength")) ?? (typeof constants === "object" && constants !== null ? number(Reflect.get(constants, "MAX_LENGTH")) : undefined) ?? 0x1fffffe8;
  const maxString = (typeof constants === "object" && constants !== null ? number(Reflect.get(constants, "MAX_STRING_LENGTH")) : undefined) ?? 0x1fffffe8;
  const base64 = createNodeBase64(globals, runtime);
  return Object.freeze({
    Buffer: buffer, SlowBuffer: buffer, Blob: platform("Blob"), File: platform("File"),
    btoa: base64.btoa, atob: base64.atob,
    isUtf8: (value: unknown): boolean => { try { utf8.decode(bytes(value)); return true; } catch { return false; } },
    isAscii: (value: unknown): boolean => bytes(value).every(byte => byte < 0x80),
    kMaxLength, kStringMaxLength: maxString, INSPECT_MAX_BYTES: 50,
    constants: Object.freeze({ MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: maxString }),
    transcode: (): never => { throw new VMError("FEATURE_NOT_AVAILABLE", "buffer.transcode is not supported", { builtin: "buffer", export: "transcode" }); },
  });
}

function base64url(buffer: object, prototype: object): void {
  const probe: unknown = Reflect.get(buffer, "isEncoding"), stringify: unknown = Reflect.get(prototype, "toString");
  if (typeof probe !== "function" || typeof stringify !== "function") throw new TypeError("Invalid Buffer implementation");
  if (Reflect.apply(probe, buffer, ["base64url"]) === true) return;
  const selected = (value: unknown): boolean => typeof value === "string" && value.toLowerCase() === "base64url";
  Object.defineProperty(prototype, "toString", { configurable: true, writable: true, value(this: unknown, ...args: unknown[]): unknown {
    const url = selected(args[0]); if (url) args[0] = "base64";
    const result: unknown = Reflect.apply(stringify, this, args);
    if (!url) return result;
    if (typeof result !== "string") throw new TypeError("Invalid Buffer string result");
    return result.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  } });
  const alias = (target: object, name: string, index?: number): void => {
    const original: unknown = Reflect.get(target, name);
    if (typeof original !== "function") throw new TypeError(`Missing Buffer ${name}`);
    Object.defineProperty(target, name, { configurable: true, writable: true, value(this: unknown, ...args: unknown[]): unknown {
      const encoding = index ?? Math.max(1, args.length - 1);
      if (selected(args[encoding])) args[encoding] = "base64";
      return Reflect.apply(original, this, args);
    } });
  };
  alias(buffer, "from", 1); alias(buffer, "byteLength", 1); alias(buffer, "alloc", 2);
  for (const name of ["write", "fill", "indexOf", "lastIndexOf", "includes"]) alias(prototype, name);
  Object.defineProperty(buffer, "isEncoding", { configurable: true, writable: true,
    value: (encoding: unknown): boolean => selected(encoding) || Reflect.apply(probe, buffer, [encoding]) === true });
  // shortcut: deprecated Buffer(...) construction is unqualified; add native parity before admitting a workload that uses it.
}
