import { VMError } from "../../errors.js";
import type { ObjectRef, SnapshotManifest } from "../snapshot-manifest.js";
import { gzip } from "./gzip.js";
import { backupObjectsOf, encodeBackupManifest } from "./manifest.js";
import { tarEnd, tarHeader, tarPadding } from "./tar.js";

/** The name of the backup's first file. */
export const MANIFEST_NAME = "manifest.json";

/** The name of the file that holds the object with `sha256`. */
export function chunkName(sha256: string): string {
  return `chunks/${sha256}.gz`;
}

/**
 * Writes a backup of `snapshot` (ADR 0014 R10): `manifest.json`, then each object it carries
 * gzipped, in hash order, then the end marker. `read` supplies each object's verified content and
 * `write` takes the bytes in order. One engine always writes the same bytes for one restore point.
 */
export async function writeBackup(
  snapshot: SnapshotManifest,
  read: (ref: ObjectRef) => Promise<Uint8Array<ArrayBuffer>>,
  write: (bytes: Uint8Array<ArrayBuffer>) => Promise<void>,
): Promise<void> {
  await writeFile(write, MANIFEST_NAME, encodeBackupManifest(snapshot));
  for (const ref of backupObjectsOf(snapshot)) {
    const content = await read(ref);
    if (content.byteLength !== ref.bytes) {
      throw new VMError("STORAGE_ERROR", "a restore point object has the wrong size", { reason: "snapshot-damaged" });
    }
    await writeFile(write, chunkName(ref.sha256), await gzip(content));
  }
  await write(tarEnd());
}

async function writeFile(
  write: (bytes: Uint8Array<ArrayBuffer>) => Promise<void>,
  name: string,
  data: Uint8Array<ArrayBuffer>,
): Promise<void> {
  await write(tarHeader(name, data.byteLength));
  await write(data);
  const padding = tarPadding(data.byteLength);
  if (padding.byteLength !== 0) await write(padding);
}
