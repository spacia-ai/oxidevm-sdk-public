import { describe, expect, it } from "vitest";

import { VMError } from "../errors.js";
import {
  backgroundCompileReconciles,
  decodeBackgroundCompileProfile,
  emptyBackgroundCompileProfile,
} from "./system-trace-background-compile.js";

describe("background compile profile", () => {
  const profile = {
    ...emptyBackgroundCompileProfile(),
    installMode: "batched",
    submitted: 9,
    joined: 2,
    refused: 1,
    queueFull: 0,
    compiled: 5,
    failed: 0,
    abandoned: 1,
    discarded: 1,
    staleResults: 1,
    inFlight: 2,
    peakInFlight: 4,
    compileMilliseconds: 3.5,
    latencyMilliseconds: 12.25,
    earlyYields: 3,
    batches: 2,
    batchedModules: 5,
    largestBatch: 3,
    linkFailures: 1,
  } as const;

  it("decodes a profile whose outcomes reconcile with its submissions", () => {
    expect(decodeBackgroundCompileProfile(profile, 45)).toEqual(profile);
    expect(backgroundCompileReconciles(emptyBackgroundCompileProfile())).toBe(true);
  });

  it("rejects outcomes that do not account for every submission", () => {
    expect(() => decodeBackgroundCompileProfile({ ...profile, compiled: 6 }, 45))
      .toThrow("background compile counters do not reconcile");
    expect(() => decodeBackgroundCompileProfile({ ...profile, peakInFlight: 1 }, 45))
      .toThrow(VMError);
  });

  it("rejects batches that cannot hold their modules", () => {
    for (const batches of [
      { batches: 0, batchedModules: 5, largestBatch: 3 },
      { batches: 1, batchedModules: 1, largestBatch: 1 },
      { batches: 2, batchedModules: 7, largestBatch: 3 },
      { batches: 2, batchedModules: 10, largestBatch: 5 },
      { batches: 1, batchedModules: 2, largestBatch: 257 },
    ]) {
      expect(() => decodeBackgroundCompileProfile({ ...profile, ...batches }, 45))
        .toThrow("background compile counters do not reconcile");
    }
  });

  it("decodes schema 44 profiles without batches", () => {
    const deferred = { ...profile, installMode: "deferred" } as const;
    const unbatched: Record<string, unknown> = { ...deferred };
    for (const key of ["batches", "batchedModules", "largestBatch", "linkFailures"]) {
      Reflect.deleteProperty(unbatched, key);
    }

    expect(decodeBackgroundCompileProfile(unbatched, 44)).toEqual({
      ...deferred,
      batches: 0,
      batchedModules: 0,
      largestBatch: 0,
      linkFailures: 0,
    });
    expect(() => decodeBackgroundCompileProfile({ ...unbatched, installMode: "batched" }, 44))
      .toThrow("JIT install mode is invalid");
    expect(() => decodeBackgroundCompileProfile(profile, 44)).toThrow();
    expect(() => decodeBackgroundCompileProfile(unbatched, 45)).toThrow();
  });

  it("rejects unknown install modes, fallbacks and fields", () => {
    expect(() => decodeBackgroundCompileProfile({ ...profile, installMode: "linked" }, 45))
      .toThrow("JIT install mode is invalid");
    expect(() => decodeBackgroundCompileProfile({ ...profile, fallback: "worker-crashed" }, 45))
      .toThrow("background compile fallback is invalid");
    expect(() => decodeBackgroundCompileProfile({ ...profile, extra: 1 }, 45)).toThrow();
  });
});
