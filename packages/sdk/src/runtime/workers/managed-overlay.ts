import { VMError, normalizeStorageError } from "../errors.js";
import { MANAGED_OVERLAY_SEGMENT_BYTES } from "../managed-disk-state.js";
import { closeDiskSegments, openDiskSegments } from "./managed-disk-files.js";

const BLOCK = 4096;
const HEADER = 32;
const ENTRY = 8;
const MAX_INDEX = 128 * 1024 * 1024;
const MAGIC = new TextEncoder().encode("OVMCOW03");

/** Dense physical slots for dirty logical blocks. This is an experimental
 * managed-overlay layout, not the frozen production disk format. The containing
 * ManagedDisk remains the dirty-bitmap and disk-flush authority. */
export class PackedOverlay {
  readonly #blocks: number;
  readonly #index: FileSystemSyncAccessHandle;
  readonly #data: readonly FileSystemSyncAccessHandle[];
  readonly #mapping: Uint8Array<ArrayBuffer>;
  readonly #view: DataView<ArrayBuffer>;
  readonly #used: Uint8Array<ArrayBuffer>;
  readonly #dirty = new Set<number>();
  readonly #pending = new Set<number>();
  #next = 0;

  static supports(length: number): boolean {
    return Number.isSafeInteger(length) && length > 0 && HEADER + Math.ceil(length / BLOCK) * ENTRY <= MAX_INDEX;
  }

  static async open(
    directory: FileSystemDirectoryHandle,
    length: number,
    bitmap: Uint8Array,
  ): Promise<PackedOverlay | undefined> {
    let file = await optionalFile(directory, "overlay-v3.index");
    if (!PackedOverlay.supports(length)) {
      if (file !== undefined) fail("packed overlay geometry is invalid");
      return undefined;
    }
    // Existing v1/v2 workspaces keep their readers; no destructive migration or
    // temporary second copy is needed to open a previously usable disk.
    if (file === undefined) {
      if (await optionalFile(directory, "overlay.img") !== undefined
        || await optionalFile(directory, "overlay-v2.img") !== undefined) return undefined;
      if (bitmap.some(value => value !== 0)) fail("packed overlay index is missing");
      file = await directory.getFileHandle("overlay-v3.index", { create: true });
    }
    const index = await file.createSyncAccessHandle();
    let data: FileSystemSyncAccessHandle[] = [];
    try {
      data = await openDiskSegments(directory, "overlay-v3", Math.ceil(length / BLOCK) * BLOCK);
      return new PackedOverlay(length, index, data, bitmap);
    } catch (error) {
      index.close(); closeDiskSegments(data); throw error;
    }
  }

