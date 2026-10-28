import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { decodeCoreRuntimeProfile } from "../core-abi/profile.js";
import { readExportedView } from "./control/core.js";
import { deferredRuntime } from "./control/jit-runtime.test-support.js";
import { engineModulePath } from "./engine-wasm.test-support.js";
import { instantiateRuntime } from "./userspace-runtime.js";
import { mountTestRuntime, spawnRing, runRingTurn, termination, traceRingElf } from "./userspace-tier2.test-support.js";

afterEach(() => vi.restoreAllMocks());

for (const outcome of ["compiled", "failed", "out-of-memory", "instantiation"] as const) {
  it(`keeps Tier 1 available while a deferred raw trace is ${outcome}`, async () => {
    const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
    const base = await instantiateRuntime(await WebAssembly.compile(bytes.buffer), "tier2-test", { kind: "disabled" });
    await base.jitRuntime.dispose();
    const { runtime: jitRuntime, compilers } = deferredRuntime("batched");
    const runtime = { ...base, jitRuntime };
    try {
      mountTestRuntime(runtime, 2);
      const pid = spawnRing(runtime);
      const profile = () => decodeCoreRuntimeProfile(readExportedView(runtime.core, "oxidevm_runtime_profile"));
      let refuseInstantiation = false;
      const Original = WebAssembly.Instance;
      vi.spyOn(WebAssembly, "Instance").mockImplementation(function (module: WebAssembly.Module, imports?: WebAssembly.Imports) {
        if (refuseInstantiation) { refuseInstantiation = false; throw new RangeError("out of memory"); }
        return new Original(module, imports);
      });
      let held = false, released = false, failureObserved = false, tier1Before = 0n;
      for (let turns = 0; turns < 100_000 && termination(runtime, pid) === 0xffff_ffff; turns++) {
        runRingTurn(runtime);
        if (!failureObserved && runtime.core.jitHealth.firstPromotionFailure !== null) {
          failureObserved = true;
          expect(profile().jitTier2Retired).toBe(0n);
          expect(runtime.core.jitHealth.state).toBe("active");
        }
        const compiler = compilers[0];
        if (compiler === undefined) continue;
        // Metadata, rather than compiler call number, identifies the first promoted trace.
        const promoted = profile().jitTier2Compiles > 0n;
        if (!promoted) compiler.release();
        else if (!held) { held = true; tier1Before = profile().jitTier1Retired; }
        else if (!released) {
          expect(compiler.pending).toBe(1);
          expect(profile().jitTier1Retired).toBeGreaterThan(tier1Before);
          expect(profile().jitTier2Retired).toBe(0n);
          compiler.answer = outcome === "instantiation" ? "compiled" : outcome;
          refuseInstantiation = outcome === "instantiation";
          compiler.release();
          released = true;
        } else compiler.release();
      }
      expect(held).toBe(true);
      expect(released).toBe(true);
      expect(termination(runtime, pid)).toBe(Number((4_000_000n * 4_000_001n / 2n) & 255n));
      expect(runtime.core.jitHealth.state).toBe("active");
      if (outcome === "compiled") expect(profile().jitTier2Retired).toBeGreaterThan(0n);
      else {
        expect(failureObserved).toBe(true);
        // The one injected instantiation error must not execute its trace or
        // prohibit a later valid promotion. Compiler failures persist in this
        // fixture, whereas only the first instantiation is refused.
        if (outcome !== "instantiation") expect(profile().jitTier2Retired).toBe(0n);
        expect(runtime.core.jitHealth.firstPromotionFailure?.reason).toBe(outcome === "failed" ? "module-compilation" : "code-memory");
      }
      expect(runtime.core.jitCode.profile().reservedBytes).toBe(0);
    } finally { await jitRuntime.dispose(); }
  }, 30_000);
}

it("promotes independent processes at the same RIP without reusing their code or state", async () => {
  const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
  const base = await instantiateRuntime(await WebAssembly.compile(bytes.buffer), "tier2-spaces", { kind: "disabled" });
  await base.jitRuntime.dispose();
  const { runtime: jitRuntime, compilers } = deferredRuntime("batched");
  const runtime = { ...base, jitRuntime };
  try {
    mountTestRuntime(runtime, 2);
    const first = spawnRing(runtime, traceRingElf(4_000_001));
    const second = spawnRing(runtime, traceRingElf(4_000_003, true));
    for (let turns = 0; turns < 100_000; turns++) {
      runRingTurn(runtime);
      for (const compiler of compilers) compiler.release();
      if (termination(runtime, first) !== 0xffff_ffff && termination(runtime, second) !== 0xffff_ffff) break;
    }
    expect(termination(runtime, first)).toBe(Number(4_000_001n * 4_000_002n / 2n & 255n));
    expect(termination(runtime, second)).toBe(Number(-4_000_003n * 4_000_004n / 2n & 255n));
    const profile = decodeCoreRuntimeProfile(readExportedView(runtime.core, "oxidevm_runtime_profile"));
    expect(profile.jitTier2Compiles).toBeGreaterThanOrEqual(2n);
    expect(profile.jitTier2Retired).toBeGreaterThan(0n);
    expect(runtime.core.jitCode.profile().reservedBytes).toBe(0);
  } finally { await jitRuntime.dispose(); }
}, 30_000);
