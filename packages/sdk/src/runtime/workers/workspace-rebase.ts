import type { UserspaceRootfsBlob, UserspaceRootfsEntry } from "../userspace-rootfs.js";
import type { UserspaceWorkspaceConflict } from "../protocol/workspace-start.js";
import { compareWorkspacePaths, sameFileOwnership, type FileOwnership } from "../workspace-record.js";
import type { SnapshotEntry } from "./workspace-delta.js";

// Carries a user's /workspace changes, recorded as a delta against the image they were made on,
// onto another image's /workspace. Paths the user did not change come from the new image; what
// the user changed stays theirs, and a path both changed is reported as a conflict.

const DIRECTORY = 0;
const RESIDENT = 1;
const HOST_FILE = 3;
const HARDLINK = 4;
const WHITEOUT = 5;
const ROOT = "/workspace";

/** One image's /workspace: its entries (paths without the leading slash) and their blobs. */
export interface WorkspaceImage {
  readonly entries: readonly UserspaceRootfsEntry[];
  readonly blobs: readonly UserspaceRootfsBlob[];
}

export interface RebaseInput {
  /** The user's changes against `previous`, in OXWD record order. */
  readonly delta: readonly SnapshotEntry[];
  /** The image the changes were made on; undefined when this browser no longer knows it. */
  readonly previous: WorkspaceImage | undefined;
  readonly next: WorkspaceImage;
  /** Bytes of an earlier image's file this browser still holds, verified by digest. */
  readonly content: (sha256: string, bytes: number) => Promise<Uint8Array<ArrayBuffer> | undefined>;
}

export interface RebaseResult {
  /** The changes to apply over `next`, ordered for replay: whiteouts, then paths parents first. */
  readonly delta: readonly SnapshotEntry[];
  readonly conflicts: readonly UserspaceWorkspaceConflict[];
}

type Content =
  | { readonly kind: "fifo" | "whiteout" }
  | { readonly kind: "directory" }
  | { readonly kind: "file"; readonly sha256: string; readonly bytes: number }
  | { readonly kind: "symlink" | "hardlink"; readonly target: string };

interface Node {
  readonly content: Content;
  readonly mode: number;
  readonly ownership: FileOwnership | undefined;
}

