import { describe, expect, it, vi } from "vitest";

import {
  createUserspaceWakeTimer,
  nativeExecutionPending,
  failUserspaceRuntime,
  rearmsWakeTimer,
  shouldAcknowledgeOutputGeneration,
  shouldServicePendingWork,
  wakeTimerAction,
} from "./userspace-service.js";

describe("Userspace service boundaries", () => {
  it("keeps Rust-owned kernel work scheduled after its final guest process exits", () => {
    expect(nativeExecutionPending(0, 1)).toBe(true);
    expect(nativeExecutionPending(0, 0)).toBe(false);
    expect(nativeExecutionPending(1, 0)).toBe(true);
  });

  it("rejects malformed native counts and detached-work flags", () => {
    for (const live of [-1, 0x1_0000_0000, 0.5, Number.NaN, "0", null]) {
      expect(() => nativeExecutionPending(live, 0)).toThrow();
    }
    for (const pending of [-1, 2, 0.5, Number.NaN, "1", null]) {
      expect(() => nativeExecutionPending(0, pending)).toThrow();
    }
  });
  it("reports a shared execution failure after its original process retired", () => {
    const original = { pid: 1, stopped: true };
    const running = [{ pid: 2, stopped: false }, { pid: 3, stopped: false }];
    const processes = new Map(running.map(process => [process.pid, process]));
    const error = new Error("directed module compilation failure");
    const failures: number[] = [];
    expect(processes.has(original.pid)).toBe(false);
    failUserspaceRuntime(processes, error, (process, observed) => {
      if (process.stopped) return;
      expect(observed).toBe(error);
      process.stopped = true;
      processes.delete(process.pid);
      failures.push(process.pid);
    });
    expect(failures).toEqual([2, 3]);
    expect(processes.size).toBe(0);
  });

  it("does not poll after an interior step-limit", () => {
    expect(shouldServicePendingWork("step-limit", false)).toBe(false);
    expect(shouldServicePendingWork("step-limit", true)).toBe(true);
  });

  it("services every true execution boundary", () => {
    expect(shouldServicePendingWork("blocked", false)).toBe(true);
    expect(shouldServicePendingWork("exit", false)).toBe(true);
    expect(shouldServicePendingWork("fault", false)).toBe(true);
  });

  it("does not acknowledge output while delivery is in flight", () => {
    expect(shouldAcknowledgeOutputGeneration(false, false)).toBe(true);
    expect(shouldAcknowledgeOutputGeneration(true, false)).toBe(false);
    expect(shouldAcknowledgeOutputGeneration(false, true)).toBe(false);
  });
});

describe("Userspace wake timer", () => {
  it("maps the runtime's next wake delay to one action", () => {
    expect(wakeTimerAction(0xffff_ffff)).toEqual({ kind: "none" });
    expect(wakeTimerAction(0)).toEqual({ kind: "run-now" });
    expect(wakeTimerAction(17)).toEqual({ kind: "arm", delayMs: 17 });
  });

  it("re-arms at every blocked or exit boundary, even when no deadline changed", () => {
    expect(rearmsWakeTimer("blocked")).toBe(true);
    expect(rearmsWakeTimer("exit")).toBe(true);
    expect(rearmsWakeTimer("step-limit")).toBe(false);
    expect(rearmsWakeTimer("fault")).toBe(false);
  });

  it("keeps at most one pending wake and cancels it on demand", () => {
    vi.useFakeTimers();
    try {
      let wakes = 0;
      const timer = createUserspaceWakeTimer(
        { set: (callback, delayMs) => setTimeout(callback, delayMs), clear: (handle) => { clearTimeout(handle); } },
        () => { wakes += 1; },
      );
      timer.arm(10);
      timer.arm(30);
      expect(timer.armed).toBe(true);
      vi.advanceTimersByTime(29);
      expect(wakes).toBe(0);
      vi.advanceTimersByTime(1);
      expect(wakes).toBe(1);
      expect(timer.armed).toBe(false);

      timer.arm(5);
      timer.cancel();
      vi.advanceTimersByTime(100);
      expect(wakes).toBe(1);
      expect(timer.armed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
