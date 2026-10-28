import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createNodeTimersPromises } from "./node-timers-promises.js";

describe("node timers/promises builtin", () => {
  it("retains undefined in omitted-value promises and completed iterator types", async () => {
    vi.useFakeTimers();
    try {
      const timers = createNodeTimersPromises({ setTimeout, clearTimeout, setImmediate: (cb: () => void) => setTimeout(cb, 0), clearImmediate: clearTimeout });
      const timeout = timers.setTimeout(1);
      const immediate = timers.setImmediate();
      const iterator = timers.setInterval(1);
      expectTypeOf(timeout).toEqualTypeOf<Promise<undefined>>();
      expectTypeOf(immediate).toEqualTypeOf<Promise<undefined>>();
      expectTypeOf(iterator.next()).toEqualTypeOf<Promise<IteratorResult<undefined, undefined>>>();
      await vi.advanceTimersByTimeAsync(1);
      await expect(timeout).resolves.toBeUndefined();
      await expect(immediate).resolves.toBeUndefined();
      const completed = await iterator.return?.();
      expect(completed).toEqual({ done: true, value: undefined });
    } finally { vi.useRealTimers(); }
  });

  it("resolves setTimeout and setImmediate with their values and honours abort signals", async () => {
    vi.useFakeTimers();
    try {
      const timers = createNodeTimersPromises({ setTimeout, clearTimeout, setImmediate: (cb: () => void) => setTimeout(cb, 0), clearImmediate: clearTimeout });
      const later = timers.setTimeout(1_000, "later");
      const soon = timers.setImmediate("soon");
      const controller = new AbortController();
      const aborted = timers.setTimeout(5_000, "never", { signal: controller.signal });
      // The rejection settles synchronously on abort; observe it before it does.
      const abortedOutcome = expect(aborted).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await later).toBe("later");
      expect(await soon).toBe("soon");
      await abortedOutcome;
      const ticks: (number | undefined)[] = [];
      const interval = timers.setInterval(100, 7);
      const iterator = interval[Symbol.asyncIterator]();
      const first = iterator.next();
      await vi.advanceTimersByTimeAsync(100);
      const tick = await first;
      if (tick.done !== true) ticks.push(tick.value);
      await iterator.return?.();
      expect(ticks).toEqual([7]);
      const waited = timers.scheduler.wait(50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(waited).resolves.toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});

it("keeps CommonJS timer exports writable for ordinary runtime instrumentation", async () => {
  const timers = createNodeTimersPromises({ setTimeout, clearTimeout, setImmediate: (callback: () => void) => setTimeout(callback, 0), clearImmediate: clearTimeout });
  const called = vi.fn((value: unknown) => Promise.resolve(value));
  expect(Reflect.set(timers, "setImmediate", called)).toBe(true);
  await expect(timers.setImmediate("patched")).resolves.toBe("patched");
  expect(called).toHaveBeenCalledWith("patched");
});
