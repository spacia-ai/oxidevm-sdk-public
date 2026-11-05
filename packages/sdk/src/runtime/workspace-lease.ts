import type { StorageScope } from "./storage-scope.js";
import { workspaceIsFree } from "./workspace-handoff.js";
import { isWorkspaceInUse } from "./workspace-path.js";

/**
 * Opens a VM with `open(false)` on its durable workspace `workspaceId`, or with `open(true)` on a
 * new temporary workspace when another VM of `storage` holds it, in this tab or another
 * (`workspaceInUse: "temporary"`). The lock is checked first, and the durable open falls back once
 * more when the VM's storage worker finds the workspace taken: another tab took it in between.
 * Any other failure is the caller's.
 */
export async function openDurableOrTemporary<T>(storage: StorageScope, workspaceId: string, open: (temporary: boolean) => Promise<T>): Promise<T> {
  if (!await workspaceIsFree(storage, workspaceId)) return open(true);
  try {
    return await open(false);
  } catch (error: unknown) {
    if (!isWorkspaceInUse(error)) throw error;
    return open(true);
  }
}