export async function rebaseWorkspaceDelta(input: RebaseInput): Promise<RebaseResult> {
  const previous = input.previous === undefined ? undefined : new Tree(input.previous);
  const next = new Tree(input.next);
  const nextFiles = imageFiles(input.next);
  const conflicts = new Map<string, UserspaceWorkspaceConflict>();
  const conflict = (path: string, reason: UserspaceWorkspaceConflict["reason"]) => { if (!conflicts.has(path)) conflicts.set(path, { reason, path }); };
  const whiteouts = new Map<string, SnapshotEntry>();
  const entries = new Map<string, SnapshotEntry>();

  for (const entry of input.delta) {
    if (entry.tag === WHITEOUT) {
      const remaining = next.subtree(entry.path);
      if (remaining.length === 0) continue;
      if (previous === undefined) conflict(entry.path, "base-unknown");
      else if (!sameSubtree(previous.subtree(entry.path), remaining)) conflict(entry.path, "changed-in-both");
      whiteouts.set(entry.path, entry);
      continue;
    }
    const node = await entryNode(entry);
    const before = previous?.get(entry.path);
    const now = next.get(entry.path);
    // Times alone (an access, a rewrite of the same bytes) are not a change the user made, and a
    // change this image already holds needs nothing.
    if ((before !== undefined && sameNode(node, before)) || (now !== undefined && sameNode(node, now))) continue;
    if (node.content.kind === "directory") {
      if (now !== undefined && now.content.kind !== "directory") imageAlsoChanged(entry.path, node, previous, now, conflict);
      entries.set(entry.path, entry);
      continue;
    }
    imageAlsoChanged(entry.path, node, previous, now, conflict);
    if (entry.tag !== HOST_FILE || nextFiles.get(entry.path) === hostDigest(entry)) { entries.set(entry.path, entry); continue; }
    // A host reference resolves by path in the booted image; elsewhere the bytes must travel along.
    const bytes = await input.content(hostDigest(entry), hostBytes(entry));
    // The user's version could not stay, which outranks any other report for the path.
    if (bytes === undefined) { conflicts.set(entry.path, { reason: "content-unavailable", path: entry.path }); continue; }
    entries.set(entry.path, { ...entry, tag: RESIDENT, payload: bytes });
  }

  const removed = (path: string): boolean => {
    for (let candidate = path; candidate.length > ROOT.length; candidate = parentOf(candidate)) if (whiteouts.has(candidate)) return true;
    return false;
  };
  const exists = (path: string) => path === ROOT || entries.has(path) || (next.get(path) !== undefined && !removed(path));
  for (const [path, entry] of [...entries]) {
    // A file the user put where this image has a directory replaces that directory's tree.
    if (entry.tag !== DIRECTORY && !removed(path) && next.descendants(path).some(child => !removed(child))) {
      conflict(path, "changed-in-both");
      whiteouts.set(path, whiteout(path));
    }
    if (entry.tag === HARDLINK && !exists(text(entry.payload))) {
      conflicts.set(path, { reason: "content-unavailable", path });
      entries.delete(path);
    }
  }
  for (const [path, entry] of [...entries]) {
    // A directory this image dropped still holds what the user kept in it.
    for (let parent = parentOf(path); parent.length > ROOT.length && !exists(parent); parent = parentOf(parent)) {
      conflict(parent, previous === undefined ? "base-unknown" : "changed-in-both");
      entries.set(parent, directoryEntry(parent, previous?.get(parent), entry));
    }
  }
  const byPath = (left: SnapshotEntry, right: SnapshotEntry) => compareWorkspacePaths(left.pathBytes, right.pathBytes);
  return {
    delta: [...[...whiteouts.values()].sort(byPath), ...[...entries.values()].sort(byPath)],
    conflicts: [...conflicts.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  };
}

/** One image's /workspace nodes by absolute path, with subtree queries over its sorted paths. */
class Tree {
  readonly #nodes = new Map<string, Node>();
  readonly #paths: string[];

  constructor(image: WorkspaceImage) {
    const sizes = new Map(image.blobs.map(blob => [blob.sha256, blob.bytes]));
    for (const entry of image.entries) {
      if (entry.path !== "workspace" && !entry.path.startsWith("workspace/")) continue;
      const content: Content = entry.type === "directory" ? { kind: "directory" }
        : entry.type === "file" ? { kind: "file", sha256: entry.blob, bytes: sizes.get(entry.blob) ?? -1 }
        : entry.type === "symlink" ? { kind: "symlink", target: entry.target }
        : { kind: "hardlink", target: `/${entry.target}` };
      this.#nodes.set(`/${entry.path}`, { content, mode: entry.mode, ownership: entry.ownership });
    }
    this.#paths = [...this.#nodes.keys()].sort();
  }

  get(path: string): Node | undefined { return this.#nodes.get(path); }

  /** Paths strictly below `path`: one contiguous run of the sorted paths. */
  descendants(path: string): string[] {
    const prefix = `${path}/`;
    let low = 0;
    let high = this.#paths.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.#paths[middle] ?? "") < prefix) low = middle + 1; else high = middle;
    }
    const found: string[] = [];
    for (let index = low; index < this.#paths.length; index += 1) {
      const candidate = this.#paths[index];
      if (candidate === undefined || !candidate.startsWith(prefix)) break;
      found.push(candidate);
    }
    return found;
  }

  subtree(path: string): [string, Node][] {
    const own = this.#nodes.get(path);
    const below = this.descendants(path).flatMap(child => {
      const node = this.#nodes.get(child);
      return node === undefined ? [] : [[child, node] as [string, Node]];
    });
    return own === undefined ? below : [[path, own], ...below];
  }
}

/** Reports `path` when this image changed it too (or, with no earlier image, simply differs). */
function imageAlsoChanged(path: string, user: Node, previous: Tree | undefined, now: Node | undefined,
  conflict: (path: string, reason: UserspaceWorkspaceConflict["reason"]) => void): void {
  if (previous === undefined) {
    if (now !== undefined && !sameContent(user.content, now.content)) conflict(path, "base-unknown");
    return;
  }
  const before = previous.get(path);
  const changed = before === undefined ? now !== undefined : now === undefined || !sameContent(before.content, now.content) || before.mode !== now.mode;
  if (changed && !(now !== undefined && sameContent(user.content, now.content))) conflict(path, "changed-in-both");
}

/** The digest of each regular file the image serves by path, hardlinked names included. */
function imageFiles(image: WorkspaceImage): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of image.entries) {
    if (entry.type === "file") files.set(`/${entry.path}`, entry.blob);
    else if (entry.type === "hardlink") {
      const target = files.get(`/${entry.target}`);
      if (target !== undefined) files.set(`/${entry.path}`, target);
    }
  }
  return files;
}

