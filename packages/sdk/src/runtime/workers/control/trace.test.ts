import { describe, expect, it } from "vitest";

import type { JitRuntimeIdentity } from "../../protocol/system-trace-jit.js";
import { EMPTY_JIT_AOT_TRAINING_STATS } from "../../protocol/system-trace-jit-aot.js";
import { sampledProfileJitEvidence } from "./trace.js";

function runtimeIdentity(rip: bigint): JitRuntimeIdentity {
  const page = rip & ~0xfffn;
  return {
    mode: "long",
    cpl: 3,
    profile: "x86-64-v2",
    capabilityRevision: 1,
    codeAttributes: 0,
    codeSegmentBase: 0n,
    codeSegmentLimit: 0xffff_ffff,
    addressSpaceId: null,
    addressSpaceScoped: false,
    codePages: [{
      linear: page,
      physical: page,
      generation: 1n,
      globalSupervisor: false,
    }],
  };
}

describe("profile JIT trace export", () => {
  it("retains module identity and only operations selected by exact samples", () => {
    const operation = (sourceIndex: number, operationKind: number) => ({
      instructionIndex: 0,
      sourceIndex,
      disposition: "emitted" as const,
      emittedStart: sourceIndex,
      emittedEnd: sourceIndex + 1,
      wireStart: sourceIndex + 10,
      wireEnd: sourceIndex + 11,
      instructionForm: 7,
      operationKind,
      proofCostClass: "unchanged-generated-work" as const,
    });
    const modules = [{
      profileModuleId: "0123456789abcdef",
      cacheKey: 9n,
      tier: "tier1" as const,
      recordedProfileGeneration: null,
      runtimeIdentity: runtimeIdentity(0x1000n),
      aotTrainingSource: null,
      aotTraining: EMPTY_JIT_AOT_TRAINING_STATS,
      instructions: [{ rip: 0x1000n, semantic: 3, retired: 1, instructionForm: 7 }],
      operations: [operation(0, 11), operation(1, 12)],
      plan: {
        initialStateMask: 0n,
        dirtyStateMask: 0n,
        stateMaterializationBoundaries: 0,
        segmentGuards: 0,
      },
    }, {
      profileModuleId: "fedcba9876543210",
      cacheKey: 10n,
      tier: "tier1" as const,
      recordedProfileGeneration: null,
      runtimeIdentity: runtimeIdentity(0x2000n),
      aotTrainingSource: null,
      aotTraining: EMPTY_JIT_AOT_TRAINING_STATS,
      instructions: [{ rip: 0x2000n, semantic: 4, retired: 1, instructionForm: 8 }],
      operations: [operation(0, 13)],
      plan: {
        initialStateMask: 0n,
        dirtyStateMask: 0n,
        stateMaterializationBoundaries: 0,
        segmentGuards: 0,
      },
    }];

    const compact = sampledProfileJitEvidence(modules, [{
      profileModuleId: "0123456789abcdef",
      instructionIndex: 0,
      sourceIndex: 1,
      operationKind: 12,
      samples: 4,
    }], []);

    expect(compact.modules).toEqual([
      { ...modules[0], operations: [operation(1, 12)] },
      { ...modules[1], operations: [] },
    ]);
    expect(compact.samples).toHaveLength(1);
    expect(compact.droppedSamples).toBe(0);
  });

  it("does not scan unsampled operation maps", () => {
    const rawOperations = Array.from({ length: 4_096 }, (_, index) => ({
      instructionIndex: Math.floor(index / 24),
      sourceIndex: index % 24,
      disposition: "emitted" as const,
      emittedStart: index,
      emittedEnd: index + 1,
      wireStart: index + 10,
      wireEnd: index + 11,
      instructionForm: 7,
      operationKind: index,
      proofCostClass: "unchanged-generated-work" as const,
    }));
    let operationReads = 0;
    const operations = new Proxy(rawOperations, {
      get(target, property, receiver): unknown {
        if (typeof property === "string" && /^\d+$/u.test(property)) {
          operationReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const module = {
      profileModuleId: "0123456789abcdef",
      cacheKey: 9n,
      tier: "tier1" as const,
      recordedProfileGeneration: null,
      runtimeIdentity: runtimeIdentity(0x1000n),
      aotTrainingSource: null,
      aotTraining: EMPTY_JIT_AOT_TRAINING_STATS,
      instructions: [],
      operations,
      plan: {
        initialStateMask: 0n,
        dirtyStateMask: 0n,
        stateMaterializationBoundaries: 0,
        segmentGuards: 0,
      },
    };
    const selected = rawOperations.at(-1);
    if (selected === undefined) throw new Error("operation fixture is empty");

    const compact = sampledProfileJitEvidence([module], [{
      profileModuleId: module.profileModuleId,
      instructionIndex: selected.instructionIndex,
      sourceIndex: selected.sourceIndex,
      operationKind: selected.operationKind,
      samples: 1,
    }], []);

    expect(compact.modules[0]?.operations).toEqual([selected]);
    expect(operationReads).toBeLessThan(64);
  });

  it("keeps every sampled module map so exact evidence is not truncated", () => {
    const modules = Array.from({ length: 1_025 }, (_, index) => ({
      profileModuleId: index.toString(16).padStart(16, "0"),
      cacheKey: BigInt(index),
      tier: "tier1" as const,
      recordedProfileGeneration: null,
      runtimeIdentity: runtimeIdentity(BigInt(index) << 12n),
      aotTrainingSource: null,
      aotTraining: EMPTY_JIT_AOT_TRAINING_STATS,
      instructions: [],
      operations: [{
        instructionIndex: 0,
        sourceIndex: 0,
        disposition: "emitted" as const,
        emittedStart: 0,
        emittedEnd: 1,
        wireStart: 10,
        wireEnd: 11,
        instructionForm: 7,
        operationKind: 11,
        proofCostClass: "unchanged-generated-work" as const,
      }],
      plan: {
        initialStateMask: 0n,
        dirtyStateMask: 0n,
        stateMaterializationBoundaries: 0,
        segmentGuards: 0,
      },
    }));
    const samples = modules.map((module, index) => ({
      profileModuleId: module.profileModuleId,
      instructionIndex: 0,
      sourceIndex: 0,
      operationKind: 11,
      samples: index + 1,
    }));

    const compact = sampledProfileJitEvidence(modules, samples, []);

    expect(compact.modules).toHaveLength(1_025);
    expect(compact.modules.some((module) => module.profileModuleId === "0000000000000000"))
      .toBe(true);
    expect(compact.samples).toHaveLength(1_025);
    expect(compact.droppedSamples).toBe(0);
  });

  it("retains both endpoints selected by sampled compiled edges", () => {
    const module = (profileModuleId: string, rip: bigint) => ({
      profileModuleId,
      cacheKey: rip,
      tier: "tier1" as const,
      recordedProfileGeneration: null,
      runtimeIdentity: runtimeIdentity(rip),
      aotTrainingSource: null,
      aotTraining: EMPTY_JIT_AOT_TRAINING_STATS,
      instructions: [{ rip, semantic: 3, retired: 1, instructionForm: 7 }],
      operations: [],
      plan: {
        initialStateMask: 0n,
        dirtyStateMask: 0n,
        stateMaterializationBoundaries: 0,
        segmentGuards: 0,
      },
    });
    const source = module("0123456789abcdef", 0x1000n);
    const target = module("fedcba9876543210", 0x2000n);
    const edge = {
      sourceProfileModuleId: source.profileModuleId,
      targetProfileModuleId: target.profileModuleId,
      sourceCacheKey: source.cacheKey,
      targetCacheKey: target.cacheKey,
      sourceCompileGeneration: 1,
      targetCompileGeneration: 2,
      sourceDispatchGeneration: 3,
      targetDispatchGeneration: 4,
      sourceDispatchSlot: 5,
      targetDispatchSlot: 6,
      sourceInstructionIndex: 0,
      targetEntryIndex: 0,
      sourceTier: "tier1" as const,
      targetTier: "tier1" as const,
      sourceRip: source.instructions[0]?.rip ?? 0n,
      targetRip: target.instructions[0]?.rip ?? 0n,
      sourceSemantic: source.instructions[0]?.semantic ?? 0,
      targetSemantic: target.instructions[0]?.semantic ?? 0,
      kind: "direct" as const,
      samples: 9,
      retired: 9n,
    };

    const compact = sampledProfileJitEvidence([source, target], [], [edge]);

    expect(compact.modules).toEqual([source, target]);
    expect(compact.edgeSamples).toEqual([edge]);
    expect(compact.droppedEdgeSamples).toBe(0);
  });

  it("omits diagnostic operation payloads from bounded AOT training exports", () => {
    const operation = {
      instructionIndex: 0,
      sourceIndex: 0,
      disposition: "emitted" as const,
      emittedStart: 0,
      emittedEnd: 1,
      wireStart: 10,
      wireEnd: 11,
      instructionForm: 7,
      operationKind: 11,
      proofCostClass: "unchanged-generated-work" as const,
    };
    const module = {
      profileModuleId: "0123456789abcdef",
      cacheKey: 9n,
      tier: "tier1" as const,
      recordedProfileGeneration: null,
      runtimeIdentity: runtimeIdentity(0x1000n),
      aotTrainingSource: null,
      aotTraining: EMPTY_JIT_AOT_TRAINING_STATS,
      instructions: [{ rip: 0x1000n, semantic: 3, retired: 1, instructionForm: 7 }],
      operations: [operation],
      plan: { initialStateMask: 0n, dirtyStateMask: 0n, stateMaterializationBoundaries: 0, segmentGuards: 0 },
    };
    const compact = sampledProfileJitEvidence([module], [{
      profileModuleId: module.profileModuleId,
      instructionIndex: 0,
      sourceIndex: 0,
      operationKind: 11,
      samples: 7,
    }], [], true);

    expect(compact.modules).toEqual([]);
    expect(compact.samples).toEqual([]);
    expect(compact.droppedSamples).toBe(7);
  });
});
