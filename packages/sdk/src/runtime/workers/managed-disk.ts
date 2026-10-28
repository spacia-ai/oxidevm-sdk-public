import { normalizeStorageError, VMError } from "../errors.js";
import {
  managedChunkPackIndex,
  managedChunkPackOffset,
  managedDirtyBitmapRange,
  managedDirtyBitmapUpdate,
  managedLeadingPartialLength,
  MANAGED_OVERLAY_SEGMENT_BYTES,
  managedReadRunLength,
  managedSegmentPosition,
} from "../managed-disk-state.js";
import type { ManagedImageManifest } from "../managed-image.js";
import {
  closeCollecting,
  closeDiskSegments as closeAll,
  flushDirty,
  markSegmentRange,
  openDiskSegments as openSegmentHandles,
  readInto,
  readSegmented,
  removeIfPresent,
  writeAll,
  writeSegmented,
} from "./managed-disk-files.js";
import type { BaseLease } from "./managed-base.js";
import { ManagedDiskChanges } from "./managed-disk-changes.js";
import { DISK_RESERVE_BYTES, refusedForSpace, SpaceReserve } from "./managed-disk-reserve.js";
import { type ManagedImageRef, readGenerationRecord, writeGenerationRecord } from "./managed-disk-head.js";
import { PackedOverlay } from "./managed-overlay.js";
import { SNAPSHOT_CHUNK_BYTES } from "./snapshot-manifest.js";

const BLOCK_BYTES = 4096;
const LEGACY_OVERLAY_SEGMENT_BYTES = 1024 * 1024 * 1024;
const OVERLAY_STEM = "overlay-v2";

/** The image a disk generation is based on: its identity and its manifest's chunk layout. */
export interface ManagedImageSource {
  readonly ref: ManagedImageRef;
  readonly manifest: ManagedImageManifest;
}

interface DiskParts {
  readonly image: ManagedImageSource;
  readonly generation: string;
  readonly directory: FileSystemDirectoryHandle;
  readonly base: BaseLease;
  readonly overlays: readonly FileSystemSyncAccessHandle[] | PackedOverlay;
  readonly bitmapHandle: FileSystemSyncAccessHandle;
  readonly bitmap: Uint8Array<ArrayBuffer>;
  readonly changes: ManagedDiskChanges;
  readonly changeBase: string | null;
  readonly reserve: SpaceReserve | undefined;
}

/**
 * One managed disk generation (`managed-disks/<generation>/`): a copy-on-write overlay over its
 * image's shared base pack, plus a per-MiB change bitmap relative to its `changeBase` snapshot.
 */
export class ManagedDisk {
  readonly #length: number;
  readonly #image: ManagedImageRef;
  readonly #generation: string;
  readonly #directory: FileSystemDirectoryHandle;
  readonly #base: BaseLease;
  readonly #overlays: readonly FileSystemSyncAccessHandle[] | PackedOverlay;
  readonly #bitmapHandle: FileSystemSyncAccessHandle;
  readonly #bitmap: Uint8Array<ArrayBuffer>;
  readonly #changes: ManagedDiskChanges;
  readonly #reserve: SpaceReserve | undefined;
  readonly #chunkBytes: number;
  readonly #packedChunks: Int32Array<ArrayBuffer>;
  readonly #snapshotBaseChunks: readonly number[];
  readonly #dirtyOverlays = new Set<number>();
  readonly #blockScratch = new Uint8Array(BLOCK_BYTES);
  readonly #zeroes = new Uint8Array(SNAPSHOT_CHUNK_BYTES);
  #changeBase: string | null;
  #pendingBitmap:
    | { readonly offset: number; readonly length: number }
    | undefined;

