import { storageResponseDecoders, type StorageOperations } from "./protocol.js";
import { WorkerClient } from "./worker-client.js";
import { exactKeys, record } from "./decode.js";
import { VMError } from "./errors.js";
import { acquireLocalDataLock } from "./local-data-lock.js";
import { encodeStorageScope, ORIGIN_STORAGE, type StorageScope } from "./storage-scope.js";

/** Protect application-owned editor/settings/cache writers too. Release when they stop. */
export function acquireLocalDataLease(): Promise<() => Promise<void>> {
  return acquireLocalDataLock("shared", ORIGIN_STORAGE);
}

/**
 * Erase all OxideVM workspaces, restore points, images and IndexedDB stores on this origin.
 * Dispose every VM first. An active workspace in another tab makes this fail before erasure.
 * Applications must stop their own writers and clear their preferences/caches separately.
 */
export async function eraseLocalData(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
  const input = record(options, "local data erasure options");
  exactKeys(input, [], ["signal"]);
  const signal = input["signal"];
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new VMError("INVALID_ARGUMENT", "signal must be an AbortSignal");
  return eraseStorageScope(ORIGIN_STORAGE, signal);
}

/**
 * Erases what `scope` stores, from a fresh storage worker. The runtime frame erases only the scope
 * of the page that embeds it; other pages' workspaces, and any VM of theirs, are left alone.
 */
export async function eraseStorageScope(scope: StorageScope, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new VMError("ABORTED", "Local data erasure was aborted");
  const storage = new WorkerClient<StorageOperations>(
    new Worker(new URL("./workers/storage.worker.js", import.meta.url), { type: "module", name: "oxidevm-local-data-reset" }),
    storageResponseDecoders,
  );
  try { await storage.request("erase-local-data", encodeStorageScope(scope), { signal }); }
  finally { storage.terminate(); }
}
