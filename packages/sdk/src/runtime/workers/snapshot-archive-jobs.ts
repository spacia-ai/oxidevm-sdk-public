import type { BackupDestination } from "../../backup-destination.js";
import { normalizeStorageError, VMError } from "../errors.js";
import { backupFileName } from "../backup-file-name.js";
import type { BackupExportResult, BackupInspection, SnapshotCompatibility, SnapshotInfo, SnapshotRef } from "../protocol.js";
import { backupError, isBackupError } from "./snapshot-archive/errors.js";
import { backupObjectsOf } from "./snapshot-archive/manifest.js";
import { readBackup } from "./snapshot-archive/reader.js";
import { writeBackup } from "./snapshot-archive/writer.js";
import { validateBackupRootfs } from "./snapshot-archive/rootfs.js";
import { USERSPACE_SNAPSHOT_SCHEMA } from "./snapshot-manifest.js";
import type { SnapshotImport } from "./snapshot-import.js";
import { isNotFound } from "./snapshot-objects.js";
import type { SnapshotStore } from "./snapshot-store.js";

const MIB = 1024 * 1024;
/** Progress reaches the page at most this often. */
const PROGRESS_INTERVAL_MILLISECONDS = 100;

/** How an archive job runs inside the storage worker. */
export interface ArchiveRun {
  /** Runs `turn` as one turn of the storage queue, between other requests. */
  readonly enqueue: <T>(turn: () => Promise<T>) => Promise<T>;
  readonly signal: AbortSignal;
  readonly now: () => number;
  /** Hears progress at most ten times a second, and when the job's bytes are all done. */
  readonly progress?: (completedBytes: number, totalBytes: number) => void;
}

/** Where an export writes: a file the user picked, or a staged file the page then downloads. */
export type ExportTarget =
  | { readonly kind: "handle"; readonly handle: BackupDestination }
  | { readonly kind: "staged"; readonly directory: FileSystemDirectoryHandle };


/**
 * Writes a backup of restore point `snapshot` to `target` (ADR 0014 R10), reading one object per
 * storage-queue turn. A cancel or failure leaves no file behind: a picked file keeps what it held
 * and a staged file is removed.
 */
export async function exportBackup(
  store: SnapshotStore,
  snapshot: SnapshotRef,
  target: ExportTarget,
  run: ArchiveRun,
): Promise<BackupExportResult> {
  const source = await run.enqueue(() => store.openExport(snapshot));
  try {
    const totalBytes = backupObjectsOf(source.manifest).reduce((total, ref) => total + ref.bytes, 0);
    const report = throttled(run);
    let completedBytes = 0;
    const sink = await openSink(target, backupFileName(source.manifest));
    try {
      await writeBackup(source.manifest, async (ref) => {
        throwIfCancelled(run.signal);
        const content = await run.enqueue(() => source.read(ref));
        completedBytes += ref.bytes;
        report(completedBytes, totalBytes);
        return content;
      }, (bytes) => sink.write(bytes));
      throwIfCancelled(run.signal);
      return await sink.close();
    } catch (error) {
      await sink.abort();
      throw error;
    }
  } finally {
    source.release();
  }
}

/**
 * Imports a backup file as a new restore point (kind "imported", a fresh id), storing one object
 * per storage-queue turn. It refuses a backup this VM could not run before storing anything. Only
 * the browser refusing a write means there is no room, never its own figure for free space, which
 * Brave keeps at 2 GiB whatever it allows. A cancel or failure leaves no restore point, and the
 * next collection reclaims what it stored.
 */
export async function importBackup(store: SnapshotStore, file: Blob, run: ArchiveRun): Promise<SnapshotInfo> {
  const report = throttled(run);
  let readBytes = 0;
  const counted = file.stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      readBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }));
  const entries = readBackup(counted, { nowUnixMs: run.now() });
  let transaction: SnapshotImport | undefined;
  try {
    const first = await entries.next();
    if (first.done === true || first.value.kind !== "manifest") throw backupError("wrong-file", "this file is not an OxideVM backup");
    const { snapshot } = first.value.manifest;
    throwIfCancelled(run.signal);
    const compatible = await run.enqueue(() => store.compatibility(snapshot));
    if (compatible !== true) throw otherEnvironment(compatible);
    const opened = await run.enqueue(() => store.beginImport(snapshot));
    transaction = opened;
    for await (const entry of entries) {
      throwIfCancelled(run.signal);
      if (entry.kind === "object" && opened.needs(entry.ref)) await run.enqueue(() => opened.put(entry.ref, entry.content));
      report(readBytes, file.size);
    }
    throwIfCancelled(run.signal);
    const committed = await run.enqueue(() => opened.commit());
    const listed = (await run.enqueue(() => store.list())).find((info) => info.ref.id === committed.id);
    if (listed === undefined) throw new VMError("STORAGE_NOT_FOUND", "the imported restore point was not found");
    return listed;
  } catch (error) {
    await transaction?.abort();
    throw importFailure(error);
  } finally {
    await entries.return(undefined);
  }
}

