import { VMError } from "./errors.js";

const LOCAL_DATA_LOCK = "oxidevm-local-data";

/** VM storage workers and application writers share this lease; erasure is exclusive. */
export async function acquireLocalDataLock(mode: LockMode): Promise<() => Promise<void>> {
  const held = Promise.withResolvers<undefined>();
  const acquired = Promise.withResolvers<undefined>();
  const completed = navigator.locks.request(LOCAL_DATA_LOCK, { mode, ifAvailable: true }, async lock => {
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
