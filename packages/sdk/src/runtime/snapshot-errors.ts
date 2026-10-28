import { VMError } from "./errors.js";

/** The words a page shows for each backup refusal, by its stable reason (ADR 0014 R10). */
const BACKUP_REASONS: Readonly<Record<string, string>> = {
  "backup-wrong-file": "This file isn't an OxideVM backup.",
  "backup-damaged": "This backup is damaged or incomplete.",
  "backup-newer": "This backup needs a newer version of OxideVM.",
  "backup-older": "This backup is from an older version of OxideVM and can't be opened.",
  "backup-other-environment": "This backup belongs to another environment.",
  "backup-no-space": "There isn't enough space in this browser.",
};

/** A restore point or backup failure in plain words a page can show as they are. */
export function describeSnapshotError(error: unknown): string {
  if (!(error instanceof VMError)) return "Something went wrong. Try again.";
  const reason = error.detail?.["reason"];
  const described = typeof reason === "string" ? BACKUP_REASONS[reason] : undefined;
  if (described !== undefined) return described;
  if (error.code === "QUOTA_EXCEEDED") return "There isn't enough space in this browser.";
  if (error.code === "ABORTED") return "Cancelled.";
  return "Something went wrong. Try again.";
}
