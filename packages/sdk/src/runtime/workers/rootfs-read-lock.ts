import { VMError } from "../errors.js";

export type RootfsReadLock = (() => Promise<void>) & { borrow(): () => Promise<void> };

/** Retain cross-worker reachability until admitted immutable reads have drained. */
export async function retainRootfsRead(signal?: AbortSignal): Promise<RootfsReadLock> {
  if (signal?.aborted === true) throw new VMError("ABORTED", "Image read cancelled");
  const locks = typeof navigator === "object" ? navigator.locks : undefined;
  if (locks === undefined) return readLock(() => Promise.resolve());
  const granted = Promise.withResolvers<RootfsReadLock>(), retired = Promise.withResolvers<undefined>();
  const holding = locks.request("oxidevm-rootfs-pack-lifecycle", { mode: "shared", ...(signal === undefined ? {} : { signal }) }, () => {
    granted.resolve(readLock(() => { retired.resolve(undefined); return holding.then(() => {}); }));
    return retired.promise;
  });
  void holding.catch((error: unknown) => granted.reject(signal?.aborted === true ? new VMError("ABORTED", "Image read cancelled") : error));
  return granted.promise;
}

function readLock(releaseLock: () => Promise<void>): RootfsReadLock {
  let readers = 1, accepting = true;
  const releaseReader = () => {
    let released = false;
    return () => { if (released) return Promise.resolve(); released = true; readers--; return readers === 0 ? releaseLock() : Promise.resolve(); };
  };
  const release = releaseReader();
  return Object.assign(() => { accepting = false; return release(); }, { borrow: () => {
    if (!accepting) throw new VMError("PROTOCOL_ERROR", "Image read transaction has retired");
    readers++; return releaseReader();
  } });
}
