import type { StorageScope } from "../storage-scope.js";
import { isEphemeralWorkspaceId, workspaceLockName } from "../workspace-path.js";
import { isNotFound } from "./snapshot-objects.js";

// Ephemeral workspaces: a VM without a workspaceId, or one that `workspaceInUse: "temporary"` moved
// off a workspace another VM held. Disposal removes a VM's own; a tab that closes without disposing
// leaves its workspace behind, and the next VM of the same storage scope removes it.

/** Where a workspace keeps its OPFS data, under its storage scope's directory. */
const STORES = ["workspaces", "workspace-overlays"] as const;

/** Removes a workspace's OPFS directories under its scope's directory `oxidevm`; one already gone is fine. */
export async function removeOpfsWorkspace(oxidevm: FileSystemDirectoryHandle, workspaceId: string): Promise<void> {
  for (const store of STORES) {
    const parent = await existing(oxidevm, store);
    if (parent === undefined) continue;
    try { await parent.removeEntry(workspaceId, { recursive: true }); }
    catch (error: unknown) { if (!isNotFound(error)) throw error; }
  }
}

/**
 * Removes the ephemeral workspaces of `scope` that no VM holds and returns how many. Each is removed
 * while this worker holds its lock, so no VM can open it meanwhile; one a live VM holds is left alone.
 */
export async function sweepEphemeralWorkspaces(oxidevm: FileSystemDirectoryHandle, scope: StorageScope, signal: AbortSignal): Promise<number> {
  const found = new Set<string>();
  for (const store of STORES) {
    const parent = await existing(oxidevm, store);
    if (parent === undefined) continue;
    for await (const name of parent.keys()) if (isEphemeralWorkspaceId(name)) found.add(name);
  }
  let removed = 0;
  for (const workspaceId of found) {
    signal.throwIfAborted();
    const orphaned = await navigator.locks.request(workspaceLockName(scope, workspaceId), { mode: "exclusive", ifAvailable: true }, async lock => {
      if (lock === null) return false;
      await removeOpfsWorkspace(oxidevm, workspaceId);
      return true;
    });
    if (orphaned) removed += 1;
  }
  return removed;
}

async function existing(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | undefined> {
  try { return await parent.getDirectoryHandle(name); }
  catch (error: unknown) { if (isNotFound(error)) return undefined; throw error; }
}
