import { VMError } from "./errors.ts";
import { TextEncoder } from "./web-encoding.ts";

const WORKSPACE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
export const WORKSPACE_LOCK_PREFIX = "oxidevm-workspace-";

export function validateWorkspaceId(workspaceId: string): string {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) {
    throw new VMError(
      "INVALID_ARGUMENT",
      "workspaceId must contain only letters, numbers, '_' or '-'",
    );
  }
  return workspaceId;
}

/** The Web Lock a VM's storage worker holds while the VM uses `workspaceId`. */
export function workspaceLockName(workspaceId: string): string {
  return `${WORKSPACE_LOCK_PREFIX}${workspaceId}`;
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
