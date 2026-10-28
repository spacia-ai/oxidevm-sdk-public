import { VMError } from "../errors.js";

/** Replenishes bounded read/hash work; an object larger than the byte window runs alone. */
export async function readStorageObjects<T extends { readonly bytes: number }>(
  objects: readonly T[], read: (object: T) => Promise<unknown>, signal?: AbortSignal, concurrency: 2 | 4 | 8 | 32 | (() => 4 | 32) = 8,
): Promise<void> {
  const pending = new Set<Promise<void>>();
  let index = 0, bytes = 0;
  let failure: { readonly error: unknown } | undefined;
  try {
    while (index < objects.length || pending.size !== 0) {
      if (signal?.aborted === true) throw new VMError("ABORTED", "Storage verification cancelled");
      if (failure !== undefined) throw failure.error;
      while (index < objects.length && pending.size < (typeof concurrency === "function" ? concurrency() : concurrency)) {
        const object = objects[index];
        if (object === undefined || !Number.isSafeInteger(object.bytes) || object.bytes < 0) {
          throw new VMError("PROTOCOL_ERROR", "Storage verification object length is invalid");
        }
        if (pending.size !== 0 && object.bytes > 8 * 1024 ** 2 - bytes) break;
        const admittedBytes = object.bytes;
        bytes += admittedBytes; index++;
        const work = Promise.resolve().then(() => read(object)).then(() => {}, (error: unknown) => {
          failure ??= { error };
        }).finally(() => { bytes -= admittedBytes; pending.delete(work); });
        pending.add(work);
      }
      await Promise.race(pending);
    }
    if (failure !== undefined) throw failure.error;
    if (signal?.aborted === true) throw new VMError("ABORTED", "Storage verification cancelled");
  } finally { await Promise.all(pending); }
}
