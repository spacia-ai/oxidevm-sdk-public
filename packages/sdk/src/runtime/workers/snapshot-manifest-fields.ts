import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { SNAPSHOT_KINDS, type SnapshotKind } from "../protocol/snapshots.js";
import { isManagedImageName } from "../managed-image-ref.js";
import type { ObjectRef } from "./snapshot-manifest.js";
export const MAX_LABEL_BYTES = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function decodeObjectRef(value: unknown, minimum: number, maximum: number): ObjectRef {
  const ref = record(value, "snapshot object reference");
  if (!Object.hasOwn(ref, "index")) exactKeys(ref, ["sha256", "bytes"]);
  return {
    sha256: decodeHash(ref["sha256"]),
    bytes: integer(ref["bytes"], "snapshot object bytes", minimum, maximum),
  };
}

export function decodeImageName(value: unknown): string {
  const name = string(value, "snapshot image name");
  if (!isManagedImageName(name)) invalidManifest();
  return name;
}

export function decodeKind(value: unknown): SnapshotKind {
  const kind = SNAPSHOT_KINDS.find((candidate) => candidate === value);
  return kind ?? invalidManifest();
}

export function decodeLabel(value: unknown): string {
  const label = string(value, "snapshot label");
  if (new TextEncoder().encode(label).byteLength > MAX_LABEL_BYTES) invalidManifest();
  return label;
}

export function decodeParent(value: unknown): string | null {
  if (value === null) return null;
  const parent = string(value, "parent snapshot id");
  if (!UUID.test(parent)) invalidManifest();
  return parent;
}

export function decodeHash(value: unknown): string {
  const hash = string(value, "SHA-256");
  if (!/^[0-9a-f]{64}$/.test(hash)) invalidManifest();
  return hash;
}

export function invalidManifest(): never {
  throw new VMError("STORAGE_ERROR", "snapshot manifest is invalid", { reason: "snapshot-damaged" });
}
