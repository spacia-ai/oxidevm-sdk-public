import { afterEach, expect, it, vi } from "vitest";
import { createProcessTimers } from "./process-timers.ts";
import { createAsyncContext } from "./async-context.ts";
import { installSchedulingContext } from "./scheduling-context.ts";

afterEach(() => vi.useRealTimers());
it("refresh retains the context of timer creation", async () => {
  vi.useFakeTimers();
  const context = createAsyncContext();
  const storage = new context.AsyncLocalStorage<string>();
  const target = { setTimeout, setInterval, clearTimeout, clearInterval, queueMicrotask };
  const restore = installSchedulingContext(context, target);
  const timers = createProcessTimers(target, context);
  try {
    const observed: unknown[] = [];
    const timer = storage.run("creation", () => timers.setTimeout(() => observed.push(storage.getStore()), 2));
    storage.run("refresh", () => timer.refresh());
    await vi.advanceTimersByTimeAsync(2);
    expect(observed).toEqual(["creation"]);
  } finally { timers.dispose(); restore(); }
});
it("keeps referenced timers alive, supports cancellation, and releases one-shot timers", async () => {
  vi.useFakeTimers();
  const target = { setTimeout, setInterval, clearTimeout, clearInterval };
  const timers = createProcessTimers(target, createAsyncContext());
  try {
    const called = vi.fn();
    const timer = timers.setTimeout(called, 10);
    expect(timer.hasRef()).toBe(true);
    expect(timers.hasReferences).toBe(true);
    let idle = false;
    const done = timers.idle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(called).toHaveBeenCalledOnce();
    expect(timers.hasReferences).toBe(false);
    const interval = timers.setInterval(called, 10);
    timers.clear(interval);
    await timers.idle();
    await vi.advanceTimersByTimeAsync(20);
    expect(called).toHaveBeenCalledOnce();
  } finally { timers.dispose(); }
});

it("unref does not keep the process alive and ref restores liveness", async () => {
  vi.useFakeTimers();
  const timers = createProcessTimers({ setTimeout, setInterval, clearTimeout, clearInterval }, createAsyncContext());
  try {
    const timer = timers.setInterval(() => {}, 20);
    expect(timer.unref()).toBe(timer);
    expect(timer.hasRef()).toBe(false);
    await timers.idle();
    expect(timer.ref()).toBe(timer);
    expect(timers.hasReferences).toBe(true);
    timers.clear(timer);
    expect(timers.hasReferences).toBe(false);
  } finally { timers.dispose(); }
});

it("binds timeout this and never refreshes an explicitly cleared handle", async () => {
  vi.useFakeTimers();
  const timers = createProcessTimers({ setTimeout, setInterval, clearTimeout, clearInterval }, createAsyncContext());
  try {
    let calls = 0;
    const timer = timers.setTimeout(function (this: unknown) {
      expect(this).toBe(timer);
      calls++;
      timers.clear(timer);
      timer.refresh();
    }, 2);
    const cancelled = timers.setTimeout(() => { throw new Error("cancelled timer ran"); }, 2);
    timers.clear(cancelled);
    cancelled.refresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);
    expect(timers.hasReferences).toBe(false);
  } finally { timers.dispose(); }
});

it("clears numeric-string timer identities without coercing unrelated objects", async () => {
  vi.useFakeTimers();
  const timers = createProcessTimers({ setTimeout, setInterval, clearTimeout, clearInterval }, createAsyncContext());
  try {
    const called = vi.fn();
    const timeout = timers.setTimeout(called, 2);
    const interval = timers.setInterval(called, 2);
    timers.clear(String(Number(timeout)));
    timers.clear(String(Number(interval)));
    timeout.refresh();
    interval.refresh();
    const live = timers.setTimeout(called, 2);
    timers.clear({ [Symbol.toPrimitive]: () => Number(live) });
    for (const id of [`0${Number(live)}`, `${Number(live)}.0`, ` ${Number(live)} `]) timers.clear(id);
    await vi.advanceTimersByTimeAsync(6);
    expect(called).toHaveBeenCalledOnce();
    expect(timers.hasReferences).toBe(false);
  } finally { timers.dispose(); }
});

it("cancels an expired timer before its queued resource callback runs", async () => {
  vi.useFakeTimers();
  const pending: (() => void)[] = [];
  const timers = createProcessTimers({ setTimeout, setInterval, clearTimeout, clearInterval },
    createAsyncContext(), callback => pending.push(callback));
  const called = vi.fn();
  try {
    const timer = timers.setTimeout(called, 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending).toHaveLength(1);
    timers.clear(timer);
    pending[0]?.();
    expect(called).not.toHaveBeenCalled();
    expect(timers.hasReferences).toBe(false);
  } finally { timers.dispose(); }
});

it("fences a queued timer callback after refresh creates a new resource", async () => {
  vi.useFakeTimers();
  const pending: (() => void)[] = [], called = vi.fn();
  const timers = createProcessTimers({ setTimeout, setInterval, clearTimeout, clearInterval },
    createAsyncContext(), callback => pending.push(callback));
  try {
    const timer = timers.setTimeout(called, 1);
    await vi.advanceTimersByTimeAsync(1);
    timer.refresh();
    pending[0]?.();
    expect(called).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    pending[1]?.();
    expect(called).toHaveBeenCalledOnce();
    expect(timers.hasReferences).toBe(false);
  } finally { timers.dispose(); }
});