async function entryNode(entry: SnapshotEntry): Promise<Node> {
  const content: Content = entry.tag === DIRECTORY ? { kind: "directory" }
    : entry.tag === 6 ? { kind: "fifo" } : entry.tag === 7 ? { kind: "whiteout" }
    : entry.tag === RESIDENT ? { kind: "file", sha256: await sha256(entry.payload), bytes: entry.payload.byteLength }
    : entry.tag === HOST_FILE ? { kind: "file", sha256: hostDigest(entry), bytes: hostBytes(entry) }
    : { kind: entry.tag === HARDLINK ? "hardlink" : "symlink", target: text(entry.payload) };
  return { content, mode: entry.mode, ownership: entry.ownership };
}

function sameNode(left: Node, right: Node): boolean {
  return sameContent(left.content, right.content) && left.mode === right.mode && sameFileOwnership(left.ownership, right.ownership);
}

function sameContent(left: Content, right: Content): boolean {
  if (left.kind === "directory" || right.kind === "directory" || left.kind === "fifo" || right.kind === "fifo" || left.kind === "whiteout" || right.kind === "whiteout") return left.kind === right.kind;
  if (left.kind === "file" || right.kind === "file") return left.kind === "file" && right.kind === "file" && left.sha256 === right.sha256 && left.bytes === right.bytes;
  return left.kind === right.kind && left.target === right.target;
}

function sameSubtree(left: readonly [string, Node][], right: readonly [string, Node][]): boolean {
  if (left.length !== right.length) return false;
  const other = new Map(right);
  return left.every(([path, node]) => {
    const match = other.get(path);
    return match !== undefined && sameContent(node.content, match.content) && node.mode === match.mode;
  });
}

function directoryEntry(path: string, recorded: Node | undefined, child: SnapshotEntry): SnapshotEntry {
  const ownership = recorded?.ownership ?? child.ownership;
  return {
    tag: DIRECTORY, mode: recorded?.content.kind === "directory" ? recorded.mode : 0o755,
    ...(ownership === undefined ? {} : { ownership }),
    ...(child.times === undefined ? {} : { times: child.times }),
    path, pathBytes: new TextEncoder().encode(path), payload: new Uint8Array(),
  };
}

function whiteout(path: string): SnapshotEntry {
  return { tag: WHITEOUT, mode: 0, path, pathBytes: new TextEncoder().encode(path), payload: new Uint8Array() };
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function hostDigest(entry: SnapshotEntry): string {
  return [...entry.payload.subarray(8, 40)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function hostBytes(entry: SnapshotEntry): number {
  return Number(new DataView(entry.payload.buffer, entry.payload.byteOffset, entry.payload.byteLength).getBigUint64(0, true));
}

function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