  private constructor(parts: DiskParts) {
    const disk = parts.image.manifest.disk;
    this.#length = disk.bytes;
    this.#image = parts.image.ref;
    this.#generation = parts.generation;
    this.#directory = parts.directory;
    this.#base = parts.base;
    this.#overlays = parts.overlays;
    this.#bitmapHandle = parts.bitmapHandle;
    this.#bitmap = parts.bitmap;
    this.#changes = parts.changes;
    this.#reserve = parts.reserve;
    this.#chunkBytes = disk.chunkBytes;
    this.#packedChunks = managedChunkPackIndex(
      Math.ceil(disk.bytes / disk.chunkBytes),
      disk.chunks.map((chunk) => chunk.index),
    );
    this.#snapshotBaseChunks = managedSnapshotBaseChunks(parts.image.manifest);
    this.#changeBase = parts.changeBase;
  }

  /**
   * Opens generation `generation` of `image` in `disks` (`managed-disks/`), creating it when
   * absent, and holds `reserveBytes` of storage for the guest's writes when the origin has room.
   * The disk owns `base` from this call: it releases the lease when it closes, or here when
   * opening fails.
   */
  static async open(
    disks: FileSystemDirectoryHandle,
    generation: string,
    image: ManagedImageSource,
    base: BaseLease,
    { reserveBytes = DISK_RESERVE_BYTES }: { readonly reserveBytes?: number } = {},
  ): Promise<ManagedDisk> {
    const length = image.manifest.disk.bytes;
    let bitmapHandle: FileSystemSyncAccessHandle | undefined;
    let overlays: readonly FileSystemSyncAccessHandle[] | PackedOverlay = [];
    let changes: ManagedDiskChanges | undefined;
    let reserve: SpaceReserve | undefined;
    try {
      const directory = await disks.getDirectoryHandle(generation, { create: true });
      const record = await readGenerationRecord(directory);
      if (record !== undefined && (record.image.identity !== image.ref.identity || record.bytes !== length)) {
        throw new VMError("STORAGE_ERROR", "the disk generation belongs to another image", {
          reason: "disk-record-damaged",
        });
      }
      bitmapHandle = await (await directory.getFileHandle("overlay.bitmap", { create: true })).createSyncAccessHandle();
      const bitmap = readOverlayBitmap(bitmapHandle, length);
      overlays = await openDiskOverlay(directory, length, bitmap);
      // A generation from before change tracking has changed every chunk its overlay holds.
      changes = await ManagedDiskChanges.open(directory, chunkCount(length), () => dirtyChunks(bitmap, length));
      if (record === undefined) {
        await writeGenerationRecord(directory, { schema: 1, image: image.ref, bytes: length, changeBase: null });
      }
      reserve = await SpaceReserve.open(directory, reserveBytes);
      return new ManagedDisk({
        image,
        generation,
        directory,
        base,
        overlays,
        bitmapHandle,
        bitmap,
        changes,
        changeBase: record?.changeBase ?? null,
        reserve,
      });
    } catch (error) {
      reserve?.close();
      changes?.close();
      if (overlays instanceof PackedOverlay) overlays.close(); else closeAll(overlays);
      bitmapHandle?.close();
      base.release();
      throw error;
    }
  }

  get length(): number {
    return this.#length;
  }

  get identity(): string {
    return this.#image.identity;
  }

  get image(): ManagedImageRef {
    return this.#image;
  }

  get generation(): string {
    return this.#generation;
  }

  /** The snapshot this generation's changes are relative to; null means the image base. */
  get changeBase(): string | null {
    return this.#changeBase;
  }

  /** The chunks the image base holds non-zero content in. */
  snapshotBaseChunks(): readonly number[] {
    return this.#snapshotBaseChunks;
  }

  /** Every chunk the overlay holds: all changes since the image base. */
  snapshotDirtyChunks(): number[] {
    return dirtyChunks(this.#bitmap, this.#length);
  }

  /** The chunks changed since `changeBase`. */
  changedChunks(): number[] {
    return this.#changes.changedChunks();
  }

  readSnapshotChunk(index: number): Uint8Array<ArrayBuffer> {
    const output = new Uint8Array(snapshotChunkLength(index, this.#length));
    this.read(index * SNAPSHOT_CHUNK_BYTES, output);
    return output;
  }

  /** A save's cut: the chunks it reads now; changes after this are kept for the next save. */
  cutChanges(): number[] {
    this.#changes.cut();
    return this.#changes.changedChunks();
  }

  /**
   * Records that save `snapshotId`, cut by `cutChanges`, committed: the generation names it as its
   * change base, then only the changes made since its cut stay. A crash in between leaves more
   * bits set, which only makes the next save read more.
   */
  async commitCut(snapshotId: string): Promise<void> {
    this.flush();
    await writeGenerationRecord(this.#directory, {
      schema: 1,
      image: this.#image,
      bytes: this.#length,
      changeBase: snapshotId,
    });
    this.#changeBase = snapshotId;
    this.#changes.commitCut();
  }

  /** The save cut by `cutChanges` failed: every change stays for the next save. */
  abortCut(): void {
    this.#changes.abortCut();
  }

  /**
   * Records that the disk now equals snapshot `snapshotId`: data and overlay bitmap are flushed,
   * the generation names the snapshot as its change base, and then the change bits clear. A crash
   * in between leaves bits set, which only makes the next capture read more.
   */
  async commitSnapshot(snapshotId: string): Promise<void> {
    this.flush();
    await writeGenerationRecord(this.#directory, {
      schema: 1,
      image: this.#image,
      bytes: this.#length,
      changeBase: snapshotId,
    });
    this.#changeBase = snapshotId;
    this.#changes.reset();
  }

  read(offset: number, destination: Uint8Array): void {
    this.#validate(offset, destination.byteLength);
    let completed = 0;
    while (completed < destination.byteLength) {
      const address = offset + completed;
      const block = Math.floor(address / BLOCK_BYTES);
      const length = managedReadRunLength(
        address,
        destination.byteLength - completed,
        BLOCK_BYTES,
        this.#chunkBytes,
        (candidate) => this.#dirty(candidate),
      );
      const output = destination.subarray(completed, completed + length);
      if (this.#dirty(block)) {
        if (this.#overlays instanceof PackedOverlay) this.#overlays.read(address, output);
        else readSegmented(this.#overlays, address, output);
      } else {
        this.#readBase(address, output);
      }
      completed += length;
    }
  }

  write(offset: number, source: Uint8Array): void {
    this.#validate(offset, source.byteLength);
    try {
      this.#write(offset, source);
    } catch (error) {
      // The browser refused the write for lack of space: the reserve kept for this moment makes
      // room, and the write runs again, repeating what it already wrote.
      if (!refusedForSpace(error) || this.#reserve?.release() !== true) throw error;
      this.#write(offset, source);
    }
  }

  /** Holds the guest's space reserve again when the origin has room; whether it holds it now. */
  async holdReserve(): Promise<boolean> {
    return (await this.#reserve?.hold()) ?? false;
  }

  #write(offset: number, source: Uint8Array): void {
    // The change bit reaches storage before the data does.
    this.#changes.mark(offset, source.byteLength);
    let completed = 0;
    const leading = managedLeadingPartialLength(
      offset,
      source.byteLength,
      BLOCK_BYTES,
    );
    if (leading > 0) {
      this.#writePartial(offset, source.subarray(0, leading));
      completed = leading;
    }

    const fullBytes =
      Math.floor((source.byteLength - completed) / BLOCK_BYTES) * BLOCK_BYTES;
    if (fullBytes > 0) {
      const address = offset + completed;
      this.#writeOverlay(
        address,
        source.subarray(completed, completed + fullBytes),
      );
      this.#markDirtyRange(address / BLOCK_BYTES, fullBytes / BLOCK_BYTES);
      completed += fullBytes;
    }

    if (completed < source.byteLength) {
      this.#writePartial(
        offset + completed,
        source.subarray(completed),
      );
    }
  }

  zero(offset: number, length: number): void {
    this.#validate(offset, length);
    let completed = 0;
    while (completed < length) {
      const count = Math.min(length - completed, this.#zeroes.byteLength);
      this.write(offset + completed, this.#zeroes.subarray(0, count));
      completed += count;
    }
  }

  discard(offset: number, length: number): void {
    this.#validate(offset, length);
  }

  flush(): void {
    if (this.#overlays instanceof PackedOverlay) this.#overlays.flush();
    else flushDirty(this.#overlays, this.#dirtyOverlays);
    const pending = this.#pendingBitmap;
    if (pending !== undefined) {
      writeAll(
        this.#bitmapHandle,
        pending.offset,
        this.#bitmap.subarray(pending.offset, pending.offset + pending.length),
      );
      this.#bitmapHandle.flush();
    }
    this.#dirtyOverlays.clear();
    this.#pendingBitmap = undefined;
  }

  close(): void {
    const failures: VMError[] = [];
    try {
      this.flush();
    } catch (error) {
      failures.push(normalizeStorageError(error));
    }
    try {
      this.#changes.close();
    } catch (error) {
      failures.push(normalizeStorageError(error));
    }
    try {
      this.#reserve?.close();
    } catch (error) {
      failures.push(normalizeStorageError(error));
    }
    this.#base.release();
    if (this.#overlays instanceof PackedOverlay) {
      try { this.#overlays.close(); } catch (error) { failures.push(normalizeStorageError(error)); }
    } else closeCollecting(this.#overlays, failures);
    try {
      this.#bitmapHandle.close();
    } catch (error) {
      failures.push(normalizeStorageError(error));
    }
    const failure = failures[0];
    if (failure !== undefined) throw failure;
  }

  #dirty(block: number): boolean {
    const byte = this.#bitmap[Math.floor(block / 8)];
    return byte !== undefined && (byte & (1 << (block % 8))) !== 0;
  }

  #readBase(offset: number, destination: Uint8Array): void {
    const packedOffset = managedChunkPackOffset(
      offset,
      this.#chunkBytes,
      this.#packedChunks,
    );
    if (packedOffset === undefined) destination.fill(0);
    else this.#base.read(packedOffset, destination);
  }

  #writePartial(
    offset: number,
    source: Uint8Array,
  ): void {
    const block = Math.floor(offset / BLOCK_BYTES);
    if (this.#dirty(block)) {
      this.#writeOverlay(offset, source);
      return;
    }
    this.#readBase(block * BLOCK_BYTES, this.#blockScratch);
    this.#blockScratch.set(source, offset % BLOCK_BYTES);
    this.#writeOverlay(block * BLOCK_BYTES, this.#blockScratch);
    this.#markDirtyRange(block, 1);
  }

  #markDirtyRange(firstBlock: number, blocks: number): void {
    let update;
    try {
      update = managedDirtyBitmapUpdate(this.#bitmap, firstBlock, blocks);
    } catch (error) {
      throw new VMError("STORAGE_ERROR", "overlay bitmap is out of bounds", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (update === undefined) return;
    this.#bitmap.set(update.bytes, update.offset);
    this.#pendingBitmap = managedDirtyBitmapRange(
      this.#pendingBitmap,
      update.offset,
      update.bytes.byteLength,
    );
  }

  #writeOverlay(offset: number, source: Uint8Array): void {
    if (this.#overlays instanceof PackedOverlay) this.#overlays.write(offset, source);
    else {
      markSegmentRange(this.#dirtyOverlays, offset, source.byteLength);
      writeSegmented(this.#overlays, offset, source);
    }
  }

  #validate(offset: number, length: number): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.#length
    ) {
      throw new VMError("STORAGE_ERROR", "managed disk access is invalid");
    }
  }
}

async function openDiskOverlay(
  directory: FileSystemDirectoryHandle,
  length: number,
  bitmap: Uint8Array,
): Promise<readonly FileSystemSyncAccessHandle[] | PackedOverlay> {
  const packed = await PackedOverlay.open(directory, length, bitmap);
  if (packed !== undefined) return packed;
  const overlays = await openSegmentHandles(directory, OVERLAY_STEM, length);
  try {
    const legacy = await openLegacyOverlayHandles(directory, length);
    try {
      if (legacy.length !== 0) migrateLegacyOverlay(legacy, overlays, bitmap, length);
    } finally { closeAll(legacy); }
    if (legacy.length !== 0) await removeSegmentFiles(directory, "overlay", legacy.length);
    return overlays;
  } catch (error) { closeAll(overlays); throw error; }
}

function readOverlayBitmap(handle: FileSystemSyncAccessHandle, length: number): Uint8Array<ArrayBuffer> {
  const bitmapBytes = Math.ceil(Math.ceil(length / BLOCK_BYTES) / 8);
  const currentBitmapBytes = handle.getSize();
  if (currentBitmapBytes === 0) {
    handle.truncate(bitmapBytes);
    handle.flush();
  } else if (currentBitmapBytes !== bitmapBytes) {
    throw new VMError("STORAGE_ERROR", "managed disk overlay geometry does not match the image");
  }
  const bitmap = new Uint8Array(bitmapBytes);
  readInto(handle, 0, bitmap);
  return bitmap;
}

/** The snapshot chunks holding at least one overlay block. */
function dirtyChunks(bitmap: Uint8Array, length: number): number[] {
  const chunks = new Set<number>();
  const blocks = Math.ceil(length / BLOCK_BYTES);
  for (let block = 0; block < blocks; block += 1) {
    const byte = bitmap[Math.floor(block / 8)];
    if (byte !== undefined && (byte & (1 << (block % 8))) !== 0) {
      chunks.add(Math.floor((block * BLOCK_BYTES) / SNAPSHOT_CHUNK_BYTES));
    }
  }
  return [...chunks].sort((left, right) => left - right);
}

function chunkCount(length: number): number {
  return Math.ceil(length / SNAPSHOT_CHUNK_BYTES);
}

function managedSnapshotBaseChunks(manifest: ManagedImageManifest): number[] {
  const chunks = new Set<number>();
  for (const chunk of manifest.disk.chunks) {
    const start = chunk.index * manifest.disk.chunkBytes;
    const end = start + chunk.bytes;
    for (
      let index = Math.floor(start / SNAPSHOT_CHUNK_BYTES);
      index <= Math.floor((end - 1) / SNAPSHOT_CHUNK_BYTES);
      index += 1
    ) {
      chunks.add(index);
    }
  }
  return [...chunks].sort((left, right) => left - right);
}

function snapshotChunkLength(index: number, length: number): number {
  const start = index * SNAPSHOT_CHUNK_BYTES;
  if (!Number.isSafeInteger(index) || index < 0 || start >= length) {
    throw new VMError("STORAGE_ERROR", "snapshot disk chunk is out of bounds");
  }
  return Math.min(SNAPSHOT_CHUNK_BYTES, length - start);
}

async function openLegacyOverlayHandles(
  directory: FileSystemDirectoryHandle,
  length: number,
): Promise<FileSystemSyncAccessHandle[]> {
  try {
    await directory.getFileHandle("overlay.img");
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return [];
    }
    throw error;
  }
  return openSegmentHandles(
    directory,
    "overlay",
    length,
    LEGACY_OVERLAY_SEGMENT_BYTES,
  );
}

async function removeSegmentFiles(
  directory: FileSystemDirectoryHandle,
  stem: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const name = index === 0 ? `${stem}.img` : `${stem}.${String(index)}.img`;
    await removeIfPresent(directory, name);
  }
}

function migrateLegacyOverlay(
  legacyOverlays: readonly FileSystemSyncAccessHandle[],
  overlays: readonly FileSystemSyncAccessHandle[],
  bitmap: Uint8Array,
  length: number,
): void {
  if (legacyOverlays[0] === undefined) {
    throw new VMError("STORAGE_ERROR", "managed disk overlay is missing");
  }
  const legacySizes = legacyOverlays.map((handle) => handle.getSize());
  const scratch = new Uint8Array(BLOCK_BYTES);
  const changedSegments = new Set<number>();
  const blocks = Math.ceil(length / BLOCK_BYTES);
  for (let byteIndex = 0; byteIndex < bitmap.byteLength; byteIndex += 1) {
    const bitmapByte = bitmap[byteIndex];
    if (bitmapByte === undefined) {
      throw new VMError("STORAGE_ERROR", "managed disk bitmap is truncated");
    }
    if (bitmapByte === 0) continue;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((bitmapByte & (1 << bit)) === 0) continue;
      const block = byteIndex * 8 + bit;
      if (block >= blocks) {
        throw new VMError("STORAGE_ERROR", "managed disk bitmap is invalid");
      }
      const address = block * BLOCK_BYTES;
      const blockLength = Math.min(BLOCK_BYTES, length - address);
      const legacyPosition = managedSegmentPosition(
        address,
        LEGACY_OVERLAY_SEGMENT_BYTES,
      );
      const legacy = legacyOverlays[legacyPosition.index];
      const legacySize = legacySizes[legacyPosition.index];
      const position = managedSegmentPosition(
        address,
        MANAGED_OVERLAY_SEGMENT_BYTES,
      );
      const target = overlays[position.index];
      if (
        legacy === undefined ||
        legacySize === undefined ||
        legacySize < legacyPosition.offset + blockLength ||
        target === undefined
      ) {
        throw new VMError("STORAGE_ERROR", "managed disk segment is missing");
      }
      const blockScratch = scratch.subarray(0, blockLength);
      readInto(legacy, legacyPosition.offset, blockScratch);
      writeAll(target, position.offset, blockScratch);
      changedSegments.add(position.index);
    }
  }
  for (const index of changedSegments) {
    const overlay = overlays[index];
    if (overlay === undefined) {
      throw new VMError("STORAGE_ERROR", "managed disk segment is missing");
    }
    overlay.flush();
  }
}
