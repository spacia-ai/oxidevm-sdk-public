import { describe, expect, it } from "vitest";

import { USERSPACE_PENDING_OUTPUT } from "../userspace-abi.js";
import {
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
