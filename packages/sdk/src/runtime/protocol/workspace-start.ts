import { exactKeys, integer, protocolError, record, string } from "../decode.js";

/**
 * How a Userspace VM's saved /workspace met the image it booted, in System's words:
 * `in-sync` when nothing was saved or it was saved on this image, `reconciled` when it was saved on
 * another image and carried onto this one without conflict, `conflict-preserved` otherwise.
 */
export type UserspaceWorkspaceState = "in-sync" | "reconciled" | "conflict-preserved";

/** A path the reconciliation could not carry over cleanly. Paths are absolute, under /workspace. */
export interface UserspaceWorkspaceConflict {
  /**
   * `changed-in-both`: the user changed it and this image changed it too; the user's version
   * stayed. `base-unknown`: the user's version differs from this image's and the image it was
   * saved on is no longer known here, so it stayed. `content-unavailable`: the user's version
   * named a file of the earlier image that is no longer available; this image's version stayed and
   * the save was preserved.
   */
  readonly reason: "changed-in-both" | "base-unknown" | "content-unavailable";
  readonly path: string;
}

/**
 * Why the saved workspace was kept aside. `unreadable`: its records are missing, corrupt or in a
 * format this SDK cannot read, and this image's /workspace booted instead. `unreplayable`: it could
 * not be applied to this image, which booted clean. `base-unavailable`: it was saved as a whole
 * tree on another image this browser no longer knows, so it could not be reconciled and this
 * image's /workspace booted. `content-unavailable`: see the conflicts of that reason; the rest of
 * the save was carried over.
 */
export type PreservedWorkspaceReason = "unreadable" | "unreplayable" | "base-unavailable" | "content-unavailable";

export interface UserspaceWorkspaceStart {
  readonly state: UserspaceWorkspaceState;
  /** At most {@link MAX_REPORTED_CONFLICTS}; `omittedConflicts` counts the rest. */
  readonly conflicts: readonly UserspaceWorkspaceConflict[];
  readonly omittedConflicts: number;
  /** Set when the earlier save was kept, unchanged, under this id in the workspace's overlay store. */
  readonly preserved?: { readonly id: string; readonly reason: PreservedWorkspaceReason };
}

export const MAX_REPORTED_CONFLICTS = 256;
const MAX_PATH_BYTES = 4096;
const CONFLICT_REASONS = ["changed-in-both", "base-unknown", "content-unavailable"] as const;
const PRESERVED_REASONS = ["unreadable", "unreplayable", "base-unavailable", "content-unavailable"] as const;
const PRESERVED_ID = /^(?:[1-9][0-9]{0,8}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

export const IN_SYNC_WORKSPACE: UserspaceWorkspaceStart = { state: "in-sync", conflicts: [], omittedConflicts: 0 };

/** The bounded report of a reconciliation that found `conflicts` and may have kept the save aside. */
export function workspaceStart(
  reconciled: boolean,
  conflicts: readonly UserspaceWorkspaceConflict[],
  preserved?: UserspaceWorkspaceStart["preserved"],
): UserspaceWorkspaceStart {
  const state = conflicts.length !== 0 || preserved !== undefined ? "conflict-preserved" : reconciled ? "reconciled" : "in-sync";
  return {
    state,
    conflicts: conflicts.slice(0, MAX_REPORTED_CONFLICTS),
    omittedConflicts: Math.max(0, conflicts.length - MAX_REPORTED_CONFLICTS),
    ...(preserved === undefined ? {} : { preserved }),
  };
}

export function decodeUserspaceWorkspaceStart(value: unknown): UserspaceWorkspaceStart {
  const input = record(value, "Userspace workspace start");
  exactKeys(input, ["state", "conflicts", "omittedConflicts"], ["preserved"]);
  const state = input["state"];
  if (state !== "in-sync" && state !== "reconciled" && state !== "conflict-preserved") throw protocolError("Userspace workspace state is invalid");
  const conflicts = input["conflicts"];
  if (!Array.isArray(conflicts) || conflicts.length > MAX_REPORTED_CONFLICTS) throw protocolError("Userspace workspace conflicts must be a bounded array");
  const decoded = conflicts.map((item: unknown) => {
    const conflict = record(item, "Userspace workspace conflict");
    exactKeys(conflict, ["reason", "path"]);
    return { reason: oneOf(conflict["reason"], CONFLICT_REASONS, "conflict reason"), path: workspacePath(conflict["path"]) };
  });
  const omittedConflicts = integer(input["omittedConflicts"], "omitted workspace conflicts", 0, 0x7fff_ffff);
  let preserved: UserspaceWorkspaceStart["preserved"];
  if (input["preserved"] !== undefined) {
    const value = record(input["preserved"], "preserved workspace");
    exactKeys(value, ["id", "reason"]);
    const id = string(value["id"], "preserved workspace id");
    if (!PRESERVED_ID.test(id)) throw protocolError("preserved workspace id is invalid");
    preserved = { id, reason: oneOf(value["reason"], PRESERVED_REASONS, "preserved workspace reason") };
  }
  if ((state === "conflict-preserved") !== (decoded.length !== 0 || preserved !== undefined) || (omittedConflicts !== 0 && decoded.length !== MAX_REPORTED_CONFLICTS)) {
    throw protocolError("Userspace workspace state contradicts its conflicts");
  }
  return { state, conflicts: decoded, omittedConflicts, ...(preserved === undefined ? {} : { preserved }) };
}

function workspacePath(value: unknown): string {
  const path = string(value, "conflict path");
  if ((path !== "/workspace" && !path.startsWith("/workspace/")) || path.includes("\0") || new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES) {
    throw protocolError("conflict path must be under /workspace");
  }
  return path;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const match = allowed.find(item => item === value);
  if (match === undefined) throw protocolError(`${label} is invalid`);
  return match;
}
