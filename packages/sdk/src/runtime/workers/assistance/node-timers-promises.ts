/** Node's `timers/promises` over the process's own timers: promises for
 * setTimeout and setImmediate, an async iterator for setInterval, and the
 * scheduler's wait/yield. An aborted signal rejects with Node's AbortError. */
interface Timers {
  setTimeout(callback: () => void, ms?: number): unknown;
  clearTimeout(handle: unknown): void;
  setImmediate(callback: () => void): unknown;
  clearImmediate(handle: unknown): void;
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
}

function signalOf(options: unknown): AbortSignal | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const signal: unknown = Reflect.get(options, "signal");
  return signal instanceof AbortSignal ? signal : undefined;
}

export function createNodeTimersPromises(timers: Timers) {
  function delay<T>(value: T, options: unknown, schedule: (cb: () => void) => unknown, cancel: (handle: unknown) => void): Promise<T> {
    const signal = signalOf(options);
    if (signal?.aborted === true) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => { cancel(handle); reject(abortError()); };
      const handle = schedule(() => { signal?.removeEventListener("abort", onAbort); resolve(value); });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  function setTimeoutPromise<T>(ms: unknown, value: T, options?: unknown): Promise<T>;
  function setTimeoutPromise(ms?: unknown, value?: undefined, options?: unknown): Promise<undefined>;
  function setTimeoutPromise<T>(ms?: unknown, value?: T, options?: unknown): Promise<T | undefined> {
    return delay(value, options, cb => timers.setTimeout(cb, typeof ms === "number" ? ms : 1), handle => { timers.clearTimeout(handle); });
  }
  function setImmediatePromise<T>(value: T, options?: unknown): Promise<T>;
  function setImmediatePromise(value?: undefined, options?: unknown): Promise<undefined>;
  function setImmediatePromise<T>(value?: T, options?: unknown): Promise<T | undefined> {
    return delay(value, options, cb => timers.setImmediate(cb), handle => { timers.clearImmediate(handle); });
  }
  function setIntervalIterator<T>(ms: unknown, value: T, options?: unknown): AsyncIterable<T> & AsyncIterator<T, undefined>;
  function setIntervalIterator(ms?: unknown, value?: undefined, options?: unknown): AsyncIterable<undefined> & AsyncIterator<undefined, undefined>;
  function setIntervalIterator<T>(ms?: unknown, value?: T, options?: unknown): AsyncIterable<T | undefined> & AsyncIterator<T | undefined, undefined> {
    const signal = signalOf(options);
    const interval = typeof ms === "number" ? ms : 1;
    let pending = 0;
    let waiting: ((result: IteratorResult<T | undefined, undefined>) => void) | undefined;
    let rejecting: ((error: Error) => void) | undefined;
    let done = false;
    let handle: unknown;
    const tick = (): void => {
      if (waiting !== undefined) { const resolve = waiting; waiting = undefined; rejecting = undefined; resolve({ value, done: false }); }
      else pending += 1;
      if (!done) handle = timers.setTimeout(tick, interval);
    };
    handle = timers.setTimeout(tick, interval);
    const stop = (): void => { done = true; timers.clearTimeout(handle); };
    signal?.addEventListener("abort", () => { stop(); rejecting?.(abortError()); }, { once: true });
    const iterator: AsyncIterable<T | undefined> & AsyncIterator<T | undefined, undefined> = {
      [Symbol.asyncIterator]: () => iterator,
      next: () => {
        if (signal?.aborted === true) return Promise.reject(abortError());
        if (done) return Promise.resolve({ value: undefined, done: true });
        if (pending > 0) { pending -= 1; return Promise.resolve({ value, done: false }); }
        return new Promise((resolve, reject) => { waiting = resolve; rejecting = reject; });
      },
      return: () => { stop(); return Promise.resolve({ value: undefined, done: true }); },
    };
    return iterator;
  }
  return {
    setTimeout: setTimeoutPromise, setImmediate: setImmediatePromise, setInterval: setIntervalIterator,
    scheduler: Object.freeze({ wait: (ms?: unknown, options?: unknown): Promise<void> => setTimeoutPromise(ms, undefined, options), yield: (): Promise<void> => setImmediatePromise(undefined) }),
  };
}
