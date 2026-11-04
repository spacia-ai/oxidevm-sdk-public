import { LIMITS } from "./limits.js";

/** A guest pointer, length or record that does not lie inside linear memory, or breaks a profile bound (WASI `fault`). */
export class GuestFault extends Error {
  override readonly name = "GuestFault";
}

/** One fd_read/fd_write buffer, already checked against linear memory. */
export interface IoVector { readonly pointer: number; readonly length: number }

/**
 * Checked access to one instance's linear memory. Every view is created per access, so a `memory.grow` between calls
 * never leaves a detached buffer behind, and every range is checked before any byte is read or written.
 */
export class GuestMemory {
  readonly #memory: WebAssembly.Memory;

  constructor(memory: WebAssembly.Memory) { this.#memory = memory; }

  /** Throws unless `[pointer, pointer + length)` lies inside memory; both are guest u32 values. */
  check(pointer: number, length: number): void {
    if (!Number.isInteger(pointer) || !Number.isInteger(length) || pointer < 0 || length < 0 || pointer > 0xffff_ffff || length > 0xffff_ffff) {
      throw new GuestFault(`invalid guest range ${String(pointer)}+${String(length)}`);
    }
    if (pointer + length > this.#memory.buffer.byteLength) throw new GuestFault(`guest range ${String(pointer)}+${String(length)} is outside memory`);
  }
  #view(pointer: number, length: number): DataView {
    this.check(pointer, length);
    return new DataView(this.#memory.buffer, pointer, length);
  }
  u32(pointer: number): number { return this.#view(pointer, 4).getUint32(0, true); }
  setU32(pointer: number, value: number): void { this.#view(pointer, 4).setUint32(0, value, true); }
  u64(pointer: number): bigint { return this.#view(pointer, 8).getBigUint64(0, true); }
  setU64(pointer: number, value: bigint): void { this.#view(pointer, 8).setBigUint64(0, value, true); }
  /** A copy of guest bytes: the host never keeps a view into guest memory. */
  read(pointer: number, length: number): Uint8Array<ArrayBuffer> {
    this.check(pointer, length);
    return new Uint8Array(this.#memory.buffer.slice(pointer, pointer + length));
  }
  write(pointer: number, bytes: Uint8Array): void {
    this.check(pointer, bytes.byteLength);
    new Uint8Array(this.#memory.buffer, pointer, bytes.byteLength).set(bytes);
  }
  /**
   * Decodes an iovec/ciovec list: at most LIMITS.iovecs entries, every buffer inside memory, and at most LIMITS.ioBytes
   * in total. All of it is checked before the caller performs any IO.
   */
  ioVectors(list: number, count: number): readonly IoVector[] {
    if (!Number.isInteger(count) || count < 0 || count > LIMITS.iovecs) throw new GuestFault(`iovec count ${String(count)} exceeds ${String(LIMITS.iovecs)}`);
    this.check(list, count * 8);
    const vectors: IoVector[] = [];
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      const pointer = this.u32(list + index * 8), length = this.u32(list + index * 8 + 4);
      this.check(pointer, length);
      total += length;
      if (total > LIMITS.ioBytes) throw new GuestFault(`iovec total exceeds ${String(LIMITS.ioBytes)} bytes`);
      vectors.push({ pointer, length });
    }
    return vectors;
  }
}
