import { VMError } from "../../errors.js";
import type { AgentWorkspaceManifestEntry } from "../../agent-protocol.js";
import { sameFileOwnership, sameWorkspaceMetadata } from "../../workspace-record.js";
import type { ResumedWorkspace, SnapshotRef } from "../../protocol.js";
import type { SnapshotStorageClient } from "../snapshot-channel.js";
import { encodeDelta, type SnapshotEntry } from "../workspace-delta.js";
import { decodeWorkspacePlan, type WorkspaceChange, type WorkspaceIndexEntry } from "../workspace-index.js";

/** Where a resume keeps the guest's copy of a file the store changed differently. */
export const CONFLICTS_ROOT = "/var/lib/oxidevm/conflicts";
const WORKSPACE = "/workspace";
const TOMBSTONE = 5;

/** The guest-agent operations a reconciliation uses. */
export interface ReconcileAgent {
  readonly readEntry: (path: string) => Promise<Pick<AgentWorkspaceManifestEntry, "kind" | "mode" | "ownership" | "metadata"> | undefined>;
  /** The guest's bytes at a /workspace-relative path ("/src/app.ts"); undefined when absent. */
  readonly readFile: (path: string) => Promise<Uint8Array<ArrayBuffer> | undefined>;
  readonly applyDelta: (delta: Uint8Array<ArrayBuffer>) => Promise<void>;
  /** Writes a copy at an absolute guest path outside /workspace. */
  readonly keepConflict: (target: string, content: Uint8Array<ArrayBuffer>) => Promise<void>;
}

/**
 * Brings a resumed guest's /workspace up to date with the workspace store: the store's changes
 * since `snapshot` was saved, which a Userspace session made, are carried into the guest.
 */
export async function reconcileRestoredWorkspace(
  storage: SnapshotStorageClient,
  agent: ReconcileAgent,
  snapshot: SnapshotRef,
): Promise<ResumedWorkspace> {
  const plan = decodeWorkspacePlan(await storage.request({ type: "plan-workspace", snapshot }));
  if (plan.kind !== "changed") return { workspace: "in-sync", unresolved: [] };
  return reconcileWorkspace(agent, snapshot.id, plan.changes);
}

/** The guest command that writes a kept copy, taken from stdin, creating its directory. */
export function conflictCommand(target: string): readonly [string, ...string[]] {
  return ["sh", "-c", 'mkdir -p -- "${1%/*}" && exec cat > "$1"', "sh", target];
}

/**
 * Carries the store's changes since a restore point's workspace generation into the resumed
 * guest. The store wins: its version replaces the guest's, except that a guest copy that also
 * changed since that generation goes to `/var/lib/oxidevm/conflicts/<snapshot>/` first, outside
 * /workspace. Paths only the guest changed are not touched, and directories are created but
 * never removed, so files the guest added inside them stay.
 */
export async function reconcileWorkspace(
  agent: ReconcileAgent,
  snapshotId: string,
  changes: readonly WorkspaceChange[],
): Promise<ResumedWorkspace> {
  const apply: SnapshotEntry[] = [];
  const unresolved: string[] = [];
  let kept = 0;
  for (const change of changes) {
    const decision = await decide(agent, change);
    if (decision.keep !== undefined) {
      await agent.keepConflict(`${CONFLICTS_ROOT}/${snapshotId}${relative(change.path)}`, decision.keep);
      kept += 1;
    }
    if (decision.apply !== undefined) apply.push(decision.apply);
    if (decision.unresolved) unresolved.push(change.path);
  }
  if (apply.length !== 0) await agent.applyDelta(encodeDelta(apply));
  if (kept !== 0 || unresolved.length !== 0) return { workspace: "conflict-preserved", unresolved };
  // A store that only gained what the guest holds changed nothing the page should mention.
  return { workspace: apply.length === 0 ? "in-sync" : "reconciled", unresolved };
}

