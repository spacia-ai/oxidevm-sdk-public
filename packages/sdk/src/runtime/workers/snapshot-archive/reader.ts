import { VMError } from "../../errors.js";
import { sha256Hex } from "../snapshot-content.js";
import type { ObjectRef } from "../snapshot-manifest.js";
import { backupError, isBackupError } from "./errors.js";
import { gunzipExact } from "./gzip.js";
import {
  type BackupManifest,
  decodeBackupManifest,
  MAX_BACKUP_FILE_BYTES,
  MAX_BACKUP_MANIFEST_BYTES,
  MAX_STORED_OVERHEAD_BYTES,
} from "./manifest.js";
import { readTar } from "./tar.js";
import { chunkName, MANIFEST_NAME } from "./writer.js";

const BLOCK_BYTES = 512;

export interface BackupReadOptions {
  /** This browser's clock, which bounds the capture time. */
  readonly nowUnixMs: number;
  /** The largest file to read (16 GiB unless smaller). */
  readonly maxFileBytes?: number;
}

/** What a backup holds, in file order: its manifest, then each object's verified content. */
export type BackupEntry =
  | { readonly kind: "manifest"; readonly manifest: BackupManifest }
  | { readonly kind: "object"; readonly ref: ObjectRef; readonly content: Uint8Array<ArrayBuffer> };

/**
 * Reads a backup from `source`: the manifest first, decoded before anything after it is read, so
 * a consumer can refuse a backup before any chunk; then each object the manifest names, in hash
 * order, decompressed to exactly its size and checked against its hash. A refusal is a backup
 * error: backup-wrong-file until the first file proves to be a backup's manifest, then
 * backup-newer, backup-older or backup-damaged.
 */
export async function* readBackup(
  source: ReadableStream<Uint8Array>,
  options: BackupReadOptions,
): AsyncGenerator<BackupEntry, void, undefined> {
  const maxFileBytes = Math.min(options.maxFileBytes ?? MAX_BACKUP_FILE_BYTES, MAX_BACKUP_FILE_BYTES);
  let manifest: BackupManifest | undefined;
  let named = false;
  let next = 0;
  /** The bytes read so far, counting the end marker the archive must still hold. */
  let fileBytes = 2 * BLOCK_BYTES;
  const files = readTar(source, (name) => {
    // The largest data whose header and padding still fit in the file limit.
    const remaining = Math.floor((maxFileBytes - fileBytes - BLOCK_BYTES) / BLOCK_BYTES) * BLOCK_BYTES;
    if (manifest === undefined) {
      if (name !== MANIFEST_NAME) throw notBackup();
      named = true;
      return Math.min(MAX_BACKUP_MANIFEST_BYTES, remaining);
    }
    const expected = manifest.objects[next];
    if (expected === undefined || name !== chunkName(expected.sha256)) {
      throw backupError("damaged", "the backup holds a file it should not, or out of order");
    }
    return Math.min(expected.bytes + MAX_STORED_OVERHEAD_BYTES, remaining);
  });
  try {
    for await (const file of files) {
      fileBytes += BLOCK_BYTES + Math.ceil(file.data.byteLength / BLOCK_BYTES) * BLOCK_BYTES;
      if (manifest === undefined) {
        manifest = decodeBackupManifest(file.data, options.nowUnixMs);
        yield { kind: "manifest", manifest };
        continue;
      }
      const ref = manifest.objects[next];
      if (ref === undefined) throw backupError("damaged", "the backup holds a file it should not");
      const content = await gunzipExact(file.data, ref.bytes);
      if ((await sha256Hex(content)) !== ref.sha256) {
        throw backupError("damaged", "a backup chunk does not hold what its name says");
      }
      next += 1;
      yield { kind: "object", ref, content };
    }
  } catch (error) {
    throw readFailure(error, named);
  }
  if (manifest === undefined) throw notBackup();
  if (next !== manifest.objects.length) throw backupError("damaged", "the backup is missing chunks");
}

/** A refusal in backup terms: a broken archive is a wrong file until its manifest is named. */
function readFailure(error: unknown, named: boolean): VMError {
  if (isBackupError(error)) return error;
  if (error instanceof VMError && error.detail?.["reason"] === "tar-invalid") {
    return named ? backupError("damaged", "the backup is damaged or incomplete", { problem: error.detail["problem"] }) : notBackup();
  }
  return backupError("damaged", "the backup could not be read to its end");
}

function notBackup(): VMError {
  return backupError("wrong-file", "this file is not an OxideVM backup");
}
