/**
 * A deadline as an AbortSignal, on `setTimeout` so tests can drive it with fake timers, combined with the caller's own
 * signal. `clear` must be called when the guarded work ends, so no timer outlives it.
 */
export interface Deadline { readonly signal: AbortSignal; readonly expired: () => boolean; clear(): void }

export function deadline(ms: number, caller?: AbortSignal, what = "The operation"): Deadline {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(new DOMException(`${what} timed out`, "TimeoutError")); }, ms);
  const signal = caller === undefined ? controller.signal : AbortSignal.any([caller, controller.signal]);
  return { signal, expired: () => expired, clear: () => { clearTimeout(timer); } };
}
