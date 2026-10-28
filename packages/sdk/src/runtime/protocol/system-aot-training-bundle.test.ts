import { describe, expect, it } from "vitest";

import {
  decodeSystemAotTrainingBundle,
  encodeSystemAotTrainingBundle,
  validateSystemAotTrainingBundle,
} from "./system-aot-training-bundle.js";
import type { SystemTraceJitModule } from "./system.js";
import { JIT_REGION_MAX_INSTRUCTIONS } from "../jit-cache.js";

describe("system AOT training bundle", () => {
  it("round-trips bounded exact source, runtime, and cumulative timing identity", () => {
    const module = trainingModule();
    const bytes = encodeSystemAotTrainingBundle([module], 7);
    expect(validateSystemAotTrainingBundle(bytes)).toBe(bytes);
    const decoded = decodeSystemAotTrainingBundle(bytes);
    expect(decoded.droppedModules).toBe(7);
    expect(decoded.modules).toHaveLength(1);
    expect(decoded.modules[0]).toMatchObject({
      profileModuleId: module.profileModuleId,
      cacheKey: module.cacheKey,
      tier: "tier1",
      runtimeIdentity: module.runtimeIdentity,
      aotTrainingSource: module.aotTrainingSource,
      aotTraining: module.aotTraining,
    });
  });

  it("retains segmented fetch dependencies and historical unknowns in version 4", () => {
    const base = trainingModule();
    expect(base.runtimeIdentity).not.toBeNull();
    const segmented = { ...base, runtimeIdentity: base.runtimeIdentity === null ? null : {
      ...base.runtimeIdentity, mode: "protected" as const, codeSegmentBase: 0x1000n, codeSegmentLimit: 0x1234,
    } };
    const current = decodeSystemAotTrainingBundle(encodeSystemAotTrainingBundle([segmented], 0));
    expect(current.version).toBe(4);
    expect(current.modules[0]?.runtimeIdentity).toMatchObject({ codeSegmentBase: 0x1000n, codeSegmentLimit: 0x1234 });
    const unknown = { ...base, runtimeIdentity: base.runtimeIdentity === null ? null : {
      ...base.runtimeIdentity, codeSegmentBase: null, codeSegmentLimit: null,
    } };
    expect(decodeSystemAotTrainingBundle(encodeSystemAotTrainingBundle([unknown], 0)).modules[0]?.runtimeIdentity)
      .toMatchObject({ codeSegmentBase: null, codeSegmentLimit: null });
  });

  it("rejects corruption, truncation, trailing bytes, and duplicate identities", () => {
    const bytes = encodeSystemAotTrainingBundle([trainingModule()], 0);
    const corrupt = bytes.slice();
    corrupt[0] = 0;
    expect(() => validateSystemAotTrainingBundle(corrupt)).toThrow(TypeError);
    expect(() => validateSystemAotTrainingBundle(bytes.subarray(0, bytes.length - 1))).toThrow(TypeError);
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => validateSystemAotTrainingBundle(trailing)).toThrow(TypeError);
    expect(() => encodeSystemAotTrainingBundle([trainingModule(), trainingModule()], 0))
      .not.toThrow();
    const duplicate = encodeSystemAotTrainingBundle([trainingModule(), trainingModule()], 0);
    expect(() => validateSystemAotTrainingBundle(duplicate)).toThrow(TypeError);
  });

  it("keeps legacy Tier-1 bundles readable and rejects incompatible source tiers", () => {
    const module = trainingModule();
    const legacy = encodeSystemAotTrainingBundle([{ ...module, runtimeIdentity: module.runtimeIdentity === null ? null : { ...module.runtimeIdentity, capabilityRevision: 0 } }], 0);
    const historical = new Uint8Array(legacy.length - 16);
    historical.set(legacy.subarray(0, 128));
    historical.set(legacy.subarray(144), 128);
    const historicalView = new DataView(historical.buffer);
    historicalView.setUint16(4, 1, true);
    historicalView.setBigUint64(16, BigInt(historical.length - 24), true);
    historicalView.setUint32(24, historical.length - 24, true);
    expect(decodeSystemAotTrainingBundle(historical).version).toBe(1);
    expect(() => encodeSystemAotTrainingBundle([{ ...trainingModule(), tier: "tier2" }], 0))
      .toThrow("source version does not match its tier");
    new DataView(historical.buffer).setUint16(4, 5, true);
    expect(() => decodeSystemAotTrainingBundle(historical)).toThrow(TypeError);
  });

  it("bounds exports and reports omitted cold modules while preserving hot Tier-2 source", () => {
    const base = trainingModule();
    const instructions = Array.from({ length: JIT_REGION_MAX_INSTRUCTIONS }, (_, index) => ({
      rip: 0x1000n + BigInt(index), bytes: "90", semantic: 1, instructionForm: 7,
      edge: { kind: "fallthrough", target: 0x1001n + BigInt(index) } as const,
    }));
    const cold = Array.from({ length: 700 }, (_, index): SystemTraceJitModule => ({
      ...base,
      profileModuleId: BigInt(index + 1).toString(16).padStart(16, "0"),
      aotTrainingSource: { version: 1, instructions },
    }));
    const hot: SystemTraceJitModule = {
      ...base, profileModuleId: "ffffffffffffffff", tier: "tier2",
      aotTrainingSource: { version: 2, instructions: instructions.slice(0, 256) },
      aotTraining: { ...base.aotTraining, outerEntries: 1_000, outerRetired: 99_999n },
    };
    const encoded = encodeSystemAotTrainingBundle([...cold, hot], 3);
    expect(encoded.byteLength).toBeLessThanOrEqual(128 * 1024 * 1024);
    const decoded = decodeSystemAotTrainingBundle(encoded);
    expect(decoded.modules.find(module => module.profileModuleId === hot.profileModuleId))
      .toMatchObject({ tier: "tier2", aotTrainingSource: hot.aotTrainingSource });
    expect(decoded.droppedModules).toBe(3 + cold.length + 1 - decoded.modules.length);
    expect(decoded.droppedModules).toBeGreaterThan(3);
  }, 30_000);
});

function trainingModule(): SystemTraceJitModule {
  return {
    profileModuleId: "0123456789abcdef",
    cacheKey: 9n,
    tier: "tier1",
    recordedProfileGeneration: null,
    runtimeIdentity: {
      mode: "long",
      cpl: 3,
      profile: "x86-64-v3",
      codeAttributes: 0x1234,
      codeSegmentBase: 0n,
      codeSegmentLimit: 0xffff_ffff,
      capabilityRevision: 1,
      addressSpaceId: 0x4567_8000n,
      addressSpaceScoped: true,
      codePages: [{
        linear: 0x1000n,
        physical: 0x9000n,
        generation: 17n,
        globalSupervisor: false,
      }],
    },
    aotTrainingSource: {
      version: 1,
      instructions: [{
        rip: 0x1000n,
        bytes: "90",
        semantic: 1,
        instructionForm: 7,
        edge: { kind: "direct", target: 0x1001n },
      }],
    },
    aotTraining: {
      emissions: 2,
      emittedBytes: 1_024,
      compilationMilliseconds: 1.25,
      instantiationMilliseconds: 0.5,
      installationMilliseconds: 0.125,
      outerEntries: 8,
      outerRetired: 13n,
    },
    instructions: [{ rip: 0x1000n, semantic: 1, retired: 1, instructionForm: 7 }],
    operations: [],
    plan: {
      initialStateMask: 0n,
      dirtyStateMask: 0n,
      stateMaterializationBoundaries: 0,
      segmentGuards: 0,
    },
  };
}
