import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { decodeCoreRuntimeProfile } from "../core-abi/profile.js";
import { readExportedView } from "./control/core.js";
import { clearJitBlocks } from "./control/jit-blocks.js";
import { deferredRuntime } from "./control/jit-runtime.test-support.js";
import { engineModulePath } from "./engine-wasm.test-support.js";
import { instantiateRuntime } from "./userspace-runtime.js";
import { mountTestRuntime, spawnRing, runRingTurn, termination, traceRingElf, forkRingElf } from "./userspace-tier2.test-support.js";

for (const tier of [1, 2] as const) {
  it(`reuses translations after process exit under Tier ${String(tier)} policy`, async () => {
    const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
    const base = await instantiateRuntime(await WebAssembly.compile(bytes.buffer), "early-reuse", { kind: "disabled" });
    await base.jitRuntime.dispose();
    const { runtime: jitRuntime, compilers } = deferredRuntime("batched");
    const runtime = { ...base, jitRuntime };
    try {
      mountTestRuntime(runtime, tier);
      const profile = () => decodeCoreRuntimeProfile(readExportedView(runtime.core, "oxidevm_runtime_profile"));
      for (let command = 0; command < 3; command++) {
        const before = profile();
        const pid = spawnRing(runtime, traceRingElf());
        for (let turns = 0; turns < 100_000 && termination(runtime, pid) === 0xffff_ffff; turns++) {
          runRingTurn(runtime);
          for (const compiler of compilers) compiler.release();
        }
        expect(termination(runtime, pid)).toBe(Number(4_000_000n * 4_000_001n / 2n & 255n));
        expect(runtime.core.jitHealth.state).toBe("active");
        const after = profile();
        if (command !== 0) {
          expect(after.jitCandidateCompiles).toBe(before.jitCandidateCompiles);
          const adopted = tier === 1 ? after.jitTierOneReuseAdoptions - before.jitTierOneReuseAdoptions
            : after.jitTierTwoReuseAdoptions - before.jitTierTwoReuseAdoptions;
          expect(adopted).toBeGreaterThan(0n);
          if (tier === 2) expect(after.jitTier2Retired).toBeGreaterThan(before.jitTier2Retired);
        }
        if (tier === 1) expect(after.jitTierTwoReuseAdoptions).toBe(0n);
        for (const block of runtime.core.jitBlocks.values()) expect(block.bindings.size).toBeLessThanOrEqual(1);
      }
      const bindings = [...runtime.core.profileJitModules.values()].filter(module => module.bindingIdentity !== undefined);
      const ids = new Set(bindings.map(module => module.bindingIdentity?.id));
      expect(ids.size).toBe(bindings.length);
      for (const binding of bindings) {
        expect(binding.artifactIdentity?.moduleLength).toBeGreaterThan(8);
        const identity = binding.bindingIdentity;
        if (identity === undefined || identity.id === identity.originBindingId) continue;
        const origin = runtime.core.profileJitModules.get(identity.originBindingId.toString(16).padStart(16, "0"));
        expect(origin?.recordedProfileGeneration).toBe(binding.recordedProfileGeneration);
        expect(origin?.runtimeIdentity?.addressSpaceId).not.toBe(binding.runtimeIdentity?.addressSpaceId);
      }
      expect(bindings.some(module => module.bindingIdentity?.id !== module.bindingIdentity?.originBindingId)).toBe(true);
      expect(runtime.core.jitCode.profile().reservedBytes).toBe(0);
    } finally { await jitRuntime.dispose(); }
  }, 60_000);
}