/** Reads the snapshot and embedded rootfs compatibility; stores nothing. */
export async function inspectBackup(store: SnapshotStore, file: Blob, nowUnixMs: number,signal?:AbortSignal): Promise<BackupInspection> {
  if(signal!==undefined)throwIfCancelled(signal);
  const source=signal===undefined?file.stream():file.stream().pipeThrough(new TransformStream<Uint8Array,Uint8Array>(),{signal});
  const entries = readBackup(source, { nowUnixMs });
  try {
    const first = await entries.next();
    if (first.done === true || first.value.kind !== "manifest") throw backupError("wrong-file", "this file is not an OxideVM backup");
    const snapshot = first.value.manifest.snapshot;
    if(snapshot.schema===USERSPACE_SNAPSHOT_SCHEMA){
      let checked=false;
      for await(const entry of entries){
        if(signal!==undefined)throwIfCancelled(signal);
        if(entry.kind==="object"&&entry.ref.sha256===snapshot.rootfs.manifest.sha256){validateBackupRootfs(entry.content,snapshot);checked=true;break;}
      }
      if(!checked)throw backupError("damaged","the backup is missing its rootfs manifest");
    }
    const disk = snapshot.schema === 2 ? snapshot.disk : undefined;
    return {
      mode: snapshot.schema === 2 ? "system" : "userspace",
      kind: snapshot.kind,
      ...(snapshot.label === undefined ? {} : { label: snapshot.label }),
      capturedAtUnixMs: snapshot.capturedAtUnixMs,
      profile: snapshot.schema === USERSPACE_SNAPSHOT_SCHEMA ? snapshot.rootfs.image : disk?.origin === "managed" ? { id: disk.image.id, version: disk.image.version } : null,
      machine: snapshot.schema === USERSPACE_SNAPSHOT_SCHEMA ? { memoryMiB: snapshot.compatibility.memoryBytes / MIB, vcpus: 1 } : { memoryMiB: snapshot.machine.memoryBytes / MIB, vcpus: snapshot.machine.vcpus },
      fileBytes: file.size,
      compatible: await store.compatibility(snapshot),
    };
  } catch(error) {
    if(signal!==undefined)throwIfCancelled(signal);
    throw error;
  } finally {
    await entries.return(undefined);
  }
}

/** Removes every staged export: one export is staged at a time, and none outlives a session. */
export async function clearStagedExports(directory: FileSystemDirectoryHandle): Promise<void> {
  const names: string[] = [];
  for await (const name of directory.keys()) names.push(name);
  for (const name of names) {
    await directory.removeEntry(name).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

interface ExportSink {
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<BackupExportResult>;
  abort(): Promise<void>;
}

async function openSink(target: ExportTarget, suggestedName: string): Promise<ExportSink> {
  let written = 0;
  if (target.kind === "handle") {
    const writable = await target.handle.createWritable({ keepExistingData: false });
    return {
      write: async (bytes) => {
        await writable.write(bytes);
        written += bytes.byteLength;
      },
      close: async () => {
        await writable.close();
        return { kind: "written", bytes: written };
      },
      abort: () => writable.abort().catch(() => undefined),
    };
  }
  await clearStagedExports(target.directory);
  const handle = await target.directory.getFileHandle(suggestedName, { create: true });
  const access = await handle.createSyncAccessHandle();
  let open = true;
  const release = (): void => {
    if (!open) return;
    open = false;
    access.close();
  };
  return {
    write: (bytes) => {
      if (access.write(bytes, { at: written }) !== bytes.byteLength) {
        return Promise.reject(new VMError("STORAGE_ERROR", "a backup was written short"));
      }
      written += bytes.byteLength;
      return Promise.resolve();
    },
    close: async () => {
      access.flush();
      release();
      return { kind: "file", file: await handle.getFile(), suggestedName };
    },
    abort: async () => {
      release();
      await target.directory.removeEntry(suggestedName).catch(() => undefined);
    },
  };
}

/** Reports progress at most every 100 ms, and always when the bytes are all done. */
function throttled(run: ArchiveRun): (completedBytes: number, totalBytes: number) => void {
  let reportedAt = -Infinity;
  return (completedBytes, totalBytes) => {
    const now = run.now();
    if (completedBytes < totalBytes && now - reportedAt < PROGRESS_INTERVAL_MILLISECONDS) return;
    reportedAt = now;
    run.progress?.(completedBytes, totalBytes);
  };
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new VMError("ABORTED", "the backup was cancelled");
}

function otherEnvironment(compatible: Exclude<SnapshotCompatibility, true>): VMError {
  return backupError("other-environment", "this backup belongs to another environment", { compatible });
}

/** A failure in the terms a backup's user sees: its own reasons, or space, or another environment. */
function importFailure(error: unknown): unknown {
  if (isBackupError(error) || (error instanceof VMError && error.code === "ABORTED")) return error;
  const normalized = normalizeStorageError(error);
  if (normalized.code === "QUOTA_EXCEEDED") return backupError("no-space", "there is not enough space in this browser to open the backup");
  if (normalized.detail?.["reason"] === "base-missing") return otherEnvironment("base-missing");
  return normalized;
}
