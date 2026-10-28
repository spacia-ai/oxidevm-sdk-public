import { VMError } from "../errors.js";
import { WORKSPACE_LOCK_PREFIX } from "../workspace-path.js";
import { acquireLocalDataLock } from "../local-data-lock.js";
export { acquireLocalDataLock } from "../local-data-lock.js";

/** Runs only in a fresh storage worker. No handles or databases from a VM survive into it. */
export async function eraseLocalDataStorage(signal: AbortSignal): Promise<void> {
  const release = await acquireLocalDataLock("exclusive");
  try {
    // Older SDK tabs hold workspace locks but predate the shared origin lease.
    const { held } = await navigator.locks.query();
    if (held?.some(lock => lock.name?.startsWith(WORKSPACE_LOCK_PREFIX) === true) === true) {
      throw new VMError("STORAGE_ERROR", "Close other OxideVM tabs, then retry cleanup", { reason: "local-data-in-use" });
    }
    // Enumerate before modifying anything: an incomplete database listing must fail closed.
    if (typeof indexedDB.databases !== "function") {
      throw new VMError("FEATURE_NOT_AVAILABLE", "This browser cannot enumerate local databases for cleanup");
    }
    const databases = await indexedDB.databases();
    for (const database of databases) {
      signal.throwIfAborted();
      if (database.name?.startsWith("oxidevm-") === true) await deleteDatabase(database.name);
    }
    signal.throwIfAborted();
    if (typeof navigator.storage.getDirectory === "function") await eraseOpfsLocalData(navigator.storage);
    signal.throwIfAborted();
  } finally { await release(); }
}

export async function eraseOpfsLocalData(storage: Pick<StorageManager, "getDirectory">): Promise<void> {
  try {
    const root = await storage.getDirectory();
    await root.removeEntry("oxidevm", { recursive: true });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw erasureError(error, "OPFS /oxidevm");
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
