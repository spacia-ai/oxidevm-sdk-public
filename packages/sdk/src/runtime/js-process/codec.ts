import { VMError } from "../errors.ts";
import { integer } from "../decode.ts";
import type { FileDescriptor, LinuxPath } from "../../js-process-types.js";
import type { AttentionCounter } from "../host-attention.js";

const Number = globalThis.Number, BigInt = globalThis.BigInt, DataView = globalThis.DataView, Uint8Array = globalThis.Uint8Array;
const apply = Reflect.apply, appendPart = Array<Uint8Array>().push, isSafeInteger = Number.isSafeInteger;
const bytes = new Uint8Array<ArrayBufferLike>(new ArrayBuffer(0));
const byteSet = Reflect.get(bytes, "set"), byteSubarray = Reflect.get(bytes, "subarray"), byteSlice = Reflect.get(bytes, "slice");
const viewMethods = Object.getOwnPropertyDescriptors(DataView.prototype);
const getUint16 = viewMethods.getUint16.value ?? protocol("Binary u16 reader is unavailable");
const getUint32 = viewMethods.getUint32.value ?? protocol("Binary u32 reader is unavailable");
const getBigUint64 = viewMethods.getBigUint64.value ?? protocol("Binary u64 reader is unavailable");
const setUint32 = viewMethods.setUint32.value ?? protocol("Binary u32 writer is unavailable");
const setBigUint64 = viewMethods.setBigUint64.value ?? protocol("Binary u64 writer is unavailable");

/** The JS process transport: the `start` bootstrap, Linux requests and replies, and the worker's exit
 * or failure. Version 2 counts every posted request in the mailbox (`jsMailboxAttention`), so the
 * execution worker ends a guest slice to receive it; version 1 workers never counted and are rejected.
 * Version 3 adds `late-failure`, which a process posts before it exits on an uncaught fast-path
 * limitation (ADR 0026). */
export const JS_PROCESS_PROTOCOL_VERSION = 3;
/** The native execution broker's per-process channel: `spawn`, `start` and `stop` in, `error` and
 * `message` out. Version 2 adds `start.attention`, the port that receives one notice per Linux
 * request the broker forwards to the execution worker (`workers/attention-notices.ts`). */
export const NATIVE_BROKER_PROCESS_VERSION = 2;
export const JS_MAILBOX_BYTES = 16 * 1024 ** 2 + 4096;
export const JS_MAX_IO_BYTES = 16 * 1024 ** 2;
export const JS_MAX_OPERATION = 65549;
/** The mailbox header is four Int32s: reply state, reply length and reply sequence, then the count of
 * requests the worker posted, which the execution worker compares with the requests it received. */
export function jsMailboxAttention(mailbox: SharedArrayBuffer): AttentionCounter {
  return new Int32Array(mailbox, 3 * Int32Array.BYTES_PER_ELEMENT, 1);
}
export function writeBytes(target: Uint8Array, source: ArrayLike<number>, offset = 0): void { apply(byteSet, target, [source, offset]); }
export function viewBytes(target: Uint8Array, begin: number, end?: number): Uint8Array { return apply(byteSubarray, target, [begin, end]); }
export function copyBytes(target: Uint8Array, begin = 0, end?: number): Uint8Array<ArrayBuffer> { return apply(byteSlice, target, [begin, end]); }
export interface LinuxResult { readonly value: bigint; readonly bytes: Uint8Array }
declare const generationBrand: unique symbol;
declare const incarnationBrand: unique symbol;
export type JSGeneration = bigint & { readonly [generationBrand]: "JSGeneration" };
export type JSIncarnationId = bigint & { readonly [incarnationBrand]: "JSIncarnation" };
export interface JSProcessIdentity { readonly generation: JSGeneration; readonly id: JSIncarnationId }
export function decodeJSIdentity(generation: unknown, id: unknown): JSProcessIdentity {
  if (!isGeneration(generation) || !isIncarnation(id)) protocol("Invalid JS process incarnation");
  return { generation, id };
}
function isGeneration(value: unknown): value is JSGeneration { return typeof value === "bigint" && value > 0n && value <= 0xffff_ffff_ffff_ffffn; }
function isIncarnation(value: unknown): value is JSIncarnationId { return typeof value === "bigint" && value > 0n && value <= 0xffff_ffff_ffff_ffffn; }

