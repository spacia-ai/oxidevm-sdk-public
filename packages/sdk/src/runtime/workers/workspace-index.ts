import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { compareWorkspacePaths, type FileOwnership, sameFileOwnership, type FileTimes, decodeFileTimes, sameFileTimes, validateWorkspaceMetadata } from "../workspace-record.js";
import { hex, sha256Hex } from "./snapshot-content.js";
import { decodeSnapshot, type SnapshotEntry } from "./workspace-delta.js";

const FORMAT_VERSION = 4;
/**
 * Each runtime keeps its own /workspace root (System's capture records it, Userspace leaves
 * it out); only what is inside it moves between them.
 */
const WORKSPACE_ROOT = "/workspace";
const MAX_ENTRIES = 1_000_000;
const SHA256 = /^[0-9a-f]{64}$/u;

/** One path of a workspace as the store held it at a synchronized generation. */
export interface WorkspaceIndexEntry {
  readonly kind: "directory" | "file" | "symlink" | "hardlink" | "fifo" | "whiteout";
  readonly mode: number;
  readonly ownership?: FileOwnership;
  readonly times?: FileTimes;
  readonly metadataSha256?: string;
  /** A file's content SHA-256 (hex), a link's target, or empty for a directory. */
  readonly identity: string;
}

/**
 * The workspace a restore point's guest last matched, without its content: each path's kind,
 * mode and content identity. A resume compares it with the store's current snapshot to find
 * what changed in the store since (`workspaceChanges`).
 */
export type WorkspaceIndex = ReadonlyMap<string, WorkspaceIndexEntry>;

/** A path the store changed since an index's generation, with the store's entry now. */
export interface WorkspaceChange {
  readonly path: string;
  /** The path at the indexed generation; null when it did not exist. */
  readonly ancestor: WorkspaceIndexEntry | null;
  /** The store's entry now, payload included; null when the store removed the path. */
  readonly current: SnapshotEntry | null;
}

/** What a resumed guest needs from the workspace store since its restore point was saved. */
export type WorkspacePlan =
  /** The restore point recorded no workspace (another kind of boot, or the store was unreadable). */
  | { readonly kind: "unrecorded" }
  | { readonly kind: "in-sync" }
  | { readonly kind: "changed"; readonly generation: number; readonly changes: readonly WorkspaceChange[] };

export async function indexWorkspaceSnapshot(snapshot: Uint8Array<ArrayBuffer>): Promise<WorkspaceIndex> {
  const index = new Map<string, WorkspaceIndexEntry>();
  for (const entry of decodeSnapshot(snapshot)) index.set(entry.path, await indexEntry(entry));
  return index;
}

/** The store's changes since `ancestor`, ordered by path. */
export async function workspaceChanges(
  ancestor: WorkspaceIndex,
  current: Uint8Array<ArrayBuffer>,
): Promise<WorkspaceChange[]> {
  const changes: WorkspaceChange[] = [];
  const seen = new Set<string>();
  for (const entry of decodeSnapshot(current)) {
    if (entry.path === WORKSPACE_ROOT && entry.metadata === undefined) continue;
    seen.add(entry.path);
    const before = ancestor.get(entry.path);
    if (before === undefined || !sameIndexEntry(before, await indexEntry(entry))) {
      changes.push({ path: entry.path, ancestor: before ?? null, current: entry });
    }
  }
  for (const [path, before] of ancestor) {
    if (path !== WORKSPACE_ROOT && !seen.has(path)) changes.push({ path, ancestor: before, current: null });
  }
  const encoder = new TextEncoder();
  return changes.sort((left, right) => compareWorkspacePaths(encoder.encode(left.path), encoder.encode(right.path)));
}

export function sameIndexEntry(left: WorkspaceIndexEntry, right: WorkspaceIndexEntry): boolean {
  return left.kind === right.kind
    && left.mode === right.mode
    && left.identity === right.identity
    && left.metadataSha256 === right.metadataSha256
    && sameFileOwnership(left.ownership, right.ownership)
    && sameFileTimes(left.times, right.times);
}

