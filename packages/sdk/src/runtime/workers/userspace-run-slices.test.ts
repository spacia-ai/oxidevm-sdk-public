import { describe, expect, it } from "vitest";

import { USERSPACE_PENDING_OUTPUT } from "../userspace-abi.js";
import {
  ACTION_STEPS_MAX,
  ACTION_STEPS_MIN,
  actionSteps,
  nextActionSteps,
  INLINE_SERVICE_MILLISECONDS,
  INTERACTIVE_SLICE_MILLISECONDS,
  interactiveWindowEnd,
  newOutputEndsSlice,
  RUN_SLICE_MILLISECONDS,
  runSliceMilliseconds,
  shouldYieldForOutput,
} from "./userspace-run-slices.js";

describe("Userspace interactive run slices", () => {
  it("runs full slices while no terminal input arrived recently", () => {
    expect(runSliceMilliseconds(5_000, 0)).toBe(RUN_SLICE_MILLISECONDS);
  });

  it("runs short slices for a while after terminal input, so the next key waits one slice", () => {
    const until = interactiveWindowEnd(1_000);
    expect(INTERACTIVE_SLICE_MILLISECONDS).toBeLessThan(RUN_SLICE_MILLISECONDS);
    expect(runSliceMilliseconds(1_000, until)).toBe(INTERACTIVE_SLICE_MILLISECONDS);
    expect(runSliceMilliseconds(until - 1, until)).toBe(INTERACTIVE_SLICE_MILLISECONDS);
    expect(runSliceMilliseconds(until, until)).toBe(RUN_SLICE_MILLISECONDS);
  });

  it("ends an interactive slice once for each new generation of terminal output", () => {
    const fresh = { interactive: true, outputPending: true, generation: 4n, yieldedGeneration: 3n };
    expect(shouldYieldForOutput(fresh)).toBe(true);
    // Output the page has not acknowledged yet stays pending: it must not end every slice.
    expect(shouldYieldForOutput({ ...fresh, yieldedGeneration: 4n })).toBe(false);
    expect(shouldYieldForOutput({ ...fresh, outputPending: false })).toBe(false);
    expect(shouldYieldForOutput({ ...fresh, interactive: false })).toBe(false);
  });

  it("asks the runtime for output only inside an interactive window and records the generation", () => {
    let pendingWork = 0, generation = 4n, polls = 0;
    const runtime = { outputYieldGeneration: -1n, instance: { exports: {
      oxidevm_userspace_pending_work: () => { polls += 1; return pendingWork; },
      oxidevm_userspace_pending_generation: (kind: number) => {
        expect(kind).toBe(USERSPACE_PENDING_OUTPUT);
        return generation;
      },
    } } };

    expect(newOutputEndsSlice(runtime, false)).toBe(false);
    expect(polls).toBe(0);
    expect(newOutputEndsSlice(runtime, true)).toBe(false);
    pendingWork = USERSPACE_PENDING_OUTPUT;
    expect(newOutputEndsSlice(runtime, true)).toBe(true);
    // The page has not acknowledged generation 4 yet; the next slice runs to its end.
    expect(newOutputEndsSlice(runtime, true)).toBe(false);
    generation = 5n;
    expect(newOutputEndsSlice(runtime, true)).toBe(true);
    expect(runtime.outputYieldGeneration).toBe(5n);
  });
});

describe("the length of a Userspace action", () => {
  it("starts at the shortest action, before any action has been timed", () => {
    expect(actionSteps(undefined)).toBe(ACTION_STEPS_MIN);
    expect(ACTION_STEPS_MIN).toBe(100_000);
  });

  it("lasts about one inline-service interval at the rate of the action before it", () => {
    // 400,000 instructions in 0.2 ms: 2,000 per microsecond, so 0.25 ms hold 500,000.
    expect(actionSteps({ instructions: 400_000, milliseconds: 0.2 })).toBe(500_000);
    expect(actionSteps({ instructions: 500_000, milliseconds: INLINE_SERVICE_MILLISECONDS })).toBe(500_000);
  });

  it("shrinks at once when the guest slows down, and never below the shortest action", () => {
    expect(actionSteps({ instructions: 2_000_000, milliseconds: 2 })).toBe(250_000);
    expect(actionSteps({ instructions: 100_000, milliseconds: 5 })).toBe(ACTION_STEPS_MIN);
    expect(actionSteps({ instructions: 4_000_000, milliseconds: 400 })).toBe(ACTION_STEPS_MIN);
  });

  it("at most doubles from one action to the next, up to the longest action", () => {
    expect(actionSteps({ instructions: 100_000, milliseconds: 0.01 })).toBe(200_000);
    expect(actionSteps({ instructions: 3_000_000, milliseconds: 0.1 })).toBe(ACTION_STEPS_MAX);
    expect(ACTION_STEPS_MAX).toBe(4_000_000);
  });

  it("doubles when the clock saw no time pass", () => {
    expect(actionSteps({ instructions: 100_000, milliseconds: 0 })).toBe(200_000);
    expect(actionSteps({ instructions: ACTION_STEPS_MAX, milliseconds: 0 })).toBe(ACTION_STEPS_MAX);
  });

  it("falls back to the shortest action for a measurement that makes no sense", () => {
    for (const rate of [
      { instructions: 0, milliseconds: 1 },
      { instructions: -5, milliseconds: 1 },
      { instructions: Number.NaN, milliseconds: 1 },
      { instructions: 100_000, milliseconds: -1 },
      { instructions: 100_000, milliseconds: Number.NaN },
      { instructions: Number.POSITIVE_INFINITY, milliseconds: 1 },
    ]) {
      expect(actionSteps(rate)).toBe(ACTION_STEPS_MIN);
    }
  });
});

describe("the budget after an action", () => {
  it("is sized by an action that used up its budget", () => {
    expect(nextActionSteps(1_000_000, { instructions: 1_000_000, milliseconds: 0.25 })).toBe(1_000_000);
    expect(nextActionSteps(ACTION_STEPS_MAX, { instructions: ACTION_STEPS_MAX, milliseconds: 400 })).toBe(ACTION_STEPS_MIN);
  });

  it("halves after an action a system call or a fault ended, so a budget grown on fast code does not outlive it", () => {
    expect(nextActionSteps(ACTION_STEPS_MAX, undefined)).toBe(2_000_000);
    expect(nextActionSteps(150_000, undefined)).toBe(ACTION_STEPS_MIN);
    let budget = ACTION_STEPS_MAX;
    for (let action = 0; action < 6; action += 1) budget = nextActionSteps(budget, undefined);
    expect(budget).toBe(ACTION_STEPS_MIN);
  });
});
