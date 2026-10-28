import { record } from "../../decode.js";
import { SNAPSHOT_SCHEMA, USERSPACE_SNAPSHOT_SCHEMA } from "../snapshot-manifest.js";
import { backupError } from "./errors.js";

export const BACKUP_FORMAT = "oxidevm-backup";
export const BACKUP_FORMAT_VERSION = 1;

/**
 * Reads the fields every backup version keeps (`format`, `formatVersion` and the restore point's
 * `schema`) before any strict check, so a file that is not a backup, or one a newer or older
 * OxideVM wrote, is reported as that rather than as damaged.
 */
export function checkBackupVersion(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw notBackup();
  const manifest = record(value, "backup manifest");
  if (manifest["format"] !== BACKUP_FORMAT) throw notBackup();
  const version = manifest["formatVersion"];
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw backupError("damaged", "the backup's format version is invalid");
  }
  if (version > BACKUP_FORMAT_VERSION) throw newer();
  if (version < BACKUP_FORMAT_VERSION) throw older();
  const snapshot = manifest["snapshot"];
  const schema: unknown = typeof snapshot === "object" && snapshot !== null && "schema" in snapshot ? snapshot.schema : undefined;
  if (typeof schema === "number" && Number.isSafeInteger(schema)) {
    if (schema > USERSPACE_SNAPSHOT_SCHEMA) throw newer();
    if (schema < SNAPSHOT_SCHEMA) throw older();
  }
  return manifest;
}

function notBackup(): Error {
  return backupError("wrong-file", "this file is not an OxideVM backup");
}

function newer(): Error {
  return backupError("newer", "this backup needs a newer OxideVM");
}

function older(): Error {
  return backupError("older", "this backup is from an older OxideVM");
}
