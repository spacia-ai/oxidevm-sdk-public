import { VMError } from "../../errors.js";
import { exactKeys } from "../../decode.js";
import {
  decodeSnapshotManifest,
  encodeSnapshotManifest,
  MAX_MANIFEST_BYTES,
  manifestObjects,
  type ObjectRef,
  type SnapshotManifest,
} from "../snapshot-manifest.js";
import { backupError, isBackupError } from "./errors.js";
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, checkBackupVersion } from "./versions.js";

/** The manifest wraps a stored restore point's manifest, which is at most 4 MiB. */
export const MAX_BACKUP_MANIFEST_BYTES = MAX_MANIFEST_BYTES + 1024;
export const MAX_BACKUP_FILE_BYTES = 16 * 1024 * 1024 * 1024;
/** How much larger than its content a stored (gzipped) object may be. */
export const MAX_STORED_OVERHEAD_BYTES = 64 * 1024;
/** No genuine restore point was captured before this. */
const EARLIEST_CAPTURE_UNIX_MS = Date.UTC(2020, 0, 1);
/** How far ahead of this browser's clock another browser's clock may have been. */
const CLOCK_SKEW_MILLISECONDS = 24 * 3_600_000;

/** `manifest.json`, the first file of a backup (format v1, ADR 0014 R10). */
export interface BackupManifest {
  readonly snapshot: SnapshotManifest;
  /** The objects the file carries after the manifest, in this order; see `backupObjectsOf`. */
  readonly objects: readonly ObjectRef[];
}

/**
 * The objects a backup of `snapshot` carries, sorted by hash: every object the restore point
 * references, except a managed image's kernel and initrd, which the importing browser takes from
 * that image instead. Refuses two references that give one hash two sizes.
 */
export function backupObjectsOf(snapshot: SnapshotManifest): ObjectRef[] {
  const external = new Set<string>();
  if (snapshot.schema === 2 && snapshot.disk?.origin === "managed") {
    external.add(snapshot.assets.kernel.sha256);
    if (snapshot.assets.initrd !== undefined) external.add(snapshot.assets.initrd.sha256);
  }
  const objects = new Map<string, ObjectRef>();
  for (const ref of manifestObjects(snapshot)) {
    if (external.has(ref.sha256)) continue;
    const known = objects.get(ref.sha256);
    if (known !== undefined && known.bytes !== ref.bytes) {
      throw backupError("damaged", "a restore point gives one object two sizes");
    }
    objects.set(ref.sha256, { sha256: ref.sha256, bytes: ref.bytes });
  }
  return [...objects.values()].sort((left, right) => (left.sha256 < right.sha256 ? -1 : 1));
}

/** Canonical bytes: fixed key order and no whitespace, so the same restore point always reads the same. */
export function encodeBackupManifest(snapshot: SnapshotManifest): Uint8Array<ArrayBuffer> {
  const encoded = new TextDecoder().decode(encodeSnapshotManifest(snapshot));
  return new TextEncoder().encode(
    `{"format":${JSON.stringify(BACKUP_FORMAT)},"formatVersion":${String(BACKUP_FORMAT_VERSION)},"snapshot":${encoded}}`,
  );
}

/**
 * Decodes `manifest.json`: first whether it is a backup and of which version, then strictly. A
 * refusal says why: backup-wrong-file, backup-newer, backup-older or backup-damaged.
 */
export function decodeBackupManifest(bytes: Uint8Array, nowUnixMs: number): BackupManifest {
  if (bytes.byteLength > MAX_BACKUP_MANIFEST_BYTES) throw backupError("damaged", "the backup's description is too large");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw backupError("wrong-file", "this file is not an OxideVM backup");
  }
  const manifest = checkBackupVersion(value);
  try {
    exactKeys(manifest, ["format", "formatVersion", "snapshot"]);
    const snapshot = decodeSnapshotManifest(manifest["snapshot"]);
    checkCaptureTime(snapshot, nowUnixMs);
    return { snapshot, objects: backupObjectsOf(snapshot) };
  } catch (error) {
    if (isBackupError(error)) throw error;
    if (error instanceof VMError && error.code === "SNAPSHOT_VERSION") {
      if (error.detail?.["reason"] === "snapshot-newer-format") throw backupError("newer", "this backup needs a newer OxideVM");
      if (error.detail?.["reason"] === "snapshot-older-format") throw backupError("older", "this backup is from an older OxideVM");
    }
    throw backupError("damaged", "the backup's description is invalid");
  }
}

/** Capture and save times must fall between 2020 and a day past this browser's clock. */
function checkCaptureTime(snapshot: SnapshotManifest, nowUnixMs: number): void {
  const latest = nowUnixMs + CLOCK_SKEW_MILLISECONDS;
  for (const time of [snapshot.capturedAtUnixMs, Date.parse(snapshot.createdAt)]) {
    if (!(time >= EARLIEST_CAPTURE_UNIX_MS && time <= latest)) {
      throw backupError("damaged", "the backup's capture time is impossible");
    }
  }
}
