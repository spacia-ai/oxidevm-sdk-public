import { VMError } from "../errors.js";
import { inStorageScope, storageDirectoryName, type StorageScope } from "../storage-scope.js";
import { workspaceLockPrefix } from "../workspace-path.js";
import { acquireLocalDataLock } from "../local-data-lock.js";
export { acquireLocalDataLock } from "../local-data-lock.js";

/**
 * Erases everything `scope` stores. Runs only in a fresh storage worker: no handles or databases
 * from a VM survive into it. Another scope's data, workspaces and leases are left alone.
 */
export async function eraseLocalDataStorage(signal: AbortSignal, scope: StorageScope): Promise<void> {
  const release = await acquireLocalDataLock("exclusive", scope);
  try {
    // Older SDK tabs hold workspace locks but predate the shared origin lease.
    const { held } = await navigator.locks.query();
    const workspaces = workspaceLockPrefix(scope);
    if (held?.some(lock => lock.name?.startsWith(workspaces) === true) === true) {
      throw new VMError("STORAGE_ERROR", "Close other OxideVM tabs, then retry cleanup", { reason: "local-data-in-use" });
    }
    // Enumerate before modifying anything: an incomplete database listing must fail closed.
    if (typeof indexedDB.databases !== "function") {
      throw new VMError("FEATURE_NOT_AVAILABLE", "This browser cannot enumerate local databases for cleanup");
    }
    const databases = await indexedDB.databases();
    for (const database of databases) {
      signal.throwIfAborted();
      if (database.name !== undefined && inStorageScope(scope, database.name)) await deleteDatabase(database.name);
    }
    signal.throwIfAborted();
    if (typeof navigator.storage.getDirectory === "function") await eraseOpfsLocalData(navigator.storage, scope);
    signal.throwIfAborted();
  } finally { await release(); }
}

export async function eraseOpfsLocalData(storage: Pick<StorageManager, "getDirectory">, scope: StorageScope): Promise<void> {
  const name = storageDirectoryName(scope);
  try {
    const root = await storage.getDirectory();
    await root.removeEntry(name, { recursive: true });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw erasureError(error, `OPFS /${name}`);
  }
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    // IndexedDB deletion cannot be cancelled. A prior blocked request can outlive its worker
    // and queue this retry without another `blocked` event. Never leave the UI waiting forever.
    const timeout = setTimeout(() => reject(new VMError("STORAGE_ERROR", `IndexedDB ${name} did not finish cleanup. Close other OxideVM tabs, then retry.`, {
      reason: "local-data-timeout", operation: "erase-local-data", resource: `IndexedDB ${name}`,
    })), 5_000);
    request.onsuccess = () => { clearTimeout(timeout); resolve(); };
    request.onerror = () => { clearTimeout(timeout); reject(erasureError(request.error, `IndexedDB ${name}`)); };
    request.onblocked = () => { clearTimeout(timeout); reject(new VMError("STORAGE_ERROR", "Close other OxideVM tabs, then retry cleanup", {
      reason: "local-data-in-use", operation: "erase-local-data", resource: `IndexedDB ${name}`,
    })); };
  });
}

function erasureError(error: unknown, resource: string): VMError {
  return new VMError("STORAGE_ERROR", `Could not erase ${resource}`, {
    operation: "erase-local-data", resource,
    cause: error instanceof DOMException ? error.name : "StorageFailure",
  });
}
