import { VMError } from "../../runtime/errors.js";

/** An exclusive section with first-in-first-out waiting that a caller's signal can cancel. */
export interface Gate {
  /**
   * Resolves with a `release` function once the caller owns the gate. Releasing twice is harmless.
   * A wait whose signal aborts leaves the queue and rejects with the signal's reason.
   */
  acquire(signal: AbortSignal): Promise<() => void>;
}

interface Waiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

/** The signal's reason when it is an error; any other reason becomes an ABORTED error. */
function cancellation(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new VMError("ABORTED", "The wait for the gate was cancelled");
}

/** Creates a gate, for runtimes that serve one request at a time (a database backend, an interpreter). */
export function createGate(): Gate {
  let busy = false;
  const waiting: Waiter[] = [];

  function ownership(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next === undefined) {
        busy = false;
        return;
      }
      next.signal.removeEventListener("abort", next.abort);
      next.resolve(ownership());
    };
  }

  return {
    acquire(signal) {
      if (signal.aborted) return Promise.reject(cancellation(signal));
      if (!busy) {
        busy = true;
        return Promise.resolve(ownership());
      }
      const pending = Promise.withResolvers<() => void>();
      const waiter: Waiter = {
        resolve: pending.resolve,
        reject: pending.reject,
        signal,
        abort: () => {
          const index = waiting.indexOf(waiter);
          if (index !== -1) waiting.splice(index, 1);
          pending.reject(cancellation(signal));
        },
      };
      waiting.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      return pending.promise;
    },
  };
}