  constructor(length: number, index: FileSystemSyncAccessHandle, data: readonly FileSystemSyncAccessHandle[], bitmap: Uint8Array) {
    if (!PackedOverlay.supports(length)) fail("packed overlay geometry is invalid");
    this.#blocks = Math.ceil(length / BLOCK);
    if (data.length !== Math.ceil(this.#blocks * BLOCK / MANAGED_OVERLAY_SEGMENT_BYTES)
      || bitmap.byteLength !== Math.ceil(this.#blocks / 8)) fail("packed overlay geometry is invalid");
    const tail = this.#blocks % 8;
    if (tail !== 0 && ((bitmap[bitmap.byteLength - 1] ?? 0) & (0xff << tail)) !== 0) fail("packed overlay bitmap has out-of-range bits");
    this.#index = index;
    this.#data = data;
    this.#mapping = new Uint8Array(HEADER + this.#blocks * ENTRY);
    this.#view = new DataView(this.#mapping.buffer);
    this.#used = new Uint8Array(Math.ceil(this.#blocks / 8));
    const expected = header(length);
    if (index.getSize() === 0) {
      if (bitmap.some(value => value !== 0)) fail("packed overlay index is missing");
      index.truncate(this.#mapping.byteLength);
      writeAll(index, 0, expected);
      index.flush();
      this.#mapping.set(expected);
    } else {
      if (index.getSize() !== this.#mapping.byteLength) fail("packed overlay index is truncated or has invalid geometry");
      readAll(index, 0, this.#mapping);
      if (!expected.every((byte, offset) => this.#mapping[offset] === byte)) fail("packed overlay header is invalid");
    }
    this.#restore(bitmap);
  }

  #restore(bitmap: Uint8Array): void {
    const sizes = this.#data.map(handle => handle.getSize());
    const retained = sizes.map(() => 0);
    for (let block = 0; block < this.#blocks; block++) {
      const slot = this.#view.getUint32(HEADER + block * ENTRY, true);
      const guard = this.#view.getUint32(HEADER + block * ENTRY + 4, true);
      if (slot === 0) {
        if (guard !== 0 || ((bitmap[block >>> 3] ?? 0) & (1 << (block & 7))) !== 0) fail("packed overlay mapping is missing or torn");
        continue;
      }
      if (slot > this.#blocks || guard !== ((~slot) >>> 0) || this.#occupied(slot - 1)) fail("packed overlay mapping is invalid or duplicated");
      const position = location(slot - 1);
      if ((sizes[position.segment] ?? 0) < position.offset + BLOCK) fail("packed overlay data is truncated");
      retained[position.segment] = Math.max(retained[position.segment] ?? 0, position.offset + BLOCK);
      this.#occupy(slot - 1);
    }
    // Only unreferenced tails are reclaimable. Validate the entire map and
    // containing disk bitmap before changing any existing data file.
    for (const [segment, handle] of this.#data.entries()) {
      const length = retained[segment] ?? 0;
      if (handle.getSize() > length) { handle.truncate(length); handle.flush(); }
    }
  }

  read(offset: number, output: Uint8Array): void {
    this.#validate(offset, output.byteLength);
    let done = 0;
    while (done < output.byteLength) {
      const address = offset + done;
      const slot = this.#slot(Math.floor(address / BLOCK));
      if (slot === 0) fail("packed overlay block is missing");
      const position = location(slot - 1);
      const count = Math.min(BLOCK - address % BLOCK, output.byteLength - done);
      readAll(this.#handle(position.segment), position.offset + address % BLOCK, output.subarray(done, done + count));
      done += count;
    }
  }

  write(offset: number, input: Uint8Array): void {
    this.#validate(offset, input.byteLength);
    let done = 0;
    while (done < input.byteLength) {
      const address = offset + done;
      const block = Math.floor(address / BLOCK);
      const count = Math.min(BLOCK - address % BLOCK, input.byteLength - done);
      const previous = this.#slot(block);
      if (previous === 0 && (address % BLOCK !== 0 || count !== BLOCK)) fail("new packed block requires complete initialization");
      while (this.#next < this.#blocks && this.#occupied(this.#next)) this.#next++;
      const slot = previous === 0 ? this.#next : previous - 1;
      if (slot >= this.#blocks) fail("packed overlay slots are exhausted");
      const position = location(slot);
      writeAll(this.#handle(position.segment), position.offset + address % BLOCK, input.subarray(done, done + count));
      this.#dirty.add(position.segment);
      if (previous === 0) {
        this.#occupy(slot);
        this.#view.setUint32(HEADER + block * ENTRY, slot + 1, true);
        this.#view.setUint32(HEADER + block * ENTRY + 4, (~(slot + 1)) >>> 0, true);
        this.#pending.add(block);
      }
      done += count;
    }
  }

  flush(): void {
    // New mappings cannot become durable before their complete block payloads.
    for (const segment of this.#dirty) this.#handle(segment).flush();
    const pending = [...this.#pending].sort((left, right) => left - right);
    for (let index = 0; index < pending.length;) {
      const first = pending[index];
      if (first === undefined) fail("packed overlay pending map is invalid");
      let end = first + 1;
      while (pending[++index] === end) end++;
      const start = HEADER + first * ENTRY;
      writeAll(this.#index, start, this.#mapping.subarray(start, HEADER + end * ENTRY));
    }
    if (pending.length !== 0) this.#index.flush();
    this.#dirty.clear();
    this.#pending.clear();
  }

  close(): void {
    const failures: VMError[] = [];
    try { this.flush(); } catch (error) { failures.push(normalizeStorageError(error)); }
    for (const handle of [this.#index, ...this.#data]) {
      try { handle.close(); } catch (error) { failures.push(normalizeStorageError(error)); }
    }
    const first = failures[0]; if (first !== undefined) throw first;
  }

  #slot(block: number): number { return this.#view.getUint32(HEADER + block * ENTRY, true); }
  #occupied(slot: number): boolean { return ((this.#used[slot >>> 3] ?? 0) & (1 << (slot & 7))) !== 0; }
  #occupy(slot: number): void { this.#used[slot >>> 3] = (this.#used[slot >>> 3] ?? 0) | (1 << (slot & 7)); }
  #handle(segment: number): FileSystemSyncAccessHandle {
    const handle = this.#data[segment]; if (handle === undefined) fail("packed overlay segment is missing"); return handle;
  }
  #validate(offset: number, length: number): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
      || offset + length > this.#blocks * BLOCK) fail("packed overlay access is invalid");
  }
}

function header(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(HEADER); bytes.set(MAGIC);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(8, BigInt(length), true);
  view.setUint32(16, BLOCK, true); view.setUint32(20, ENTRY, true);
  view.setUint32(24, MANAGED_OVERLAY_SEGMENT_BYTES, true);
  return bytes;
}

function location(slot: number): { readonly segment: number; readonly offset: number } {
  const address = slot * BLOCK;
  return { segment: Math.floor(address / MANAGED_OVERLAY_SEGMENT_BYTES), offset: address % MANAGED_OVERLAY_SEGMENT_BYTES };
}

function readAll(handle: FileSystemSyncAccessHandle, offset: number, output: Uint8Array): void {
  let done = 0;
  while (done < output.byteLength) {
    const count = handle.read(output.subarray(done), { at: offset + done });
    if (!Number.isSafeInteger(count) || count <= 0 || count > output.byteLength - done) fail("packed overlay data is truncated");
    done += count;
  }
}

function writeAll(handle: FileSystemSyncAccessHandle, offset: number, input: Uint8Array): void {
  let done = 0;
  while (done < input.byteLength) {
    const count = handle.write(input.subarray(done), { at: offset + done });
    if (!Number.isSafeInteger(count) || count <= 0 || count > input.byteLength - done) fail("packed overlay write returned an invalid count");
    done += count;
  }
}

function fail(message: string): never { throw new VMError("STORAGE_ERROR", message); }

async function optionalFile(directory: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle | undefined> {
  try { return await directory.getFileHandle(name); }
  catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
    throw error;
  }
}
