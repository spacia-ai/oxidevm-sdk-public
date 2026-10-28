import { VMError } from "./errors.js";

/** A failed or silent edge must not keep the remaining VM owners alive indefinitely. */
export async function rejectingTimeout(dispose: Promise<unknown>, timeoutMs = 30_000,
  failure = new VMError("STORAGE_ERROR", "worker disposal timed out")): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      dispose,
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(failure), timeoutMs); }),
    ]);
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
}
