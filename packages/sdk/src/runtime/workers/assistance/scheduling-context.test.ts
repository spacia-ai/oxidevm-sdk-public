import { expect, it } from "vitest";
import { createAsyncContext } from "./async-context.ts";
import { installSchedulingContext } from "./scheduling-context.ts";

it("keeps interleaved timer and microtask callbacks in their captured context", async () => {
  const context = createAsyncContext();
  const storage = new context.AsyncLocalStorage<string>();
  const target = { setTimeout, setInterval, queueMicrotask };
  const original = target.setTimeout;
  const restore = installSchedulingContext(context, target);
  const observed: unknown[] = [];
  try {
    await Promise.all(["A", "B"].map((name) => storage.run(name, () => new Promise<void>((resolve) => {
      target.setTimeout((argument: string) => {
        observed.push([argument, storage.getStore()]);
        target.queueMicrotask(() => { observed.push(storage.getStore()); resolve(); });
      }, 0, name);
    }))));
    expect(observed).toEqual([["A", "A"], "A", ["B", "B"], "B"]);
    expect(storage.getStore()).toBeUndefined();
  } finally { restore(); }
  expect(target.setTimeout).toBe(original);
});

it("restores the caller when a scheduled callback throws", () => {
  const context = createAsyncContext();
  const storage = new context.AsyncLocalStorage<string>();
  let pending: (() => void) | undefined;
  const target = {
    setTimeout: (callback: () => void) => { pending = callback; },
    setInterval: () => undefined,
    queueMicrotask: () => undefined,
  };
  const restore = installSchedulingContext(context, target);
  storage.run("timer", () => target.setTimeout(() => {
    expect(storage.getStore()).toBe("timer");
    throw new Error("callback error");
  }));
  expect(() => pending?.()).toThrow("callback error");
  expect(storage.getStore()).toBeUndefined();
  restore();
});

it("binds worker scheduling methods inherited from the global prototype", () => {
  const context = createAsyncContext();
  class WorkerGlobal {
    setTimeout() { return 1; }
    setInterval() { return 2; }
    queueMicrotask() { /* fixture */ }
  }
  const target = new WorkerGlobal();
  const restore = installSchedulingContext(context, target);
  expect(Object.hasOwn(target, "setTimeout")).toBe(true);
  restore();
  expect(Object.hasOwn(target, "setTimeout")).toBe(false);
});
