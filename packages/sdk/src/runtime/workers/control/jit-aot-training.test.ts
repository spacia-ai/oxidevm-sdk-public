import { describe, expect, it } from "vitest";

import { JIT_DISPATCH_TABLE_ENTRIES } from "../../jit-cache.js";
import type { SystemTraceJitModule } from "../../protocol/system.js";
import { ProfileJitModuleStore } from "./jit-aot-training.js";

describe("profile JIT AOT training retention", () => {
  it("keeps the bounded modules with the greatest measured compilation cost", () => {
    const store = new ProfileJitModuleStore();
    for (let index = 0; index < JIT_DISPATCH_TABLE_ENTRIES; index += 1) {
      expect(store.retain(module(index, index + 1))).toBe("retained");
    }

    expect(store.retain(module(JIT_DISPATCH_TABLE_ENTRIES, 100_000))).toBe("replaced");
    expect(store.size).toBe(JIT_DISPATCH_TABLE_ENTRIES);
    expect(store.get(id(0))).toBeUndefined();
    expect(store.get(id(JIT_DISPATCH_TABLE_ENTRIES))).toBeDefined();
    expect(store.retain(module(JIT_DISPATCH_TABLE_ENTRIES + 1, 0))).toBe("dropped");
  }, 30_000);

  it("accumulates compile and exact outer-entry evidence", () => {
    const store = new ProfileJitModuleStore();
    store.retain(module(7, 3));
    store.retain(module(7, 5));
    store.recordOuterExecution(id(7), 19n);

    expect(store.get(id(7))?.aotTraining).toMatchObject({
      emissions: 2,
      emittedBytes: 200,
      compilationMilliseconds: 8,
      outerEntries: 1,
      outerRetired: 19n,
    });
  });

  it("retains Tier-2 source evidence when cheaper modules fill the store", () => {
    const store = new ProfileJitModuleStore();
    for (let index = 0; index < JIT_DISPATCH_TABLE_ENTRIES; index += 1) {
      store.retain(module(index, 10));
    }
    const trace = { ...module(JIT_DISPATCH_TABLE_ENTRIES, 0), tier: "tier2" as const };
    expect(store.retain(trace)).toBe("replaced");
    expect(store.get(trace.profileModuleId)).toEqual(trace);
    expect(store.retain(module(JIT_DISPATCH_TABLE_ENTRIES + 1, 100))).toBe("replaced");
    expect(store.get(trace.profileModuleId)).toEqual(trace);
    expect(store.size).toBe(JIT_DISPATCH_TABLE_ENTRIES);
  });
});

function module(index: number, compilationMilliseconds: number): SystemTraceJitModule {
  return {
    profileModuleId: id(index),
    cacheKey: BigInt(index),
    tier: "tier1",
    recordedProfileGeneration: null,
    runtimeIdentity: null,
    aotTrainingSource: null,
    aotTraining: {
      emissions: 1,
      emittedBytes: 100,
      compilationMilliseconds,
      instantiationMilliseconds: compilationMilliseconds / 2,
      installationMilliseconds: compilationMilliseconds / 4,
      outerEntries: 0,
      outerRetired: 0n,
    },
    instructions: [{ rip: BigInt(index), semantic: 1, retired: 1, instructionForm: 1 }],
    operations: [],
    plan: {
      initialStateMask: 0n,
      dirtyStateMask: 0n,
      stateMaterializationBoundaries: 0,
      segmentGuards: 0,
    },
  };
}

function id(index: number): string {
  return index.toString(16).padStart(16, "0");
}
