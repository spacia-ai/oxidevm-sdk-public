import { integer } from "../../decode.js";
import { Reader, Writer, protocol, writeBytes } from "../../js-process/codec.js";
import { nativeStatus } from "./errors.js";
import { decodeNativeMetadata, encodeNativeString } from "./strings.js";

const arrayFrom = Array.from;
const BigInt = globalThis.BigInt, Uint8Array = globalThis.Uint8Array;
export const NATIVE_MAX_FRAME = 128 * 1024 * 1024 + 64 * 1024;
export const NATIVE_FRAME_VERSION = 15;
export interface NativeFrame { readonly kind: number; readonly sequence: number; readonly scope: bigint; readonly environment: bigint; readonly operation: string; readonly status: number; readonly args: readonly bigint[]; readonly bytes: Uint8Array }
function validate(frame: NativeFrame): void {
  integer(frame.kind, "native frame kind", 1, 8); integer(frame.sequence, "native frame identity", 1, 0xffff_ffff);
  nativeStatus(frame.status);
  if (frame.environment < 0n || frame.environment > 0x7fff_ffff_ffff_ffffn || ((frame.kind !== 3 && frame.kind !== 4) && frame.environment !== 0n)) protocol("Invalid native module environment");
  if (frame.scope <= 0n || frame.scope > 0x1_ffff_ffffn || (frame.kind <= 2 && frame.scope !== BigInt(frame.sequence)) || (frame.kind >= 5 && frame.scope !== 0x1_0000_0000n + BigInt(frame.sequence))) protocol("Invalid native handle scope");
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(frame.operation) || frame.args.length > 4096 || frame.bytes.byteLength > NATIVE_MAX_FRAME) protocol("Invalid native frame fields");
}
export function encodeNativeFrame(frame: NativeFrame): Uint8Array<ArrayBuffer> {
  validate(frame);
  const writer = new Writer().u32(0x414e584f).u32(NATIVE_FRAME_VERSION).u32(frame.kind).u32(frame.sequence).u64(frame.scope).u64(frame.environment).blob(encodeNativeString(frame.operation, "utf8")).u32(frame.status).u32(frame.args.length);
  for (const value of frame.args) writer.u64(value);
  const header = writer.u32(frame.bytes.byteLength).finish(), length = header.byteLength + frame.bytes.byteLength;
  if (length > NATIVE_MAX_FRAME) protocol("Native frame exceeds its byte limit");
  const result = new Uint8Array(4 + length);
  writeBytes(result, new Writer().u32(length).finish());
  writeBytes(result, header, 4); writeBytes(result, frame.bytes, 4 + header.byteLength);
  return result;
}
export function decodeNativeFrame(bytes: Uint8Array): NativeFrame {
  return decodeFrame(bytes, NATIVE_FRAME_VERSION);
}
/** Historical evidence decoding never negotiates a live transport version. */
export function decodeCapturedNativeFrame(bytes: Uint8Array, version: 13 | 14 | 15): NativeFrame {
  return decodeFrame(bytes, version);
}
function decodeFrame(bytes: Uint8Array, version: 13 | 14 | 15): NativeFrame {
  if (bytes.byteLength < 48 || bytes.byteLength > NATIVE_MAX_FRAME) protocol("Invalid native frame length");
  const reader = new Reader(bytes);
  if (reader.u32() !== 0x414e584f || reader.u32() !== version) protocol("Native frame version mismatch");
  const kind = reader.u32(), sequence = reader.u32(), scope = reader.u64(), environment = reader.u64(), operation = decodeNativeMetadata(reader.blob(64)), status = reader.u32(), count = integer(reader.u32(), "native argument count", 0, 4096);
  const arrayLike = { __proto__: null, length: count };
  const args = arrayFrom(arrayLike, () => reader.u64()), payload = reader.blob(NATIVE_MAX_FRAME); reader.end();
  const frame = { kind, sequence, scope, environment, operation, status, args, bytes: payload }; validate(frame); return frame;
}
