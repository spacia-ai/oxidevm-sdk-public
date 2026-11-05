import { VMError } from "./errors.js";
import { storageName, type StorageScope } from "./storage-scope.js";

/**
 * VM storage workers and application writers of `scope` share this lease; erasure of the scope is
 * exclusive. Another scope's storage, and its erasure, never wait on it.
 */
export async function acquireLocalDataLock(mode: LockMode, scope: StorageScope): Promise<() => Promise<void>> {
  const held = Promise.withResolvers<undefined>();
  const acquired = Promise.withResolvers<undefined>();
  const completed = navigator.locks.request(storageName(scope, "local-data"), { mode, ifAvailable: true }, async lock => {
    if (lock === null) {
      acquired.reject(new VMError("STORAGE_ERROR", "Close other OxideVM tabs, then retry cleanup", { reason: "local-data-in-use" }));
      return;
    }
    acquired.resolve(undefined);
    await held.promise;
  });
  void completed.catch(acquired.reject);
  await acquired.promise;
  return () => { held.resolve(undefined); return completed; };
}
