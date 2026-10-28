import type { SnapshotCompatibility, SnapshotInfo, SnapshotMachine, SnapshotResumability } from "../protocol.js";
import type { CatalogEntry } from "./snapshot-catalog.js";
import { isZeroChunk, manifestObjects, snapshotMode, USERSPACE_SNAPSHOT_SCHEMA, type SnapshotManifest } from "./snapshot-manifest.js";

const MIB = 1024 * 1024;

/** What a listing compares restore points with: the VM and the browser's image cache. */
export interface ListingContext {
  readonly machine: SnapshotMachine;
  /** The managed profile this VM runs; undefined for a VM booted from its own kernel. */
  readonly image: { readonly id: string } | undefined;
  /** Identities of the managed images whose base is kept in this browser. */
  readonly cachedImages: ReadonlySet<string>;
}

/**
 * Describes catalogue entries in their order. A restore point resumes this VM when it has the
 * VM's memory and vCPUs, runs the same profile (any version whose base is still kept), and its
 * manifest can be read; otherwise `resumable` names the first reason it cannot.
 */
export function describeSnapshots(entries: readonly CatalogEntry[], context: ListingContext): SnapshotInfo[] {
  const owners = objectOwners(entries);
  return entries.map((entry) => "manifest" in entry
    ? describe(entry.manifest, owners, context)
    : {
        mode: entry.identity.mode ?? "system",
        ref: { id: entry.id, createdAt: entry.identity.createdAt },
        kind: entry.identity.kind,
        ...(entry.identity.label === undefined ? {} : { label: entry.identity.label }),
        capturedAtUnixMs: entry.identity.capturedAtUnixMs,
        profile: null,
        bytes: { ram: 0, disk: 0, unique: 0 },
        resumable: damageReason(entry.damaged.detail?.["reason"]),
      });
}

function describe(manifest: SnapshotManifest, owners: ReadonlyMap<string, number>, context: ListingContext): SnapshotInfo {
  const disk = manifest.schema === 2 ? manifest.disk : undefined;
  let diskBytes = 0;
  for (const chunk of disk?.chunks ?? []) if (!isZeroChunk(chunk)) diskBytes += chunk.bytes;
  if (disk?.origin === "core") for (const chunk of disk.base) diskBytes += chunk.bytes;
  let unique = 0;
  for (const [sha256, bytes] of distinctObjects(manifest)) if (owners.get(sha256) === 1) unique += bytes;
  return {
    mode: snapshotMode(manifest),
    ref: { id: manifest.id, createdAt: manifest.createdAt },
    kind: manifest.kind,
    ...(manifest.label === undefined ? {} : { label: manifest.label }),
    capturedAtUnixMs: manifest.capturedAtUnixMs,
    profile: manifest.schema === USERSPACE_SNAPSHOT_SCHEMA ? manifest.rootfs.image : disk?.origin === "managed" ? { id: disk.image.id, version: disk.image.version } : null,
    bytes: { ram: manifest.schema === USERSPACE_SNAPSHOT_SCHEMA ? manifest.payloads.bytes : manifest.ram.reduce((total, chunk) => total + chunk.bytes, 0), disk: manifest.schema === USERSPACE_SNAPSHOT_SCHEMA ? (manifest.durable?.root?.bytes ?? 0) + (manifest.durable?.workspace?.snapshot.bytes ?? 0) + (manifest.durable?.workspace?.delta.bytes ?? 0) : diskBytes, unique },
    resumable: compatibility(manifest, context),
  };
}

/** Whether a readable restore point can run in the VM `context` describes, or the first reason not. */
export function compatibility(manifest: SnapshotManifest, context: ListingContext): SnapshotCompatibility {
  if (snapshotMode(manifest) !== (context.machine.mode ?? "system")) return "runtime-mismatch";
  if (manifest.schema === USERSPACE_SNAPSHOT_SCHEMA) {
    if (manifest.compatibility.memoryBytes !== context.machine.memoryMiB * MIB) return "machine-mismatch";
    if (manifest.rootfs.image.id !== context.image?.id) return "profile-mismatch";
    if (!context.cachedImages.has(manifest.rootfs.rootTreeSha256)) return "base-missing";
    return true;
  }
  const { machine } = manifest;
  if (machine.memoryBytes !== context.machine.memoryMiB * MIB || machine.vcpus !== context.machine.vcpus) {
    return "machine-mismatch";
  }
  const disk = manifest.disk;
  const managed = disk?.origin === "managed" ? disk : undefined;
  if (managed?.image.id !== context.image?.id) return "profile-mismatch";
  if (managed !== undefined && !context.cachedImages.has(managed.baseIdentity)) return "base-missing";
  return true;
}

function damageReason(reason: unknown): Exclude<SnapshotResumability, true> {
  if (reason === "snapshot-older-format") return "older-format";
  if (reason === "snapshot-newer-format") return "newer-format";
  return "corrupt";
}

/** How many readable restore points need each object. */
function objectOwners(entries: readonly CatalogEntry[]): Map<string, number> {
  const owners = new Map<string, number>();
  for (const entry of entries) {
    if (!("manifest" in entry)) continue;
    for (const sha256 of distinctObjects(entry.manifest).keys()) owners.set(sha256, (owners.get(sha256) ?? 0) + 1);
  }
  return owners;
}

function distinctObjects(manifest: SnapshotManifest): Map<string, number> {
  return new Map(manifestObjects(manifest).map((ref) => [ref.sha256, ref.bytes]));
}
