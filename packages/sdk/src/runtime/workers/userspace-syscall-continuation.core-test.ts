import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { decodeCoreRuntimeProfile } from "../core-abi/profile.js";
import { readExportedView } from "./control/core.js";
import { deferredRuntime } from "./control/jit-runtime.test-support.js";
import { engineModulePath } from "./engine-wasm.test-support.js";
import { instantiateRuntime } from "./userspace-runtime.js";
import { coldSyscallsElf, readySyscallsElf, filteredSyscallElf, signalledSyscallElf } from "./userspace-syscall-continuation.test-support.js";
import { mountTestRuntime, runRingTurn, spawnRing, termination } from "./userspace-tier2.test-support.js";

for (const tier of [1, 2] as const) {
  for (const budget of [1, 2, 3, 7, 100_000]) {
  it(`completes cold ready syscalls in Wasm under Tier ${String(tier)} with budget ${String(budget)}`, async () => {
    const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
    const runtime = await instantiateRuntime(await WebAssembly.compile(bytes.buffer), "syscall-continuation", { kind: "disabled" }, "immediate");
    const observed = vi.spyOn(runtime.jitRuntime, "runLinuxBlock");
    try {
      mountTestRuntime(runtime, tier);
      const pid = spawnRing(runtime, coldSyscallsElf(32));
      for (let turn = 0; turn < 100 && termination(runtime, pid) === 0xffff_ffff; turn++) runRingTurn(runtime, budget);
      expect(termination(runtime, pid)).toBe(0);
      const external = observed.mock.results.filter(result => result.type === "return" && result.value?.kind === "adapter-exit").length;
      const profile = decodeCoreRuntimeProfile(readExportedView(runtime.core, "oxidevm_runtime_profile"));
      console.log({ tier, budget, external, resident: String(profile.jitResidentAdapterCompletions), interpreted: String(runtime.core.runtimeStats.interpretedInstructions) });
      expect(external).toBe(0);
      expect(profile.jitResidentAdapterCompletions).toBe(33n);
      expect(runtime.core.runtimeStats.interpretedInstructions).toBe(67n);
    } finally { observed.mockRestore(); await runtime.jitRuntime.dispose(); }
  });
  }
}

for (const [name, fixture] of [["seccomp", filteredSyscallElf], ["signal and sigreturn", signalledSyscallElf]] as const) {
  it(`preserves Rust ${name} handling during cold syscall continuation`, async () => {
    const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
    const runtime = await instantiateRuntime(await WebAssembly.compile(bytes.buffer), "syscall-policy", { kind: "disabled" }, "immediate");
    try {
      mountTestRuntime(runtime, 2);
      const pid = spawnRing(runtime, fixture());
      for (let turn = 0; turn < 1_000 && termination(runtime, pid) === 0xffff_ffff; turn++) runRingTurn(runtime, 7);
      expect(termination(runtime, pid)).toBe(0);
      expect(runtime.core.jitHealth.state).toBe("active");
    } finally { await runtime.jitRuntime.dispose(); }
  });
}

for (const operation of ["getpid", "futex-wake"] as const) {
  it(`preserves syscall results and instruction counts for ${operation}`, async () => {
    const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
    const runtime = await instantiateRuntime(await WebAssembly.compile(bytes.buffer), "ready-syscall-loop", { kind: "disabled" }, "immediate");
    try {
      mountTestRuntime(runtime, 2);
      const pid = spawnRing(runtime, readySyscallsElf(2_000, operation));
      for (let turn = 0; turn < 10_000 && termination(runtime, pid) === 0xffff_ffff; turn++) runRingTurn(runtime);
      expect(termination(runtime, pid)).toBe(0);
      const stats = runtime.core.runtimeStats;
      expect(stats.jitInstructions + stats.interpretedInstructions).toBe(12_000n + (operation === "getpid" ? 7n : 9n));
      expect(stats.jitInstructions).toBeGreaterThan(0n);
      expect(runtime.core.jitHealth.state).toBe("active");
    } finally { await runtime.jitRuntime.dispose(); }
  });
}

for (const tier of [1, 2] as const) {
  it(`hands hot syscall successors to the batched compiler under Tier ${String(tier)}`, async () => {
    const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
    const base = await instantiateRuntime(await WebAssembly.compile(bytes.buffer), "syscall-compiler-handoff", { kind: "disabled" });
    await base.jitRuntime.dispose();
    const { runtime: jitRuntime, compilers } = deferredRuntime("batched");
    const runtime = { ...base, jitRuntime };
    try {
      mountTestRuntime(runtime, tier);
      const pid = spawnRing(runtime, readySyscallsElf(20_000));
      for (let turn = 0; turn < 10_000 && termination(runtime, pid) === 0xffff_ffff; turn++) {
        runRingTurn(runtime);
        for (const compiler of compilers) compiler.release();
      }
      expect(termination(runtime, pid)).toBe(0);
      expect(runtime.core.runtimeStats.jitInstructions).toBeGreaterThan(0n);
      expect(runtime.core.runtimeStats.jitInstructions + runtime.core.runtimeStats.interpretedInstructions).toBe(120_007n);
      expect(runtime.core.jitHealth.state).toBe("active");
    } finally { await jitRuntime.dispose(); }
  });
}
