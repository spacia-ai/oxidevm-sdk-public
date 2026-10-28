export const MANAGED_OVERLAY_SEGMENT_BYTES = 64 * 1024 * 1024;

export function managedBaseIsComplete(
  size: number,
  marker: string | undefined,
  expectedSize: number,
  identity: string,
): boolean {
  return size === expectedSize && marker === managedBaseMarker(expectedSize, identity);
}

export function managedBaseMarker(size: number, identity: string): string {
  return `${identity}:${String(size)}\n`;
}

/** The files a cached managed image keeps beside its stem. */
export const MANAGED_IMAGE_CACHE_SUFFIXES = [".pack", ".complete", ".image.json", ".kernel", ".initrd"] as const;

/**
 * Whether a cached file belongs to another build of the same image version that no workspace
 * pins. Pinned builds stay, because restore points and disk generations reference them.
 */
export function managedBaseCacheEntryIsStale(
  name: string,
  family: string,
  currentStem: string,
  pinnedStems: ReadonlySet<string>,
): boolean {
  if (!name.startsWith(family)) return false;
  const suffix = MANAGED_IMAGE_CACHE_SUFFIXES.find((candidate) => name.endsWith(candidate));
  if (suffix === undefined) return false;
  const stem = name.slice(0, -suffix.length);
  return stem !== currentStem && !pinnedStems.has(stem);
}

export function managedChunkPackIndex(
  totalChunks: number,
  chunkIndexes: readonly number[],
): Int32Array<ArrayBuffer> {
  const packed = new Int32Array(totalChunks);
  packed.fill(-1);
  for (const [position, chunk] of chunkIndexes.entries()) {
    if (
      !Number.isInteger(chunk) ||
      chunk < 0 ||
      chunk >= totalChunks ||
      packed[chunk] !== -1
    ) {
      throw new RangeError("managed chunk index is invalid");
    }
    packed[chunk] = position;
  }
  return packed;
}

export function managedChunkPackOffset(
  logicalOffset: number,
  chunkBytes: number,
  packed: Int32Array,
): number | undefined {
  const position = packed[Math.floor(logicalOffset / chunkBytes)];
  return position === undefined || position < 0
    ? undefined
    : position * chunkBytes + (logicalOffset % chunkBytes);
}

export function managedReadRunLength(
  offset: number,
  length: number,
  blockBytes: number,
  chunkBytes: number,
  dirty: (block: number) => boolean,
): number {
  const limit = offset + Math.min(length, chunkBytes - (offset % chunkBytes));
  const state = dirty(Math.floor(offset / blockBytes));
  let end = Math.min(limit, offset + blockBytes - (offset % blockBytes));
  while (end < limit && dirty(Math.floor(end / blockBytes)) === state) {
    end = Math.min(limit, end + blockBytes);
  }
  return end - offset;
}

export function managedLeadingPartialLength(
  offset: number,
  length: number,
  blockBytes: number,
): number {
  const lane = offset % blockBytes;
  return lane === 0 ? 0 : Math.min(length, blockBytes - lane);
}

export function managedDirtyBitmapUpdate(
  bitmap: Uint8Array,
  firstBlock: number,
  blocks: number,
): { readonly offset: number; readonly bytes: Uint8Array<ArrayBuffer> } | undefined {
  if (!Number.isInteger(firstBlock) || firstBlock < 0 || !Number.isInteger(blocks) || blocks < 1) {
    throw new RangeError("managed dirty range is invalid");
  }
  const offset = Math.floor(firstBlock / 8);
  const lastByte = Math.floor((firstBlock + blocks - 1) / 8);
  if (lastByte >= bitmap.byteLength) {
    throw new RangeError("managed dirty range is out of bounds");
  }
  const bytes = bitmap.slice(offset, lastByte + 1);
  let changed = false;
  for (let block = firstBlock; block < firstBlock + blocks; block += 1) {
    const index = Math.floor(block / 8) - offset;
    const previous = bytes[index];
    if (previous === undefined) throw new RangeError("managed dirty range is invalid");
    const next = previous | (1 << (block % 8));
    if (next !== previous) {
      bytes[index] = next;
      changed = true;
    }
  }
  return changed ? { offset, bytes } : undefined;
}

export function managedDirtyBitmapRange(
  current: { readonly offset: number; readonly length: number } | undefined,
  offset: number,
  length: number,
): { readonly offset: number; readonly length: number } {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 1
  ) {
    throw new RangeError("managed dirty bitmap range is invalid");
  }
  if (current === undefined) return { offset, length };
  const start = Math.min(current.offset, offset);
  const end = Math.max(current.offset + current.length, offset + length);
  return { offset: start, length: end - start };
}

export function managedSegmentPosition(
  offset: number,
  segmentBytes: number,
): { readonly index: number; readonly offset: number } {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(segmentBytes) ||
    segmentBytes < 1
  ) {
    throw new RangeError("managed segment position is invalid");
  }
  return {
    index: Math.floor(offset / segmentBytes),
    offset: offset % segmentBytes,
  };
}

export function managedSegmentRunLength(
  offset: number,
  length: number,
  segmentBytes: number,
): number {
  const position = managedSegmentPosition(offset, segmentBytes);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("managed segment length is invalid");
  }
  return Math.min(length, segmentBytes - position.offset);
}