/** A snapshot entry's kind, mode and content identity; inline bytes hash to their SHA-256. */
export async function indexEntry(entry: SnapshotEntry): Promise<WorkspaceIndexEntry> {
  const identity = entry.tag === 1 ? await sha256Hex(entry.payload)
    : entry.tag === 3 ? hex(entry.payload.subarray(8, 40))
    : entry.tag === 0 || entry.tag === 6 || entry.tag === 7 ? ""
    : new TextDecoder("utf-8", { fatal: true }).decode(entry.payload);
  const kind = entry.tag === 0 ? "directory" : entry.tag === 2 ? "symlink" : entry.tag === 4 ? "hardlink" : entry.tag === 6 ? "fifo" : entry.tag === 7 ? "whiteout" : "file";
  return { kind, mode: entry.mode, ...(entry.ownership === undefined ? {} : { ownership: entry.ownership }), identity,
    ...(entry.times === undefined ? {} : { times: entry.times }),
    ...(entry.metadata === undefined ? {} : { metadataSha256: await sha256Hex(entry.metadata) }) };
}

/** Format 3 distinguishes both historical format-2 layouts without losing metadata. */
export function encodeWorkspaceIndex(index: WorkspaceIndex): Uint8Array<ArrayBuffer> {
  const entries = [...index].map(([path, entry]) => [
    path,
    entry.kind,
    entry.mode,
    entry.identity,
    entry.ownership ?? null,
    entry.times ?? null,
    entry.metadataSha256 ?? null,
  ]);
  const version = entries.some(row => row[1] === "whiteout") ? FORMAT_VERSION : 3;
  return new TextEncoder().encode(JSON.stringify({ formatVersion: version, entries }));
}

/** Decodes a workspace index strictly; it may come from an imported backup. */
export function decodeWorkspaceIndex(bytes: Uint8Array): WorkspaceIndex {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid();
  }
  const fields = record(document, "workspace index");
  exactKeys(fields, ["formatVersion", "entries"]);
  const version = fields["formatVersion"];
  if (version !== 1 && version !== 2 && version !== 3 && version !== FORMAT_VERSION) invalid();
  const entries: unknown = fields["entries"];
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) invalid();
  const rows: readonly unknown[] = entries;
  const index = new Map<string, WorkspaceIndexEntry>();
  for (const value of rows) {
    if (!Array.isArray(value) || (version === 1 ? value.length !== 4 && value.length !== 6 : version === 2 ? value.length !== 6 && value.length !== 7 : value.length !== 7)) invalid();
    const row: readonly unknown[] = value;
    const rich = version >= 3 || version === 2 && row.length === 7;
    const objectOwner = version >= 3 || version === 2 && row.length === 6;
    const path = string(row[0], "workspace index path");
    const kind = row[1];
    if (kind !== "directory" && kind !== "file" && kind !== "symlink" && kind !== "hardlink" && !(rich && kind === "fifo") && !(version >= 4 && kind === "whiteout")) invalid();
    const mode = integer(row[2], "workspace index mode", 0, 0o7777);
    const identity = string(row[3], "workspace index identity");
    if (path !== WORKSPACE_ROOT && !path.startsWith("/workspace/") || path.split("/").slice(1).some(part => part === "" || part === "." || part === ".." || part.includes("\0"))
      || index.has(path) || (kind === "file" && !SHA256.test(identity))
      || ((kind === "directory" || kind === "fifo" || kind === "whiteout") && identity !== "")) invalid();
    const ownership = objectOwner ? row[4] === null ? undefined : decodeOwnership(row[4]) : row.length >= 6 && !(rich && row[4] === null && row[5] === null)
      ? { uid: integer(row[4], "workspace index uid", 0, 0xffff_fffe), gid: integer(row[5], "workspace index gid", 0, 0xffff_fffe) }
      : undefined;
    const times = objectOwner && row[5] !== null ? decodeFileTimes(row[5]) : undefined;
    const metadataSha256 = rich && row[6] !== null ? string(row[6], "workspace metadata hash") : undefined;
    if (metadataSha256 !== undefined && !SHA256.test(metadataSha256)) invalid();
    index.set(path, { kind, mode, ...(ownership === undefined ? {} : { ownership }), ...(times === undefined ? {} : { times }),
      ...(metadataSha256 === undefined ? {} : { metadataSha256 }), identity });
  }
  return index;
}

/** Decodes a workspace plan received over the snapshot channel strictly. */
export function decodeWorkspacePlan(value: unknown): WorkspacePlan {
  const plan = record(value, "workspace plan");
  const kind = plan["kind"];
  if (kind === "unrecorded" || kind === "in-sync") {
    exactKeys(plan, ["kind"]);
    return { kind };
  }
  if (kind !== "changed") invalidPlan();
  exactKeys(plan, ["kind", "generation", "changes"]);
  const changes: unknown = plan["changes"];
  if (!Array.isArray(changes) || changes.length > MAX_ENTRIES) invalidPlan();
  const list: readonly unknown[] = changes;
  return { kind, generation: integer(plan["generation"], "workspace generation", 1), changes: list.map(decodeChange) };
}

