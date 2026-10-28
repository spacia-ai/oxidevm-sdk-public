import { expect, it } from "vitest";
import { decodeJitModules } from "./system-trace.js";

const module = {
  profileModuleId: "0000000000000007", cacheKey: 9n, tier: "tier1",
  recordedProfileGeneration: null,
  runtimeIdentity: { mode: "long", cpl: 3, profile: "x86-64-v2", codeAttributes: 0,
    codeSegmentBase: null, codeSegmentLimit: null, capabilityRevision: 0,
    addressSpaceId: 1n, addressSpaceScoped: true,
    codePages: [{ linear: 0n, physical: 0x1000n, generation: 1n, globalSupervisor: false }] },
  aotTrainingSource: null,
  aotTraining: { emissions: 0, emittedBytes: 0, compilationMilliseconds: 0, instantiationMilliseconds: 0, installationMilliseconds: 0, outerEntries: 0, outerRetired: 0n },
  instructions: [{ rip: 16n, semantic: 0, retired: 1, instructionForm: 0 }],
  operations: [], loopPolicy: null,
  plan: { initialStateMask: 0n, dirtyStateMask: 0n, stateMaterializationBoundaries: 0, segmentGuards: 0 },
};
const binding = { bindingIdentity: { id: 7n, originBindingId: 3n }, artifactProfileModuleId: null,
  artifactIdentity: { cacheKey: 4n, moduleLength: 128 } };

it("preserves exact artifact and destination binding identities in current records", () => {
  expect(decodeJitModules([{ ...module, ...binding }], 53)).toMatchObject([{ ...binding, cacheKey: 9n }]);
  expect(decodeJitModules([module], 52)).toMatchObject([{ profileModuleId: module.profileModuleId }]);
  expect(() => decodeJitModules([{ ...module, ...binding }], 52)).toThrow();
});

it("rejects missing, unknown or out-of-range artifact and binding fields", () => {
  expect(() => decodeJitModules([{ ...module, ...binding, artifactIdentity: undefined }], 53)).toThrow();
  for (const artifactIdentity of [
    { cacheKey: 0n, moduleLength: 128 }, { cacheKey: 1n << 64n, moduleLength: 128 },
    { cacheKey: 4n, moduleLength: 0 }, { cacheKey: 4n, moduleLength: 2 ** 32 },
    { cacheKey: 4n, moduleLength: 128, unknown: true },
  ]) expect(() => decodeJitModules([{ ...module, ...binding, artifactIdentity }], 53)).toThrow();
  for (const bindingIdentity of [
    { id: 0n, originBindingId: 0n }, { id: 7n, originBindingId: 8n },
    { id: 8n, originBindingId: 3n }, { id: 7n, originBindingId: 3n, unknown: true },
  ]) expect(() => decodeJitModules([{ ...module, ...binding, bindingIdentity }], 53)).toThrow();
});
