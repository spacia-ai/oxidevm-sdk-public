import type { SnapshotUsage } from "../protocol.js";
import { VMError } from "../errors.js";

/** Space reserved for the running guest's durable writes. */
export const DISK_RESERVE_BYTES = 256 * 1024 * 1024;

/** Whether the browser refused a write for lack of space. */
export function refusedForSpace(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "QuotaExceededError")
    || (error instanceof VMError && error.code === "QUOTA_EXCEEDED");
}

/**
 * Whether the browser refused to store a file write. Besides a quota refusal, Chromium ends a writable stream's
 * write with AbortError ("Failed to write data to data pipe") when it closes the write's data pipe; hosted-runner
 * captures show it only at the origin's limit, at the same usage where other writes get QuotaExceededError.
 */
export function refusedWrite(error: unknown): boolean {
  return refusedForSpace(error) || (error instanceof DOMException && error.name === "AbortError");
}

/** The parts of the browser's `StorageManager` a usage report reads. */
export interface QuotaReader {
  estimate(): Promise<{ readonly usage?: number; readonly quota?: number }>;
  persisted(): Promise<boolean>;
}

/**
 * The browser's storage estimate and persistence for this origin; each is null where the browser
 * does not report it or refuses to.
 */
export async function readBrowserQuota(
  manager: QuotaReader | undefined,
): Promise<Pick<SnapshotUsage, "estimate" | "persisted">> {
  let estimate: SnapshotUsage["estimate"] = null;
  try {
    const reported = await manager?.estimate();
    if (reported?.usage !== undefined && reported.quota !== undefined) {
      estimate = { usage: Math.floor(reported.usage), quota: Math.floor(reported.quota) };
    }
  } catch {
    estimate = null;
  }
  let persisted: boolean | null;
  try {
    persisted = manager === undefined ? null : await manager.persisted();
  } catch {
    persisted = null;
  }
  return { estimate, persisted };
}
