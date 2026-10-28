import { protocol } from "../../js-process/codec.js";
import { NapiFailure } from "./errors.js";

const NativeDate = Date, DataView = globalThis.DataView, ArrayBuffer = globalThis.ArrayBuffer, Uint8Array = globalThis.Uint8Array, apply = Reflect.apply;
const getTime: unknown = Reflect.get(Date.prototype, "getTime");
const integer = BigInt, signed64 = BigInt.asIntN.bind(BigInt), unsigned64 = BigInt.asUintN.bind(BigInt);
const integerText: unknown = Reflect.get(BigInt.prototype, "toString"), pad: unknown = Reflect.get(String.prototype, "padStart");
const slice: unknown = Reflect.get(String.prototype, "slice"), join: unknown = Reflect.get(Array.prototype, "join");
const ceil = Math.ceil, min = Math.min, max = Math.max;
const arrayFrom = Array.from;
const view = new DataView(new ArrayBuffer(0)), getInteger = Reflect.get(view, "getBigUint64"), setInteger = Reflect.get(view, "setBigUint64"), getDouble = Reflect.get(view, "getFloat64"), setDouble = Reflect.get(view, "setFloat64");
function text(method: unknown, receiver: unknown, args: readonly unknown[]): string {
  if (typeof method !== "function") protocol("Native BigInt conversion intrinsic is unavailable");
  const result: unknown = apply(method, receiver, args);
  if (typeof result !== "string") protocol("Invalid native BigInt conversion result");
  return result;
}
export function nativeBigInt(value: unknown): bigint { if (typeof value !== "bigint") throw new NapiFailure(17); return value; }
export function nativeSignedInteger(value: bigint, bits: 32 | 64 = 64): bigint { return signed64(bits, value); }
export function nativeUnsignedInteger(value: bigint): bigint { return unsigned64(64, value); }
export function nativeBigInt64(value: unknown, signed: boolean): readonly [bigint, bigint] {
  const input = nativeBigInt(value), result = signed ? signed64(64, input) : unsigned64(64, input);
  return [unsigned64(64, result), result === input ? 1n : 0n];
}
export function nativeBigIntFromWords(sign: number, bytes: Uint8Array): bigint {
  if (bytes.length % 8 !== 0) protocol("Invalid native BigInt word payload");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), arrayLike = { __proto__: null, length: bytes.length / 8 };
  const words = arrayFrom(arrayLike, (_value, index) => {
    const offset = bytes.length - 8 - index * 8;
    return text(pad, text(integerText, apply(getInteger, view, [offset, true]), [16]), [16, "0"]);
  });
  const result = integer(`0x${text(join, words, [""]) || "0"}`); return (sign & 1) === 0 ? result : -result;
}
export function nativeBigIntWords(value: unknown, capacity: number): { readonly args: readonly bigint[]; readonly bytes: Uint8Array } {
  const input = nativeBigInt(value), magnitude = input < 0n ? -input : input, hex = text(integerText, magnitude, [16]);
  const count = magnitude === 0n ? 0 : ceil(hex.length / 16), copied = min(count, capacity);
  const bytes = new Uint8Array(copied * 8), view = new DataView(bytes.buffer);
  for (let index = 0; index < copied; index++) {
    const end = hex.length - index * 16;
    apply(setInteger, view, [index * 8, integer(`0x${text(slice, hex, [max(0, end - 16), end])}`), true]);
  }
  return { args: [input < 0n ? 1n : 0n, integer(count)], bytes };
}
export function nativeDoubleBits(value: number): bigint { const view = new DataView(new ArrayBuffer(8)); apply(setDouble, view, [0, value, true]); return apply(getInteger, view, [0, true]); }
export function nativeDouble(bits: bigint): number { const view = new DataView(new ArrayBuffer(8)); apply(setInteger, view, [0, bits, true]); return apply(getDouble, view, [0, true]); }
export function nativeDate(bits: bigint): Date { return new NativeDate(nativeDouble(bits)); }
export function nativeDateTime(value: unknown): number {
  if (typeof getTime !== "function") protocol("Native Date intrinsic is unavailable");
  let time: unknown;
  try { time = apply(getTime, value, []); }
  // The captured intrinsic throws only for a receiver without [[DateValue]].
  catch { throw new NapiFailure(18); }
  if (typeof time !== "number") protocol("Invalid native Date value");
  return time;
}
export function nativeIsDate(value: unknown): boolean {
  try { nativeDateTime(value); return true; } catch (error) { if (NapiFailure.is(error)) return false; throw error; }
}
