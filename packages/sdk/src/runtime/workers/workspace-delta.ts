import { compareWorkspacePaths, sameFileOwnership, sameFileTimes, type FileOwnership, type FileTimes } from "../workspace-record.js";
import { decodeFilesystemRecord, encodeFilesystemRecord, type RootfsMetadataEntry } from "../userspace-rootfs-record.js";
import type {
  UserspaceRootfsBlob,
  UserspaceRootfsEntry,
} from "../userspace-rootfs.js";

/** One record of a workspace snapshot (OXRF) or delta (OXWD). */
export interface SnapshotEntry {
  readonly tag: number;
  readonly mode: number;
  readonly ownership?: FileOwnership;
  readonly times?: FileTimes;
  readonly metadata?: Uint8Array<ArrayBuffer>;
  readonly path: string;
  readonly pathBytes: Uint8Array<ArrayBuffer>;
  readonly payload: Uint8Array<ArrayBuffer>;
}

export async function buildWorkspaceDelta(
  snapshot: Uint8Array<ArrayBuffer>,
  baseEntries: readonly UserspaceRootfsEntry[],
  baseBlobs: readonly UserspaceRootfsBlob[],
): Promise<Uint8Array<ArrayBuffer>> {
  const target = decodeSnapshot(snapshot);
  const targetByPath = new Map(target.map((entry) => [entry.path, entry]));
  const blobs = new Map(baseBlobs.map((blob) => [blob.sha256, blob]));
  const base = new Map(baseEntries
    .filter((entry) => entry.path === "workspace" || entry.path.startsWith("workspace/"))
    .map((entry) => [`/${entry.path}`, entry]));
  const changed: SnapshotEntry[] = [];
  for (const entry of target) {
    if (!await matchesBase(entry, base.get(entry.path), blobs)) changed.push(entry);
  }
  const missing = [...base.keys()]
    .filter((path) => path !== "/workspace" && !targetByPath.has(path))
    .sort(comparePathDepth);
  const tombstones: SnapshotEntry[] = [];
  for (const path of missing) {
    if (tombstones.some((entry) => path.startsWith(`${entry.path}/`))) continue;
    tombstones.push({
      tag: 5,
      mode: 0,
      path,
      pathBytes: new TextEncoder().encode(path),
      payload: new Uint8Array(),
    });
  }
  return encodeDelta([...tombstones, ...changed]);
}

export function mergeWorkspaceDeltas(
  existing: Uint8Array<ArrayBuffer>,
  incremental: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const merged = new Map(decodeDelta(existing).map((entry) => [entry.path, entry]));
  for (const entry of decodeDelta(incremental)) {
    if (entry.tag === 5) {
      if ([...merged.values()].some((current) => current.tag === 5 && isAncestor(current.path, entry.path))) {
        continue;
      }
      for (const path of merged.keys()) {
        if (path === entry.path || isAncestor(entry.path, path)) merged.delete(path);
      }
      merged.set(entry.path, entry);
      continue;
    }
    for (const [path, current] of merged) {
      if (path === entry.path || (isAncestor(path, entry.path) && current.tag !== 0)) {
        merged.delete(path);
      } else if (entry.tag !== 0 && isAncestor(entry.path, path)) {
        merged.delete(path);
      }
    }
    merged.set(entry.path, entry);
  }
  return encodeDelta([...merged.values()].sort(compareEntries));
}

async function matchesBase(
  entry: SnapshotEntry,
  base: UserspaceRootfsEntry | undefined,
  blobs: ReadonlyMap<string, UserspaceRootfsBlob>,
): Promise<boolean> {
  if (entry.metadata !== undefined || base === undefined || entry.mode !== base.mode || !sameFileOwnership(entry.ownership, base.ownership)) return false;
  if (entry.times !== undefined && !sameFileTimes(entry.times, base.times ?? { accessNs: "0", modificationNs: "0" })) return false;
  if (entry.tag === 0) return base.type === "directory" && entry.payload.byteLength === 0;
  if (entry.tag === 2) {
    return base.type === "symlink"
      && new TextDecoder("utf-8", { fatal: true }).decode(entry.payload) === base.target;
  }
  if (entry.tag === 4) {
    return base.type === "hardlink"
      && new TextDecoder("utf-8", { fatal: true }).decode(entry.payload) === `/${base.target}`;
  }
  if (base.type !== "file") return false;
  const blob = blobs.get(base.blob);
  if (blob === undefined) return false;
  if (entry.tag === 3) {
    return entry.payload.byteLength === 40
      && readU64(entry.payload, 0) === BigInt(blob.bytes)
      && hex(entry.payload.subarray(8)) === blob.sha256;
  }
  return entry.tag === 1
    && entry.payload.byteLength === blob.bytes
    && await sha256(entry.payload) === blob.sha256;
}

/** Decodes an OXRF workspace snapshot strictly. */
export function decodeSnapshot(snapshot: Uint8Array<ArrayBuffer>): SnapshotEntry[] {
  return decodeFilesystemRecord(snapshot, "snapshot").map(snapshotEntry);
}

export function decodeDelta(delta: Uint8Array<ArrayBuffer>): SnapshotEntry[] {
  return decodeFilesystemRecord(delta, "delta").map(snapshotEntry);
}

function snapshotEntry(entry: RootfsMetadataEntry): SnapshotEntry {
  return { tag: entry.tag, mode: entry.mode, path: entry.pathText, pathBytes: entry.path, payload: entry.payload,
    ...(entry.ownership === undefined ? {} : { ownership: entry.ownership }),
    ...(entry.times === undefined ? {} : { times: entry.times }),
    ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }) };
}

/** Ownership and inode metadata choose their exact versioned entry layout. */
export function encodeDelta(entries: readonly SnapshotEntry[]): Uint8Array<ArrayBuffer> {
  return encodeFilesystemRecord(entries.map(entry => ({ ...entry, path: entry.pathBytes, pathText: entry.path })), "delta");
}

function isAncestor(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`);
}

function compareEntries(left: SnapshotEntry, right: SnapshotEntry): number {
  const kind = entryOrder(left.tag) - entryOrder(right.tag);
  return kind || comparePathDepth(left.path, right.path);
}

function entryOrder(tag: number): number {
  if (tag === 0) return 0;
  if (tag === 4) return 2;
  if (tag === 5) return 3;
  return 1;
}

function comparePathDepth(left: string, right: string): number {
  return left.split("/").length - right.split("/").length || compareWorkspacePaths(new TextEncoder().encode(left), new TextEncoder().encode(right));
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
