import { VMError } from "../../errors.js";
import { NATIVE_CHECKPOINT_FRAME_BYTES, supportsNativeCheckpointVersion } from "../../protocol/native-capture.js";
export const FRAME_BYTES = NATIVE_CHECKPOINT_FRAME_BYTES;
export const CHUNK_BYTES = 1024 * 1024;
export const MAX_STREAM_BYTES = 16 * 1024 ** 3;
export type CheckpointArea = "graph" | "payloads";
export type CheckpointSink = (area: CheckpointArea, index: number, bytes: Uint8Array<ArrayBuffer>) => Promise<void>;
export interface CheckpointInput { readonly bytes: number; readonly frames: AsyncIterable<Uint8Array>; retire(): Promise<void> }
export function active(signal?: AbortSignal): void { if (signal?.aborted === true) throw new VMError("ABORTED", "Checkpoint transfer was cancelled"); }
export function invalid(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }
export function header(magic: string, bytes = 8): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(bytes); output.set(new TextEncoder().encode(magic)); new DataView(output.buffer).setUint32(4, 1, true); return output;
}
export function checkHeader(bytes: Uint8Array, magic: string): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== magic
    || view.getUint16(6, true) !== 0
    || !(magic === "OXUC" ? supportsNativeCheckpointVersion(view.getUint16(4, true)) : view.getUint16(4, true) === 1)) invalid("Checkpoint stream format is unsupported");
}

/** Owns at most one storage chunk and transfers ownership of every flushed buffer. */
export class ChunkSink {
  readonly #area: CheckpointArea; readonly #sink: CheckpointSink; readonly #signal: AbortSignal | undefined;
  #buffer = new Uint8Array(CHUNK_BYTES); #used = 0; #index = 0; #total = 0;
  constructor(area: CheckpointArea, sink: CheckpointSink, signal?: AbortSignal) { this.#area = area; this.#sink = sink; this.#signal = signal; }
  get chunkOffset(): number { return this.#used; }
  /** Forward an already validated immutable chunk without copying or hashing its bytes again. */
  async forwardChunk(sink: (index: number) => Promise<void>): Promise<void> {
    active(this.#signal);
    if (this.#used !== 0 || this.#total + CHUNK_BYTES > MAX_STREAM_BYTES) invalid("Checkpoint reference is not aligned to a complete chunk");
    await sink(this.#index);
    this.#index++; this.#total += CHUNK_BYTES;
    active(this.#signal);
  }
  async write(bytes: Uint8Array): Promise<void> {
    active(this.#signal);
    if (this.#total + bytes.length > MAX_STREAM_BYTES) invalid("Checkpoint stream exceeds its byte limit");
    this.#total += bytes.length;
    for (let offset = 0; offset < bytes.length;) {
      const count = Math.min(CHUNK_BYTES - this.#used, bytes.length - offset);
      this.#buffer.set(bytes.subarray(offset, offset + count), this.#used); offset += count; this.#used += count;
      if (this.#used === CHUNK_BYTES) await this.#flush();
    }
  }
  async finish(): Promise<number> { if (this.#used !== 0) await this.#flush(); return this.#total; }
  async #flush(): Promise<void> {
    active(this.#signal);
    const output = this.#used === CHUNK_BYTES ? this.#buffer : this.#buffer.slice(0, this.#used);
    await this.#sink(this.#area, this.#index, output);
    this.#index++; this.#used = 0; this.#buffer = new Uint8Array(CHUNK_BYTES);
    active(this.#signal);
  }
}

/** Reads only the requested bounded frame, retaining at most one incoming CAS chunk. */
export class StreamReader {
  readonly #iterator: AsyncIterator<Uint8Array>; readonly #signal: AbortSignal | undefined;
  #current: Uint8Array = new Uint8Array(); #offset = 0; #remaining: number; #received = 0; readonly #total: number;
  constructor(input: CheckpointInput, signal?: AbortSignal) {
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > MAX_STREAM_BYTES) invalid("Checkpoint stream length is invalid");
    this.#iterator = input.frames[Symbol.asyncIterator](); this.#remaining = input.bytes; this.#total = input.bytes; this.#signal = signal;
  }
  get remaining(): number { return this.#remaining; }
  async read(length: number): Promise<Uint8Array<ArrayBuffer>> {
    if (!Number.isSafeInteger(length) || length < 0 || length > FRAME_BYTES || length > this.#remaining) invalid("Checkpoint stream frame is out of bounds");
    const output = new Uint8Array(length);
    for (let written = 0; written < length;) {
      active(this.#signal);
      if (this.#offset === this.#current.length) {
        const next = await this.#iterator.next(); active(this.#signal);
        if (next.done === true || !(next.value instanceof Uint8Array) || next.value.length === 0 || next.value.length > CHUNK_BYTES || this.#received + next.value.length > this.#total) invalid("Checkpoint stream is truncated or exceeds its declared size");
        this.#current = next.value; this.#offset = 0; this.#received += next.value.length;
      }
      const count = Math.min(length - written, this.#current.length - this.#offset);
      output.set(this.#current.subarray(this.#offset, this.#offset + count), written);
      this.#offset += count; written += count; this.#remaining -= count;
    }
    return output;
  }
  async finish(): Promise<void> {
    active(this.#signal);
    if (this.#remaining !== 0 || (await this.#iterator.next()).done !== true) invalid("Checkpoint stream has trailing or missing data");
    active(this.#signal);
  }
}
