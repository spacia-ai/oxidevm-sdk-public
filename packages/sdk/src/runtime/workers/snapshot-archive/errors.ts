import { VMError, type VMErrorCode } from "../../errors.js";

/** Why a backup file was refused, in the terms its user sees (ADR 0014 R10). */
export type BackupProblem = "wrong-file" | "newer" | "older" | "damaged" | "other-environment" | "no-space";

const CODES: Readonly<Record<BackupProblem, VMErrorCode>> = {
  "wrong-file": "INVALID_ARGUMENT",
  newer: "SNAPSHOT_VERSION",
  older: "SNAPSHOT_VERSION",
  damaged: "INVALID_ARGUMENT",
  "other-environment": "INVALID_ARGUMENT",
  "no-space": "QUOTA_EXCEEDED",
};

/** A refusal whose stable reason is `backup-<problem>`. */
export function backupError(
  problem: BackupProblem,
  message: string,
  detail: Readonly<Record<string, unknown>> = {},
): VMError {
  return new VMError(CODES[problem], message, { ...detail, reason: `backup-${problem}` });
}

/** Whether `error` is already a backup refusal. */
export function isBackupError(error: unknown): error is VMError {
  if (!(error instanceof VMError)) return false;
  const reason = error.detail?.["reason"];
  return typeof reason === "string" && reason.startsWith("backup-");
}
