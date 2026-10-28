import { VMError } from "./errors.js";

/** Busy alone is transient. Conditional writes and all other failures stay visible to the caller. */
export async function retryWorkspaceBusy<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    if (signal?.aborted === true) throw new VMError("ABORTED", "workspace operation canceled");
    try { return await operation(); } catch (error) {
      if (!(error instanceof VMError) || error.code !== "STORAGE_ERROR" || error.detail?.["reason"] !== "busy" || performance.now() >= deadline) throw error;
      await new Promise<void>((resolve, reject) => {
        const stop = () => { clearTimeout(timer); reject(new VMError("ABORTED", "workspace operation canceled")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, Math.min(100, deadline - performance.now()));
        signal?.addEventListener("abort", stop, { once: true });
      });
    }
  }
}
