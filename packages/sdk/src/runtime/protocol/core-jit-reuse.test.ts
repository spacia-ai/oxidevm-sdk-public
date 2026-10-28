import { describe, expect, it } from "vitest";
import { jitReuseFromValues, decodeJitReuse, CORE_JIT_REUSE_KEYS } from "./core-jit-reuse.js";

describe("translation reuse counters", () => {
  it("decodes both tiers and requires attempts to reconcile with outcomes", () => {
    const values = Array<bigint>(28).fill(0n);
    values[0] = 3n;
    values[1] = 1n;
    values[4] = 2n;
    values[14] = 1n;
    values[15] = 1n;
    const counters = jitReuseFromValues(values);
    expect(decodeJitReuse(counters, 53)).toEqual(counters);
    expect(() => decodeJitReuse({ ...counters, jitTierOneReuseAttempts: 4n }, 53)).toThrow("reconcile");
    expect(Object.keys(counters)).toEqual(CORE_JIT_REUSE_KEYS);
    expect(decodeJitReuse({}, 52)).toEqual(jitReuseFromValues([]));
  });
});
