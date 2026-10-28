import { normalizeStorageError, VMError } from "../errors.js";
import {
  MANAGED_OVERLAY_SEGMENT_BYTES,
  managedSegmentPosition,
  managedSegmentRunLength,
} from "../managed-disk-state.js";

export async function openDiskSegments(
  directory: FileSystemDirectoryHandle,
  stem: string,
  length: number,
  segmentBytes = MANAGED_OVERLAY_SEGMENT_BYTES,
): Promise<FileSystemSyncAccessHandle[]> {
  const handles: FileSystemSyncAccessHandle[] = [];
  try {
    const count = Math.ceil(length / segmentBytes);
    for (let index = 0; index < count; index++) {
      const name = index === 0 ? `${stem}.img` : `${stem}.${String(index)}.img`;
      const file = await directory.getFileHandle(name, { create: true });
      handles.push(await file.createSyncAccessHandle());
    }
    return handles;
  } catch (error) {
    closeDiskSegments(handles);
    throw error;
  }
}

export function closeDiskSegments(handles: readonly FileSystemSyncAccessHandle[]): void {
  for (const handle of handles) handle.close();
}

export function readSegmented(
  handles: readonly FileSystemSyncAccessHandle[],
  offset: number,
  destination: Uint8Array,
): void {
  let completed = 0;
  while (completed < destination.byteLength) {
    const address = offset + completed;
    const position = managedSegmentPosition(address, MANAGED_OVERLAY_SEGMENT_BYTES);
    const length = managedSegmentRunLength(
      address,
      destination.byteLength - completed,
      MANAGED_OVERLAY_SEGMENT_BYTES,
    );
    const handle = handles[position.index];
    if (handle === undefined) {
      throw new VMError("STORAGE_ERROR", "managed disk segment is missing");
    }
    readInto(
      handle,
      position.offset,
      destination.subarray(completed, completed + length),
    );
    completed += length;
  }
}

export function writeSegmented(
  handles: readonly FileSystemSyncAccessHandle[],
  offset: number,
  source: Uint8Array,
): void {
  let completed = 0;
  while (completed < source.byteLength) {
    const address = offset + completed;
    const position = managedSegmentPosition(address, MANAGED_OVERLAY_SEGMENT_BYTES);
    const length = managedSegmentRunLength(
      address,
      source.byteLength - completed,
      MANAGED_OVERLAY_SEGMENT_BYTES,
    );
    const handle = handles[position.index];
    if (handle === undefined) {
      throw new VMError("STORAGE_ERROR", "managed disk segment is missing");
    }
    writeAll(
      handle,
      position.offset,
      source.subarray(completed, completed + length),
    );
    completed += length;
  }
}

export function markSegmentRange(
  dirty: Set<number>,
  offset: number,
  length: number,
): void {
  if (length === 0) return;
  const first = managedSegmentPosition(offset, MANAGED_OVERLAY_SEGMENT_BYTES).index;
  const last = managedSegmentPosition(
    offset + length - 1,
    MANAGED_OVERLAY_SEGMENT_BYTES,
  ).index;
  for (let index = first; index <= last; index += 1) dirty.add(index);
}

export function flushDirty(
  handles: readonly FileSystemSyncAccessHandle[],
  dirty: ReadonlySet<number>,
): void {
  for (const index of dirty) {
    const handle = handles[index];
    if (handle === undefined) {
      throw new VMError("STORAGE_ERROR", "managed disk segment is missing");
    }
    handle.flush();
  }
}

export function closeCollecting(
  handles: readonly FileSystemSyncAccessHandle[],
  failures: VMError[],
): void {
  for (const handle of handles) {
    try {
      handle.close();
    } catch (error) {
      failures.push(normalizeStorageError(error));
    }
  }
}

export function flushAll(handles: readonly FileSystemSyncAccessHandle[]): void {
  for (const handle of handles) handle.flush();
}

export function readInto(
  handle: FileSystemSyncAccessHandle,
  offset: number,
  destination: Uint8Array,
): void {
  destination.fill(0);
  let completed = 0;
  while (completed < destination.byteLength) {
    const count = handle.read(destination.subarray(completed), {
      at: offset + completed,
    });
    if (count === 0) return;
    completed += count;
  }
}

export function writeAll(
  handle: FileSystemSyncAccessHandle,
  offset: number,
  source: Uint8Array,
): void {
  let completed = 0;
  while (completed < source.byteLength) {
    const remaining = source.byteLength - completed;
    const count = handle.write(source.subarray(completed), {
      at: offset + completed,
    });
    if (!Number.isSafeInteger(count) || count < 1 || count > remaining) {
      throw new VMError(
        "STORAGE_ERROR",
        "managed disk write returned an invalid byte count",
      );
    }
    completed += count;
  }
}

export async function removeIfPresent(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
      throw error;
    }
  }
}