function decodeChange(value: unknown): WorkspaceChange {
  const change = record(value, "workspace change");
  exactKeys(change, ["path", "ancestor", "current"]);
  const path = string(change["path"], "workspace change path");
  if (path !== WORKSPACE_ROOT && !path.startsWith("/workspace/")) invalidPlan();
  const current = change["current"] === null ? null : decodePlanEntry(change["current"], path);
  if (path === WORKSPACE_ROOT && current?.tag !== 0) invalidPlan();
  return {
    path,
    ancestor: change["ancestor"] === null ? null : decodePlanIndexEntry(change["ancestor"]),
    current,
  };
}

function decodePlanIndexEntry(value: unknown): WorkspaceIndexEntry {
  const entry = record(value, "workspace index entry");
  exactKeys(entry, ["kind", "mode", "identity"], ["ownership", "times", "metadataSha256"]);
  const kind = entry["kind"];
  if (kind !== "directory" && kind !== "file" && kind !== "symlink" && kind !== "hardlink" && kind !== "fifo" && kind !== "whiteout") invalidPlan();
  const identity = string(entry["identity"], "workspace identity");
  if ((kind === "file" && !SHA256.test(identity)) || ((kind === "directory" || kind === "fifo" || kind === "whiteout") && identity !== "")) invalidPlan();
  const ownership = entry["ownership"] === undefined ? undefined : decodeOwnership(entry["ownership"]);
  const metadataSha256 = entry["metadataSha256"] === undefined ? undefined : string(entry["metadataSha256"], "workspace metadata hash");
  if (metadataSha256 !== undefined && !SHA256.test(metadataSha256)) invalidPlan();
  return {
    kind,
    mode: integer(entry["mode"], "workspace mode", 0, 0o7777),
    ...(ownership === undefined ? {} : { ownership }),
    ...(entry["times"] === undefined ? {} : { times: decodeFileTimes(entry["times"]) }),
    ...(metadataSha256 === undefined ? {} : { metadataSha256 }),
    identity,
  };
}

function decodePlanEntry(value: unknown, path: string): SnapshotEntry {
  const entry = record(value, "workspace entry");
  exactKeys(entry, ["tag", "mode", "path", "pathBytes", "payload"], ["ownership", "times", "metadata"]);
  const pathBytes = entry["pathBytes"];
  const payload = entry["payload"];
  if (entry["path"] !== path || !(pathBytes instanceof Uint8Array) || !(payload instanceof Uint8Array)
    || new TextDecoder().decode(pathBytes) !== path) invalidPlan();
  const ownership = entry["ownership"] === undefined ? undefined : decodeOwnership(entry["ownership"]);
  const metadata = entry["metadata"];
  if (metadata !== undefined && !(metadata instanceof Uint8Array)) invalidPlan();
  if (metadata !== undefined) validateWorkspaceMetadata(metadata);
  if (metadata !== undefined && entry["times"] !== undefined) invalidPlan();
  const tag = integer(entry["tag"], "workspace entry tag", 0, 7);
  if (tag === 5 || (tag === 0 || tag === 6 || tag === 7) && payload.length !== 0) invalidPlan();
  return {
    tag,
    mode: integer(entry["mode"], "workspace mode", 0, 0o7777),
    ...(ownership === undefined ? {} : { ownership }),
    ...(entry["times"] === undefined ? {} : { times: decodeFileTimes(entry["times"]) }),
    ...(metadata === undefined ? {} : { metadata: metadata.slice() }),
    path,
    pathBytes: pathBytes.slice(),
    payload: payload.slice(),
  };
}

function decodeOwnership(value: unknown): FileOwnership {
  const ownership = record(value, "workspace ownership");
  exactKeys(ownership, ["uid", "gid"]);
  return {
    uid: integer(ownership["uid"], "workspace uid", 0, 0xffff_fffe),
    gid: integer(ownership["gid"], "workspace gid", 0, 0xffff_fffe),
  };
}

function invalidPlan(): never {
  throw new VMError("PROTOCOL_ERROR", "a workspace plan is invalid");
}

function invalid(): never {
  throw new VMError("STORAGE_ERROR", "a restore point's workspace index is invalid", { reason: "snapshot-damaged" });
}
