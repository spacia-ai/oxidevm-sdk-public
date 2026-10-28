import { describe, expect, it } from "vitest";

import { VMError } from "../errors.js";
import { decodeJitFailure } from "./system-trace-identity.js";
import {
  decodeJitHealthProfile,
  emptyJitHealthProfile,
  stickyFailureMatchesHealth,
} from "./system-trace-jit-health.js";

describe("JIT health profile", () => {
  const exhausted = {
    state: "exhausted",
    reason: "code-memory",
    failures: { "code-memory": 3, "module-compilation": 0, "module-abi": 0 },
    firstFailure: {
      generation: 4,
      cacheKey: 0x99n,
      reason: "code-memory",
      phase: "instantiation",
      errorName: "RangeError",
      message: "Out of memory",
    },
    interpretedCompiles: 2,
    parkedCompiles: 12,
  } as const;

  it("decodes active, exhausted and disabled profiles", () => {
    expect(decodeJitHealthProfile(emptyJitHealthProfile())).toEqual(emptyJitHealthProfile());
    expect(decodeJitHealthProfile(exhausted)).toEqual(exhausted);
    const disabled = {
      ...exhausted,
      state: "disabled",
      reason: "module-abi",
      failures: { ...exhausted.failures, "module-abi": 1 },
    } as const;
    expect(decodeJitHealthProfile(disabled)).toEqual(disabled);
  });

  it("rejects states that do not match their failures", () => {
    for (const invalid of [
      { ...exhausted, state: "active" },
      { ...exhausted, state: "disabled" },
      { ...exhausted, reason: "module-compilation" },
      { ...exhausted, failures: { ...exhausted.failures, "code-memory": 0 } },
      { ...exhausted, firstFailure: null },
      { ...emptyJitHealthProfile(), interpretedCompiles: 1 },
      { ...emptyJitHealthProfile(), parkedCompiles: 1 },
      { ...emptyJitHealthProfile(), failures: { ...exhausted.failures } },
    ]) {
      expect(() => decodeJitHealthProfile(invalid)).toThrow("JIT health profile does not reconcile");
    }
  });

  it("rejects unknown states, reasons, phases, fields and unbounded errors", () => {
    expect(() => decodeJitHealthProfile({ ...exhausted, state: "paused" })).toThrow("JIT state is invalid");
    expect(() => decodeJitHealthProfile({ ...exhausted, reason: "other" }))
      .toThrow("JIT degradation reason is invalid");
    expect(() => decodeJitHealthProfile({
      ...exhausted,
      firstFailure: { ...exhausted.firstFailure, phase: "linking" },
    })).toThrow("first JIT failure phase is invalid");
    expect(() => decodeJitHealthProfile({
      ...exhausted,
      firstFailure: { ...exhausted.firstFailure, message: "m".repeat(257) },
    })).toThrow("first JIT failure error is too long");
    expect(() => decodeJitHealthProfile({ ...exhausted, extra: 1 })).toThrow(VMError);
    expect(() => decodeJitHealthProfile({
      ...exhausted,
      failures: { ...exhausted.failures, other: 0 },
    })).toThrow(VMError);
  });

  it("matches the sticky failure to the first failure", () => {
    expect(stickyFailureMatchesHealth(null, emptyJitHealthProfile())).toBe(true);
    expect(stickyFailureMatchesHealth(
      { generation: 4, cacheKey: 0x99n, reason: "code-memory" },
      exhausted,
    )).toBe(true);
    expect(stickyFailureMatchesHealth(null, exhausted)).toBe(false);
    expect(stickyFailureMatchesHealth(
      { generation: 4, cacheKey: 0x98n, reason: "code-memory" },
      exhausted,
    )).toBe(false);
  });

  it("admits the code-memory sticky reason from schema 47 only", () => {
    const sticky = { generation: 1, cacheKey: 2n, reason: "code-memory" };
    expect(decodeJitFailure(sticky, 47)).toEqual(sticky);
    expect(() => decodeJitFailure(sticky, 46)).toThrow("sticky JIT failure reason is invalid");
    expect(decodeJitFailure({ ...sticky, reason: "module-abi" }, 21))
      .toEqual({ ...sticky, reason: "module-abi" });
  });
});
