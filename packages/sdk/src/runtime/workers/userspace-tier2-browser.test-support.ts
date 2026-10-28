import { decodeCoreRuntimeProfile } from "../core-abi/profile.js";
import { readExportedView } from "./control/core.js";
import { instantiateRuntime } from "./userspace-runtime.js";
import { mountTestRuntime, spawnRing, runRingTurn, termination, traceRingElf } from "./userspace-tier2.test-support.js";

// Browser integration entry point, bundled only by tests/browser/userspace-tier2.spec.ts.
// Guest execution and nested compiler workers both stay off the page's main thread.
async function probe(): Promise<void> {
  const module = await WebAssembly.compileStreaming(fetch("/engine.wasm"));
  const results = [];
  for (const shape of ["ring", "cold-successors"] as const) {
  for (const tier of [1, 2] as const) {
    const runtime = await instantiateRuntime(module, "/engine.wasm", { kind: "disabled" }, "batched");
    try {
      mountTestRuntime(runtime, tier);
      for (let command = 0; command < 3; command++) {
      const before = decodeCoreRuntimeProfile(readExportedView(runtime.core, "oxidevm_runtime_profile"));
      const pid = spawnRing(runtime, traceRingElf(4_000_000, false, shape));
      for (let turns = 0; turns < 100_000 && termination(runtime, pid) === 0xffff_ffff; turns++) {
        runRingTurn(runtime);
        // Yield the execution worker to receive transferable modules from the real compiler.
        if (runtime.jitRuntime.yieldForCompiledModule(runtime.core, 4) || turns % 64 === 0) {
          await new Promise<void>(resolve => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
            channel.port2.postMessage(null);
          });
        }
      }
      const profile = decodeCoreRuntimeProfile(readExportedView(runtime.core, "oxidevm_runtime_profile"));
      results.push({
        shape, tier, command, exit: termination(runtime, pid),
        emissions: String(profile.jitCandidateCompiles - before.jitCandidateCompiles),
        tier1Adoptions: String(profile.jitTierOneReuseAdoptions - before.jitTierOneReuseAdoptions),
        tier2Adoptions: String(profile.jitTierTwoReuseAdoptions - before.jitTierTwoReuseAdoptions),
        tier1Retired: String(profile.jitTier1Retired), tier2Retired: String(profile.jitTier2Retired),
        promotion: Object.fromEntries(Object.entries(profile).filter(([name]) => /tier2|trace/i.test(name)).map(([name, value]) => [name, String(value)])),
        background: runtime.core.traceProfile.worker.backgroundCompile,
        jitState: runtime.core.jitHealth.state,
      });
      }
    } finally { await runtime.jitRuntime.dispose(); }
  }
  }
  self.postMessage({ results });
}

void probe().catch((error: unknown) => {
  self.postMessage({ error: error instanceof Error ? error.message : "non-Error failure" });
});
