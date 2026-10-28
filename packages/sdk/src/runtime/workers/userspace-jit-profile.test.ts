import { expect, it } from "vitest";
import type { SystemTraceJitModule, SystemTraceJitOperationSample } from "../protocol/system.js";
import { EMPTY_JIT_AOT_TRAINING_STATS } from "../protocol/system-trace-jit-aot.js";
import { decodeUserspaceJitProfile } from "../protocol/userspace-jit-profile.js";
import { ProfileJitModuleStore } from "./control/jit-aot-training.js";
import { createSystemTraceProfile } from "./control/telemetry.js";
import { captureUserspaceJitProfile, captureUserspaceJitProfileForRuntime } from "./userspace-jit-profile.js";

function module(index: number, addressSpaceId = 1n): SystemTraceJitModule {
  return { profileModuleId: index.toString(16).padStart(16, "0"), cacheKey: BigInt(index), tier: "tier1", loopPolicy: null,
    recordedProfileGeneration: null, runtimeIdentity: { mode: "long", cpl: 3, profile: "x86-64-v2", codeAttributes: 0x2000,
      capabilityRevision: 1, codeSegmentBase: 0n, codeSegmentLimit: 0xffff_ffff, addressSpaceId, addressSpaceScoped: true,
      codePages: [{ linear: (0x1000n + BigInt(index)) & ~0xfffn, physical: (0x1000n + BigInt(index)) & ~0xfffn, generation: 1n, globalSupervisor: false }] },
    aotTrainingSource: null, aotTraining: EMPTY_JIT_AOT_TRAINING_STATS,
    instructions: [{ rip: 0x1000n + BigInt(index), semantic: 1, retired: 1, instructionForm: 1 }],
    operations: [{ span: "ordinary", instructionIndex: 0, sourceIndex: 0, disposition: "emitted", emittedStart: 0, emittedEnd: 1,
      wireStart: 100, wireEnd: 101, instructionForm: 1, operationKind: 1, proofCostClass: "unchanged-generated-work" }],
    plan: { initialStateMask: 0n, dirtyStateMask: 0n, stateMaterializationBoundaries: 0, segmentGuards: 0 } };
}
it("reads current maps for retained counters and rejects a replacement runtime", () => {
  const profileJitModules = new ProfileJitModuleStore();
  const expected = module(1, 7n); profileJitModules.retain(expected);
  const source = { profileJitModules, traceProfile: createSystemTraceProfile(), runtimeKey: "runtime:completed",
    droppedProfileJitModules: 0, collidingProfileJitModules: 0, profileJitOperationSamples: new Map(),
    profileJitOperationSampleTotal: 0, droppedProfileJitOperationSamples: 0 };
  const captured = captureUserspaceJitProfileForRuntime(source, "runtime:completed", false);
  expect(captured?.modules).toEqual([expected]);
  expect(captured === undefined ? undefined : decodeUserspaceJitProfile(captured)).toEqual(captured);
  expect(captureUserspaceJitProfileForRuntime({ ...source, runtimeKey: "runtime:replacement" }, "runtime:completed", false)).toBeUndefined();
  expect(captureUserspaceJitProfileForRuntime(undefined, "runtime:completed", false)).toBeUndefined();
  expect(profileJitModules.size).toBe(1);
});
it("copies the existing VM map owner and preserves its identities and fallback counts", () => {
  const profileJitModules = new ProfileJitModuleStore(), traceProfile = createSystemTraceProfile();
  const expected = module(1); profileJitModules.retain(expected);
  traceProfile.worker.interpreterReasons.guard.instructions = 3n;
  const sample: SystemTraceJitOperationSample = { profileModuleId: expected.profileModuleId, span: "ordinary", instructionIndex: 0, sourceIndex: 0, operationKind: 1, samples: 5 };
  const source = { profileJitModules, traceProfile, runtimeKey: "runtime:fixture", droppedProfileJitModules: 2, collidingProfileJitModules: 1,
    profileJitOperationSamples: new Map([["sample", sample]]), profileJitOperationSampleTotal: 7, droppedProfileJitOperationSamples: 2 };
  const captured = captureUserspaceJitProfile(source, true);
  expect(captured.modules).toEqual([expected]);
  expect(captured.interpreterReasons.guard.instructions).toBe(3n);
  expect(captured.droppedModules).toBe(2); expect(captured.collidingModules).toBe(1);
  expect(captured.operationSamples).toEqual([sample]); expect(captured.droppedOperationSamples).toBe(2);
  expect(decodeUserspaceJitProfile(captured)).toEqual(captured);
  expect(captureUserspaceJitProfile(source, true)).toEqual(captured);
  expect(profileJitModules.size).toBe(1);
});
it("reports omitted maps without evicting them from the live owner", () => {
  const profileJitModules = new ProfileJitModuleStore();
  for (let index = 0; index < 4097; index++) profileJitModules.retain(module(index));
  const sample: SystemTraceJitOperationSample = { profileModuleId: module(0).profileModuleId, span: "ordinary", instructionIndex: 0, sourceIndex: 0, operationKind: 1, samples: 9 };
  const captured = captureUserspaceJitProfile({ profileJitModules, traceProfile: createSystemTraceProfile(), runtimeKey: "runtime:bounded", droppedProfileJitModules: 3, collidingProfileJitModules: 0,
    profileJitOperationSamples: new Map([["omitted", sample]]), profileJitOperationSampleTotal: 12, droppedProfileJitOperationSamples: 3 }, true);
  expect(captured.modules).toHaveLength(4096); expect(captured.droppedModules).toBe(4);
  expect(captured.modules[0]?.profileModuleId).toBe(module(4096).profileModuleId);
  expect(profileJitModules.size).toBe(4097);
  expect(captured.operationSamples).toEqual([]); expect(captured.droppedOperationSamples).toBe(12);
});
it("keeps a recent address-space binding visible after the diagnostic module bound", () => {
  const profileJitModules = new ProfileJitModuleStore();
  for (let index = 0; index < 4096; index++) profileJitModules.retain(module(index));
  profileJitModules.retain(module(4096, 2n));
  const captured = captureUserspaceJitProfile({ profileJitModules, traceProfile: createSystemTraceProfile(), runtimeKey: "runtime:recent",
    droppedProfileJitModules: 0, collidingProfileJitModules: 0, profileJitOperationSamples: new Map(),
    profileJitOperationSampleTotal: 0, droppedProfileJitOperationSamples: 0 }, false);
  expect(captured.modules.some(module => module.runtimeIdentity?.addressSpaceId === 2n)).toBe(true);
  expect(captured.droppedModules).toBe(1); expect(profileJitModules.size).toBe(4097);
});