it("retains Tier-2 provenance when an adopted trace takes different branches", async () => {
  const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
  const base = await instantiateRuntime(await WebAssembly.compile(bytes.buffer), "reuse-guards", { kind: "disabled" });
  await base.jitRuntime.dispose();
  const { runtime: jitRuntime, compilers } = deferredRuntime("batched");
  const runtime = { ...base, jitRuntime };
  try {
    mountTestRuntime(runtime, 2);
    const profile = () => decodeCoreRuntimeProfile(readExportedView(runtime.core, "oxidevm_runtime_profile"));
    for (const [iterations, branch] of [[4_000_000, 0], [10_000, 1]] as const) {
      const before = profile();
      const retired = runtime.core.runtimeStats.jitInstructions + runtime.core.runtimeStats.interpretedInstructions;
      const pid = spawnRing(runtime, branchElf(iterations, branch));
      for (let turn = 0; turn < 100_000 && termination(runtime, pid) === 0xffff_ffff; turn++) {
        runRingTurn(runtime);
        for (const compiler of compilers) compiler.release();
      }
      expect(termination(runtime, pid)).toBe(Number(BigInt(iterations) * BigInt(iterations + 1) / 2n & 255n));
      if (branch === 1) {
        expect(profile().jitTierTwoReuseAdoptions).toBeGreaterThan(before.jitTierTwoReuseAdoptions);
        const committed = runtime.core.runtimeStats.jitInstructions + runtime.core.runtimeStats.interpretedInstructions - retired;
        expect(committed).toBeGreaterThan(BigInt(iterations) * 900n);
      }
    }
    expect(runtime.core.jitHealth.state).toBe("active");
  } finally { await jitRuntime.dispose(); }
}, 60_000);

it("drops delayed bindings for an exited process and can adopt the artifact again", async () => {
  const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
  const base = await instantiateRuntime(await WebAssembly.compile(bytes.buffer), "reuse-retirement", { kind: "disabled" });
  await base.jitRuntime.dispose();
  const { runtime: jitRuntime, compilers } = deferredRuntime("batched");
  const runtime = { ...base, jitRuntime };
  try {
    mountTestRuntime(runtime, 1);
    for (const iterations of [4_000_000, 1, 4_000_000]) {
      const pid = spawnRing(runtime, traceRingElf(iterations));
      for (let turn = 0; turn < 100_000 && termination(runtime, pid) === 0xffff_ffff; turn++) {
        runRingTurn(runtime);
        if (iterations !== 1) for (const compiler of compilers) compiler.release();
      }
      expect(termination(runtime, pid)).toBe(Number(BigInt(iterations) * BigInt(iterations + 1) / 2n & 255n));
      if (iterations === 4_000_000) clearJitBlocks(runtime.core, "byte-capacity");
      else for (const compiler of compilers) compiler.release();
    }
    expect(runtime.core.jitHealth.state).toBe("active");
    expect(runtime.core.jitCode.profile().reservedBytes).toBe(0);
  } finally { await jitRuntime.dispose(); }
}, 60_000);

function branchElf(iterations: number, branch: number): Uint8Array<ArrayBuffer> {
  const elf = traceRingElf(iterations, false, "cold-successors");
  const code = elf.subarray(120);
  // Both commands compare r12 with r13. Only the uncompiled initialization differs.
  for (const at of [131, 4101, 8200]) code[at + 2] = 0xec;
  code.set([0x41, 0xbc, branch, 0, 0, 0, 0xe9, 0, 0, 0, 0], 7);
  new DataView(elf.buffer).setInt32(120 + 14, 128 - 18, true);
  return elf;
}

for (const tier of [1, 2] as const) {
  it(`adopts the parent's existing Tier ${String(tier)} translation after fork`, async () => {
    const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
    const base = await instantiateRuntime(await WebAssembly.compile(bytes.buffer), "reuse-fork", { kind: "disabled" });
    await base.jitRuntime.dispose();
    const { runtime: jitRuntime, compilers } = deferredRuntime("batched");
    const runtime = { ...base, jitRuntime };
    try {
      mountTestRuntime(runtime, tier);
      const pid = spawnRing(runtime, forkRingElf());
      for (let turn = 0; turn < 100_000 && termination(runtime, pid) === 0xffff_ffff; turn++) {
        runRingTurn(runtime);
        for (const compiler of compilers) compiler.release();
      }
      expect(termination(runtime, pid)).toBe(0);
      const profile = decodeCoreRuntimeProfile(readExportedView(runtime.core, "oxidevm_runtime_profile"));
      expect(tier === 1 ? profile.jitTierOneReuseAdoptions : profile.jitTierTwoReuseAdoptions).toBeGreaterThan(0n);
      expect(runtime.core.jitHealth.state).toBe("active");
    } finally { await jitRuntime.dispose(); }
  }, 60_000);
}