interface Decision {
  readonly apply?: SnapshotEntry;
  readonly keep?: Uint8Array<ArrayBuffer>;
  readonly unresolved?: true;
}

async function decide(agent: ReconcileAgent, { path, ancestor, current }: WorkspaceChange): Promise<Decision> {
  if (current === null && ancestor?.kind === "directory") return {};
  const guestEntry = await agent.readEntry(relative(path));
  if (await guestMetadataChanged(guestEntry, ancestor, current)) return { unresolved: true };
  if (current?.tag === 0) return { apply: current };
  const guestKind = guestEntry?.kind;
  const guest = guestKind === "file" ? await agent.readFile(relative(path)) : undefined;
  const guestIdentity = guest === undefined ? undefined : await sha256Hex(guest);
  const target = current === null ? undefined : await contentIdentity(current);
  if (current === null && guestKind === undefined) return {};
  if (current !== null && target !== undefined && target === guestIdentity) {
    if (current.times !== undefined) return { apply: current.tag === 3 && guest !== undefined ? { ...current, tag: 1, payload: guest } : current };
    if (guestEntry === undefined || !sameMetadata(guestEntry, current)) {
      return { apply: current.tag === 3 && guest !== undefined ? { ...current, tag: 1, payload: guest } : current };
    }
    return {};
  }
  const guestChanged = ancestor === null ? guestKind !== undefined
    : ancestor.kind === "file" ? guestIdentity !== ancestor.identity
    : guestKind !== undefined && guestKind !== ancestor.kind;
  // A base reference or hardlink names content the guest must already hold; it carries none.
  if (current !== null && (current.tag === 3 || current.tag === 4)) return { unresolved: true };
  const keep = guestChanged && guest !== undefined ? { keep: guest } : {};
  return { ...keep, apply: current ?? tombstone(path) };
}

function sameMetadata(guest: NonNullable<Awaited<ReturnType<ReconcileAgent["readEntry"]>>>, current: SnapshotEntry): boolean {
  return guest.mode === current.mode && sameFileOwnership(guest.ownership, current.ownership)
    && sameWorkspaceMetadata(guest.metadata, current.metadata);
}

async function guestMetadataChanged(
  guest: Awaited<ReturnType<ReconcileAgent["readEntry"]>>,
  ancestor: WorkspaceIndexEntry | null,
  current: SnapshotEntry | null,
): Promise<boolean> {
  if (guest === undefined || current !== null && sameMetadata(guest, current)) return false;
  if (ancestor === null) return guest.metadata !== undefined || current !== null
    && (guest.mode !== current.mode || !sameFileOwnership(guest.ownership, current.ownership));
  if (guest.mode !== ancestor.mode || ancestor.ownership !== undefined && !sameFileOwnership(guest.ownership, ancestor.ownership)) return true;
  if (ancestor.metadataSha256 !== undefined) return guest.metadata === undefined
    || await sha256Hex(guest.metadata) !== ancestor.metadataSha256;
  // A legacy index cannot prove that rich guest metadata still matches its ancestor.
  return guest.metadata !== undefined;
}

/** A file record's content SHA-256; undefined for a link, whose target is not file content. */
async function contentIdentity(entry: SnapshotEntry): Promise<string | undefined> {
  if (entry.tag === 3) return hex(entry.payload.subarray(8, 40));
  return entry.tag === 1 ? sha256Hex(entry.payload) : undefined;
}

function tombstone(path: string): SnapshotEntry {
  return { tag: TOMBSTONE, mode: 0, path, pathBytes: new TextEncoder().encode(path), payload: new Uint8Array() };
}

function relative(path: string): string {
  if (path !== WORKSPACE && !path.startsWith(`${WORKSPACE}/`)) {
    throw new VMError("PROTOCOL_ERROR", "a workspace change is outside /workspace");
  }
  return path.slice(WORKSPACE.length) || "/";
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
