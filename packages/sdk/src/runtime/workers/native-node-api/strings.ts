import { protocol } from "../../js-process/codec.js";
import { NapiFailure } from "./errors.js";

export type NativeStringEncoding = "utf8" | "latin1" | "utf16";
const Uint8Array = globalThis.Uint8Array;
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true }), encoder = new TextEncoder();
const metadata = new TextDecoder("utf-8", { fatal: true });
const encodeUtf8 = encoder.encode.bind(encoder), decodeUtf8 = utf8.decode.bind(utf8), decodeMetadata = metadata.decode.bind(metadata);
const fromCharCode = String.fromCharCode, apply = Reflect.apply;
const min = Math.min, appendUnit = Array<number>().push;
const queryInteger = BigInt;
const charCodeAt: unknown = Reflect.get(String.prototype, "charCodeAt");
function codeUnit(value: string, index: number): number {
  if (typeof charCodeAt !== "function") protocol("Native string intrinsic is unavailable");
  const unit: unknown = apply(charCodeAt, value, [index]);
  if (typeof unit !== "number") protocol("Invalid native string code unit");
  return unit;
}
export function decodeNativeString(bytes: Uint8Array, encoding: NativeStringEncoding): string {
  if (encoding === "utf8") return decodeUtf8(bytes);
  const width = encoding === "utf16" ? 2 : 1;
  if (bytes.length % width !== 0) protocol("Invalid UTF-16 byte length");
  let text = "";
  for (let start = 0; start < bytes.length; start += 8192 * width) {
    const units: number[] = [], end = min(start + 8192 * width, bytes.length);
    for (let index = start; index < end; index += width) apply(appendUnit, units, [(bytes[index] ?? 0) | (width === 2 ? (bytes[index + 1] ?? 0) << 8 : 0)]);
    text += fromCharCode(...units);
  }
  return text;
}
export function encodeNativeString(value: unknown, encoding: NativeStringEncoding): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string") throw new NapiFailure(3);
  if (encoding === "utf8") return encodeUtf8(value);
  const width = encoding === "utf16" ? 2 : 1, bytes = new Uint8Array(value.length * width);
  for (let index = 0; index < value.length; index++) {
    const unit = codeUnit(value, index);
    bytes[index * width] = unit & 255;
    if (width === 2) bytes[index * width + 1] = unit >>> 8;
  }
  return bytes;
}

export function decodeNativeMetadata(bytes: Uint8Array): string { return decodeMetadata(bytes); }

/** Pinned Bun separates its SIMD length query from its validated UTF8 copy. */
export function readNativeUtf8(value: unknown, query: boolean, runtime: "node" | "bun"): { readonly args: readonly bigint[]; readonly bytes: Uint8Array } {
  if (typeof value !== "string") throw new NapiFailure(3);
  if (query) {
    let length = 0;
    if (runtime === "node") length = encodeNativeString(value, "utf8").byteLength;
    else for (let index = 0; index < value.length; index++) {
      const unit = codeUnit(value, index);
      length += unit < 0x80 ? 1 : unit < 0x800 ? 2 : (unit & 0xf800) === 0xd800 ? 2 : 3;
    }
    return { args: [queryInteger(length)], bytes: new Uint8Array() };
  }
  if (runtime === "bun" && value.length === 1) {
    const unit = codeUnit(value, 0);
    // Pinned Bun returns before copying when SIMD trimming removes the sole high surrogate.
    if (unit >= 0xd800 && unit <= 0xdbff) return { args: [], bytes: new Uint8Array() };
  }
  return { args: [], bytes: encodeNativeString(value, "utf8") };
}
