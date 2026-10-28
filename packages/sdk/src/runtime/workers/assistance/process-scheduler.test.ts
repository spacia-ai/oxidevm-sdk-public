import { deprecate, format, inspect } from "node:util";
import { createAsyncFiles } from "./node-files.js";
import { expect, it } from "vitest";
import { createAsyncContext } from "./async-context.ts";
import { ProcessScheduler } from "./process-scheduler.ts";
import { createNodeAsyncHooks } from "./node-async-hooks.js";

it("reports queued resource scopes and destroys cancelled work", async () => {
  const context = createAsyncContext(), hooks = createNodeAsyncHooks(context, { deprecate, format, inspect });
  const scheduler = new ProcessScheduler(context, error => { throw error; });
  const types = new Map<number, string>(), destroyed: number[] = [], observed: unknown[] = [];
  hooks.createHook({ init(id: number, type: string) { types.set(id, type); }, destroy(id: number) { destroyed.push(id); } }).enable();
  try {
    const cancelled = scheduler.setImmediate(() => { throw new Error("cancelled"); });
    scheduler.clearImmediate(cancelled);
    scheduler.nextTick(() => observed.push(types.get(hooks.executionAsyncId())));
    scheduler.setImmediate(() => observed.push(types.get(hooks.executionAsyncId())));
    await scheduler.idle();
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(observed).toEqual(["TickObject", "Immediate"]);
    expect(destroyed.toSorted()).toEqual([...types.keys()].toSorted());
  } finally { scheduler.dispose(); }
});

it("drains entry ticks before promises and microtask ticks before the next resource callback", async () => {
  const errors: unknown[] = [];
  const scheduler = new ProcessScheduler(createAsyncContext(), error => errors.push(error));
  const order: string[] = [];
  try {
    scheduler.run(() => {
      scheduler.nextTick(() => {
        order.push("tick");
        scheduler.nextTick(() => order.push("nested tick"));
      });
      void Promise.resolve().then(() => {
        order.push("promise");
        scheduler.nextTick(() => {
          order.push("promise tick");
          void Promise.resolve().then(() => order.push("tick promise"));
        });
      }).then(() => order.push("promise chain"));
      scheduler.enqueue(() => order.push("resource"));
      order.push("entry");
    });
    await scheduler.idle();
    expect(order).toEqual(["entry", "tick", "nested tick", "promise", "promise chain", "promise tick", "tick promise", "resource"]);
    expect(errors).toEqual([]);
  } finally { scheduler.dispose(); }
});

it("preserves tick context and arguments without splitting nested synchronous calls", async () => {
  const context = createAsyncContext();
  const storage = new context.AsyncLocalStorage<string>();
  const scheduler = new ProcessScheduler(context, error => { throw error; });
  const order: unknown[] = [];
  try {
    scheduler.run(() => {
      storage.run("tick context", () => scheduler.nextTick((value: unknown) => {
        order.push(storage.getStore(), value);
      }, 7));
      scheduler.run(() => order.push("nested synchronous"));
      order.push("outer synchronous");
    });
    await scheduler.idle();
    expect(order).toEqual(["nested synchronous", "outer synchronous", "tick context", 7]);
  } finally { scheduler.dispose(); }
});

it("retires queued callbacks on failure or disposal", async () => {
  const errors: unknown[] = [];
  const scheduler = new ProcessScheduler(createAsyncContext(), error => errors.push(error));
  let calls = 0;
  const failure = new Error("callback failed");
  scheduler.enqueue(() => { throw failure; });
  scheduler.enqueue(() => calls++);
  await scheduler.idle();
  expect(errors).toEqual([failure]);
  expect(calls).toBe(0);
  expect(() => scheduler.nextTick(() => {})).toThrow("disposed");
  scheduler.dispose();
});

it("runs filesystem callbacks as separate turns with ticks and promises between them", async () => {
  const context = createAsyncContext();
  const errors: unknown[] = [];
  const scheduler = new ProcessScheduler(context, error => errors.push(error));
  const fs = createAsyncFiles(() => Promise.resolve({ kind: "unit" }), () => "/workspace", context,
    () => () => {}, callback => scheduler.enqueue(callback));
  const done = Promise.withResolvers<undefined>();
  const order: string[] = [];
  try {
    fs.access("/first", () => {
      order.push("first");
      scheduler.nextTick(() => order.push("tick"));
      void Promise.resolve().then(() => order.push("promise"));
    });
    fs.access("/second", () => { order.push("second"); done.resolve(undefined); });
    await done.promise;
    expect(order).toEqual(["first", "tick", "promise", "second"]);
    expect(errors).toEqual([]);
  } finally { scheduler.dispose(); }
});