export class LinuxError extends Error {
  readonly errno: number;
  constructor(errno: number) {
    super(`Linux operation failed with errno ${integer(errno, "Linux errno", 1, 4095)}`);
    this.name = "LinuxError"; this.errno = errno;
  }
}
export function protocol(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }
export function descriptor(value: unknown): FileDescriptor {
  if (!isDescriptor(value)) protocol("Invalid Linux file descriptor");
  return value;
}
function isDescriptor(value: unknown): value is FileDescriptor { return typeof value === "number" && isSafeInteger(value) && value >= 0 && value <= 0x7fff_ffff; }

export class Writer {
  readonly #parts: Uint8Array[] = [];
  #length = 0;
  raw(bytes: Uint8Array): this {
    if (this.#length + bytes.byteLength > JS_MAILBOX_BYTES - 64) protocol("Linux request exceeds its byte limit");
    apply(appendPart, this.#parts, [bytes]); this.#length += bytes.byteLength; return this;
  }
  u8(value: number): this { return this.raw(Uint8Array.of(integer(value, "u8", 0, 255))); }
  u32(value: number): this { const b = new Uint8Array(4); apply(setUint32, new DataView(b.buffer), [0, integer(value, "u32", 0, 0xffff_ffff), true]); return this.raw(b); }
  u64(value: bigint | number): this {
    if (typeof value === "number") integer(value, "u64", 0);
    const big = BigInt(value); if (big < 0n || big > 0xffff_ffff_ffff_ffffn) protocol("u64 is out of range");
    const b = new Uint8Array(8); apply(setBigUint64, new DataView(b.buffer), [0, big, true]); return this.raw(b);
  }
  blob(bytes: Uint8Array): this { return this.u32(bytes.byteLength).raw(bytes); }
  path(path: LinuxPath): this {
    const bytes = typeof path === "string" ? new TextEncoder().encode(path) : path;
    if (bytes.byteLength >= 4096 || bytes.includes(0)) throw new VMError("INVALID_ARGUMENT", "Linux path exceeds 4095 bytes or contains NUL");
    return this.blob(bytes);
  }
  strings(values: readonly string[]): this {
    if (values.length > 4096) protocol("Linux argument count exceeds 4096");
    this.u32(values.length);
    for (const value of values) { if (value.includes("\0")) protocol("Linux argument contains NUL"); this.blob(new TextEncoder().encode(value)); }
    return this;
  }
  finish(): Uint8Array<ArrayBuffer> { const bytes = new Uint8Array(this.#length); let offset = 0; for (const part of this.#parts) { writeBytes(bytes, part, offset); offset += part.byteLength; } return bytes; }
}
export class Reader {
  readonly #view: DataView;
  #offset = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  raw(length: number): Uint8Array { integer(length, "record length", 0); const end = this.#offset + length; if (end > this.bytes.byteLength) protocol("Truncated Linux record"); const result = viewBytes(this.bytes, this.#offset, end); this.#offset = end; return result; }
  u8(): number { return this.raw(1)[0] ?? protocol("Truncated u8"); }
  u16(): number { const offset = this.#offset; this.raw(2); return apply(getUint16, this.#view, [offset, true]); }
  u32(): number { const offset = this.#offset; this.raw(4); return apply(getUint32, this.#view, [offset, true]); }
  u64(): bigint { const offset = this.#offset; this.raw(8); return apply(getBigUint64, this.#view, [offset, true]); }
  blob(maximum = JS_MAX_IO_BYTES): Uint8Array { const length = this.u32(); if (length > maximum) protocol("Linux record field exceeds its limit"); return this.raw(length); }
  text(maximum = 1024 * 1024): string { try { return new TextDecoder("utf-8", { fatal: true }).decode(this.blob(maximum)); } catch { return protocol("Invalid UTF-8 in Linux metadata"); } }
  strings(): string[] { const count = this.u32(); if (count > 4096) protocol("Linux argument count exceeds 4096"); return Array.from({ length: count }, () => this.text()); }
  end(): void { if (this.#offset !== this.bytes.byteLength) protocol("Unexpected Linux record fields"); }
}

export interface LinuxOperation<T> { readonly number: number; readonly payload: Uint8Array; decode(result: LinuxResult): T }
export function operation<T>(number: number, payload: Writer, decode: (result: LinuxResult) => T): LinuxOperation<T> { return { number, payload: payload.finish(), decode }; }
export function value(result: LinuxResult): number {
  if (result.bytes.byteLength !== 0 || result.value > BigInt(Number.MAX_SAFE_INTEGER)) protocol("Invalid numeric Linux result");
  return Number(result.value);
}
export function noValue(result: LinuxResult): void { if (value(result) !== 0) protocol("Invalid void Linux result"); }
