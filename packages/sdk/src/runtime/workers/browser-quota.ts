import type { SnapshotUsage } from "../protocol.js";

/** Space reserved for the running guest's durable writes. */
export const DISK_RESERVE_BYTES = 256 * 1024 * 1024;

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
