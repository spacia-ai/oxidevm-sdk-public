import { VMError } from "../../errors.js";

const HEADER = 16, CAPACITY = 64 * 1024 ** 2, FRAME = 12;
const min = Math.min, max = Math.max;
function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Invalid synchronous worker inbox"); }

/** One writer and one reader per direction. Publish bytes before the atomic cursor. */
export class SharedMessageInbox {
  readonly buffer: SharedArrayBuffer;
  readonly #header: Int32Array;
  constructor(buffer?: SharedArrayBuffer) {
    if (buffer === undefined) {
      buffer = new SharedArrayBuffer(4096 + HEADER, { maxByteLength: CAPACITY + HEADER });
      Atomics.store(new Int32Array(buffer, 0, 4), 3, 1);
    }
    if (!buffer.growable || buffer.byteLength < 4096 + HEADER || buffer.maxByteLength !== CAPACITY + HEADER) invalid();
    this.buffer = buffer; this.#header = new Int32Array(buffer, 0, 4);
    if (Atomics.load(this.#header, 3) !== 1) invalid();
  }
  #available(): { read: number; write: number; count: number } {
    const read = Atomics.load(this.#header, 0) >>> 0, write = Atomics.load(this.#header, 1) >>> 0, count = (write - read) >>> 0;
    if (count > CAPACITY) invalid(); return { read, write, count };
  }
  #copy(position: number, bytes: Uint8Array, writing: boolean): void {
    const offset = position & (CAPACITY - 1), first = min(bytes.length, CAPACITY - offset), end = HEADER + offset + first;
    if (writing && this.buffer.byteLength < end) this.buffer.grow(min(CAPACITY + HEADER, max(end, this.buffer.byteLength * 2)));
    if (end > this.buffer.byteLength) invalid();
    const body = new Uint8Array(this.buffer);
    if (writing) { body.set(bytes.subarray(0, first), HEADER + offset); if (first < bytes.length) body.set(bytes.subarray(first), HEADER); }
    else { bytes.set(body.subarray(HEADER + offset, end)); if (first < bytes.length) bytes.set(body.subarray(HEADER, HEADER + bytes.length - first), first); }
  }
  publish(sequence: number, bytes: Uint8Array | null, remaining: number): void {
    const { write, count } = this.#available();
    // Keep space for every admitted message even when its platform clone is not serializable here.
    if (bytes !== null && bytes.length + FRAME + remaining * FRAME > CAPACITY - count) bytes = null;
    const size = FRAME + (bytes?.length ?? 0);
    if (size > CAPACITY - count) invalid();
    const header = new Uint8Array(FRAME), view = new DataView(header.buffer);
    view.setUint32(0, sequence, true); view.setUint32(4, bytes?.length ?? 0, true); view.setUint32(8, bytes === null ? 1 : 0, true);
    this.#copy(write, header, true); if (bytes !== null) this.#copy(write + FRAME, bytes, true);
    Atomics.store(this.#header, 1, (write + size) | 0);
  }
  #frame(): { read: number; sequence: number; length: number; mode: number } | undefined {
    const { read, count } = this.#available();
    if (count === 0) return undefined;
    if (count < FRAME) invalid();
    const header = new Uint8Array(FRAME); this.#copy(read, header, false); const view = new DataView(header.buffer);
    const sequence = view.getUint32(0, true), length = view.getUint32(4, true), mode = view.getUint32(8, true);
    if (sequence === 0 || mode > 1 || mode === 1 && length !== 0 || length + FRAME > count) invalid();
    return { read, sequence, length, mode };
  }
  peek(): { readonly sequence: number; readonly bytes: Uint8Array | null } | undefined {
    const frame = this.#frame(); if (frame === undefined) return undefined;
    const bytes = frame.mode === 1 ? null : new Uint8Array(frame.length);
    if (bytes !== null) this.#copy(frame.read + FRAME, bytes, false);
    return { sequence: frame.sequence, bytes };
  }
  consume(sequence: number): void {
    const next = this.#frame(); if (next === undefined || next.sequence !== sequence) invalid();
    Atomics.store(this.#header, 0, (next.read + FRAME + next.length) | 0);
  }
}
