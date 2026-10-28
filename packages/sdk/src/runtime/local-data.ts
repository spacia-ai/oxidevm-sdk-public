import { storageResponseDecoders, type StorageOperations } from "./protocol.js";
import { WorkerClient } from "./worker-client.js";
import { exactKeys, record } from "./decode.js";
import { VMError } from "./errors.js";
import { acquireLocalDataLock } from "./local-data-lock.js";

/** Protect application-owned editor/settings/cache writers too. Release when they stop. */
export function acquireLocalDataLease(): Promise<() => Promise<void>> {
  return acquireLocalDataLock("shared");
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
  if (signal?.aborted === true) throw new VMError("ABORTED", "Local data erasure was aborted");
  const storage = new WorkerClient<StorageOperations>(
    new Worker(new URL("./workers/storage.worker.js", import.meta.url), { type: "module", name: "oxidevm-local-data-reset" }),
    storageResponseDecoders,
  );
  try { await storage.request("erase-local-data", undefined, { signal }); }
  finally { storage.terminate(); }
}
