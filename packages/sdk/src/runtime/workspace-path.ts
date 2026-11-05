import { VMError } from "./errors.ts";
import { storageName, type StorageScope } from "./storage-scope.ts";
import { TextEncoder } from "./web-encoding.ts";

const WORKSPACE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const EPHEMERAL_WORKSPACE_ID = /^ephemeral_[0-9a-f]{32}$/u;

export function validateWorkspaceId(workspaceId: string): string {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) {
    throw new VMError(
      "INVALID_ARGUMENT",
      "workspaceId must contain only letters, numbers, '_' or '-'",
    );
  }
  return workspaceId;
}

/** A workspace ID no durable workspace uses: `ephemeral_` and 32 random hex digits. */
export function newEphemeralWorkspaceId(): string {
  return `ephemeral_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Whether `workspaceId` is one `newEphemeralWorkspaceId` makes. */
export function isEphemeralWorkspaceId(workspaceId: string): boolean {
  return EPHEMERAL_WORKSPACE_ID.test(workspaceId);
}

/** The Web Lock a VM's storage worker holds while the VM uses `workspaceId` of `scope`. */
export function workspaceLockName(scope: StorageScope, workspaceId: string): string {
  return `${workspaceLockPrefix(scope)}${workspaceId}`;
}

/** The start of every workspace lock name of `scope`. */
export function workspaceLockPrefix(scope: StorageScope): string {
  return storageName(scope, "workspace-");
}

/** Opening `workspaceId` failed because another VM, in this tab or another, holds its lock. */
export function workspaceInUseError(workspaceId: string): VMError {
  return new VMError(
    "STORAGE_ERROR",
    `workspace "${workspaceId}" is already open in another tab or VM; dispose that VM, ask it to hand the workspace over, or open a temporary workspace with workspaceInUse: "temporary"`,
    { reason: "workspace-in-use" },
  );
}

export function isWorkspaceInUse(error: unknown): boolean {
  return error instanceof VMError && error.code === "STORAGE_ERROR" && error.detail?.["reason"] === "workspace-in-use";
}

export function normalizeWorkspacePath(path: string): string[] {
  if (
    typeof path !== "string" ||
    path.includes("\0") ||
    path.includes("\\")
  ) {
    throw new VMError("INVALID_ARGUMENT", "invalid workspace path");
  }
  const segments = path.split("/").filter(Boolean);
  const encoder = new TextEncoder();
  if (encoder.encode(`/${segments.join("/")}`).byteLength > 4_095
    || segments.some((segment) => encoder.encode(segment).byteLength > 255)) {
    throw new VMError("INVALID_ARGUMENT", "workspace path exceeds Linux path limits");
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new VMError(
      "INVALID_ARGUMENT",
      "workspace path cannot traverse its root",
    );
  }
  return segments;
}