it("returns resource backpressure results and rejects outstanding delivery on disposal", async () => {
  const scheduler = new ProcessScheduler(createAsyncContext(), error => { throw error; });
  try {
    await expect(scheduler.execute(() => false)).resolves.toBe(false);
    const pending = scheduler.execute(() => { throw new Error("must not run"); });
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    scheduler.dispose();
    await rejected;
    expect(scheduler.hasPending).toBe(false);
  } finally { scheduler.dispose(); }
});

it("does not execute queued application ticks after an entry exception", () => {
  const scheduler = new ProcessScheduler(createAsyncContext(), error => { throw error; });
  let ran = false;
  const failure = new Error("entry failed");
  try {
    expect(() => scheduler.run(() => {
      scheduler.nextTick(() => { ran = true; });
      throw failure;
    })).toThrow(failure);
    expect(ran).toBe(false);
  } finally { scheduler.dispose(); }
});

it("continues queued work after the process handles an uncaught callback exception", async () => {
  const failures: unknown[] = [], handled: unknown[] = [], order: string[] = [];
  const scheduler = new ProcessScheduler(createAsyncContext(), error => { failures.push(error); });
  const error = new Error("callback");
  scheduler.setExceptionHandler(error => { handled.push(error); return true; });
  try {
    scheduler.enqueue(() => { scheduler.nextTick(() => { order.push("tick"); }); throw error; });
    scheduler.enqueue(() => { order.push("next"); });
    await scheduler.idle();
    expect(handled).toEqual([error]); expect(failures).toEqual([]); expect(order).toEqual(["tick", "next"]);
    expect(() => scheduler.setExceptionHandler(() => false)).toThrow(/already set/u);
  } finally { scheduler.dispose(); }
});

it("wakes ticks queued by a CommonJS entry when its exception was handled", async () => {
  const errors: unknown[] = [], scheduler = new ProcessScheduler(createAsyncContext(), error => { errors.push(error); });
  let ran = false;
  scheduler.setExceptionHandler(() => true);
  try {
    try { scheduler.run(() => { scheduler.nextTick(() => { ran = true; }); throw new Error("entry"); }); }
    catch (error) { expect(scheduler.handleException(error)).toBe(true); }
    await scheduler.idle(); expect(ran).toBe(true); expect(errors).toEqual([]);
  } finally { scheduler.dispose(); }
});

it("runs immediate batches in creation order with checkpoints and defers nested immediates", async () => {
  const scheduler = new ProcessScheduler(createAsyncContext(), error => { throw error; });
  const order: string[] = [];
  try {
    scheduler.setImmediate(() => {
      order.push("first");
      scheduler.nextTick(() => order.push("tick"));
      void Promise.resolve().then(() => order.push("promise"));
      scheduler.setImmediate(() => order.push("nested"));
      scheduler.enqueue(() => order.push("resource"));
    });
    scheduler.setImmediate(() => order.push("second"));
    await scheduler.idle();
    expect(order).toEqual(["first", "tick", "promise", "second", "resource", "nested"]);
  } finally { scheduler.dispose(); }
});

it("tracks immediate references, cancellation, context and callback arguments", async () => {
  const context = createAsyncContext();
  const storage = new context.AsyncLocalStorage<string>();
  const scheduler = new ProcessScheduler(context, error => { throw error; });
  const order: unknown[] = [];
  try {
    const ignored = scheduler.setImmediate(() => { throw new Error("cancelled immediate ran"); });
    scheduler.clearImmediate(ignored);
    const handle = storage.run("immediate", () => scheduler.setImmediate((value: unknown) => {
      order.push(storage.getStore(), value);
    }, 9));
    expect(handle.unref()).toBe(handle);
    expect(handle.hasRef()).toBe(false);
    expect(scheduler.hasPending).toBe(false);
    expect(handle.ref()).toBe(handle);
    expect(scheduler.hasPending).toBe(true);
    await scheduler.idle();
    expect(order).toEqual(["immediate", 9]);
  } finally { scheduler.dispose(); }
});

it("bounds queued work and releases immediate capacity on cancellation", () => {
  const scheduler = new ProcessScheduler(createAsyncContext(), error => { throw error; });
  try {
    const handles = Array.from({ length: 4096 }, () => scheduler.setImmediate(() => {}));
    expect(() => scheduler.nextTick(() => {})).toThrow("queue exhausted");
    scheduler.clearImmediate(handles[0]);
    expect(() => scheduler.nextTick(() => {})).not.toThrow();
  } finally { scheduler.dispose(); }
});
