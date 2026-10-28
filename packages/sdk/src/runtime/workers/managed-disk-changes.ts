import { VMError } from "../errors.js";
import { readInto, writeAll } from "./managed-disk-files.js";
import { SNAPSHOT_CHUNK_BYTES } from "./snapshot-manifest.js";

const FILE = "changes.bitmap";

/**
 * One bit per snapshot chunk (1 MiB) of a disk generation: the chunks changed since its
 * `changeBase` snapshot. A newly set bit is written and flushed before the caller writes the data,
 * so a crash can leave a bit set over unchanged data but never changed data without its bit.
 *
 * A save reads the changed chunks at its cut, then the guest runs again while the save is written
 * out. Changes from then on are also kept apart, so the save's commit can keep exactly them.
 */
export class ManagedDiskChanges {
  readonly #handle: FileSystemSyncAccessHandle;
  readonly #bits: Uint8Array<ArrayBuffer>;
  readonly #chunks: number;
  /** The chunks changed since a save's cut, while that save is being written out. */
  #sinceCut: Uint8Array<ArrayBuffer> | undefined;

  private constructor(handle: FileSystemSyncAccessHandle, bits: Uint8Array<ArrayBuffer>, chunks: number) {
    this.#handle = handle;
    this.#bits = bits;
    this.#chunks = chunks;
  }

  /**
   * Opens the generation's bitmap. A missing bitmap starts from `initial()`, the chunks the
   * generation already changed before change tracking existed.
   */
  static async open(
    directory: FileSystemDirectoryHandle,
    chunks: number,
    initial: () => Iterable<number>,
  ): Promise<ManagedDiskChanges> {
    const handle = await (await directory.getFileHandle(FILE, { create: true })).createSyncAccessHandle();
    try {
      const bits = new Uint8Array(Math.ceil(chunks / 8));
      const size = handle.getSize();
      if (size === 0) {
        for (const chunk of initial()) setBit(bits, chunk, chunks);
        writeAll(handle, 0, bits);
        handle.flush();
      } else if (size === bits.byteLength) {
        readInto(handle, 0, bits);
      } else {
        throw new VMError("STORAGE_ERROR", "managed disk change bitmap does not match the disk size");
      }
      return new ManagedDiskChanges(handle, bits, chunks);
    } catch (error) {
      handle.close();
      throw error;
    }
  }

  /** Marks the chunks `[offset, offset + length)` touches, durably, before the data is written. */
  mark(offset: number, length: number): void {
    if (length === 0) return;
    const first = Math.floor(offset / SNAPSHOT_CHUNK_BYTES);
    const last = Math.floor((offset + length - 1) / SNAPSHOT_CHUNK_BYTES);
    let low = Number.POSITIVE_INFINITY;
    let high = -1;
    for (let chunk = first; chunk <= last; chunk += 1) {
      if (this.#sinceCut !== undefined) setBit(this.#sinceCut, chunk, this.#chunks);
      if (setBit(this.#bits, chunk, this.#chunks)) {
        low = Math.min(low, chunk >> 3);
        high = Math.max(high, chunk >> 3);
      }
    }
    if (high < 0) return;
    writeAll(this.#handle, low, this.#bits.subarray(low, high + 1));
    this.#handle.flush();
  }

  changedChunks(): number[] {
    const chunks: number[] = [];
    for (let chunk = 0; chunk < this.#chunks; chunk += 1) {
      if (((this.#bits[chunk >> 3] ?? 0) & (1 << (chunk & 7))) !== 0) chunks.push(chunk);
    }
    return chunks;
  }

  /** Forgets every change: the generation now equals its new `changeBase`. */
  reset(): void {
    this.#sinceCut = undefined;
    this.#bits.fill(0);
    writeAll(this.#handle, 0, this.#bits);
    this.#handle.flush();
  }

  /** A save's cut: changes from now on are also kept apart until the save commits or fails. */
  cut(): void {
    this.#sinceCut = new Uint8Array(this.#bits.byteLength);
  }

  /**
   * The save cut by `cut` committed and is the new `changeBase`: only the changes made since its
   * cut remain. Until this is durable the stored bitmap still holds them, among others.
   */
  commitCut(): void {
    const since = this.#sinceCut;
    if (since === undefined) throw new VMError("STORAGE_ERROR", "managed disk changes were not cut for a save");
    this.#sinceCut = undefined;
    this.#bits.set(since);
    writeAll(this.#handle, 0, this.#bits);
    this.#handle.flush();
  }

  /** The save failed after its cut: every change since the old `changeBase` stays. */
  abortCut(): void {
    this.#sinceCut = undefined;
  }

  close(): void {
    this.#handle.close();
  }
}

/** Sets a chunk's bit; returns whether it was clear. */
function setBit(bits: Uint8Array, chunk: number, chunks: number): boolean {
  if (!Number.isSafeInteger(chunk) || chunk < 0 || chunk >= chunks) {
    throw new VMError("STORAGE_ERROR", "managed disk change is out of bounds");
  }
  const byte = bits[chunk >> 3] ?? 0;
  const mask = 1 << (chunk & 7);
  if ((byte & mask) !== 0) return false;
  bits[chunk >> 3] = byte | mask;
  return true;
}
