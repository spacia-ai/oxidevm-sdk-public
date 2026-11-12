import { describe, expect, it } from "vitest";

import { type Core, callNumber } from "./core.js";
import { JitRuntime } from "./jit-runtime.js";
import {
  LOOP_RETIRED,
  LOOP_SUM,
  deferredRuntime,
  loadStagedCore,
  rax,
  runToHalt,
  summingLoop,
} from "./jit-runtime.test-support.js";

const PAGES_IN_2_GIB = 32_768;

/**
 * A core whose JIT context lies above 2 GiB, where Wasm hands its u32 pointer to JavaScript as a
 * negative number. A System machine with 2,048 MiB or more puts it there because its guest RAM is
 * one block of the core's memory; growing the memory by 2 GiB before the first translation does
 * the same without booting Linux, as the core's allocator takes the pages it grows next above
 * them. The grown pages are reserved, not written.
 */
async function coreWithHighJitContext(): Promise<Core> {
  const loaded = await loadStagedCore();
  loaded.memory.grow(PAGES_IN_2_GIB);
  return loaded;
}

function expectHighJitContext(loaded: Core): void {
  expect(
    callNumber(loaded, "oxidevm_jit_context_ptr"),
    "this regression needs the JIT context above 2 GiB",
  ).toBeGreaterThanOrEqual(0x8000_0000);
}

describe("JitRuntime with its context above 2 GiB", () => {
  it("runs a translated loop installed on the guest's thread", async () => {
    const loaded = await coreWithHighJitContext();
    const runtime = new JitRuntime();
    runtime.initialize();

    expect(runToHalt(loaded, runtime, summingLoop("add"))).toBe(LOOP_RETIRED);

    expectHighJitContext(loaded);
    expect(rax(loaded)).toBe(LOOP_SUM);
    expect(loaded.runtimeStats.jitInstructions).toBeGreaterThan(0n);
  });

  it("runs a translated loop compiled off the guest's thread", async () => {
    const loaded = await coreWithHighJitContext();
    const { runtime, compilers } = deferredRuntime("batched");

    const retired = runToHalt(loaded, runtime, summingLoop("add"), () => {
      for (const compiler of compilers) compiler.release();
    });

    expect(retired).toBe(LOOP_RETIRED);
    expectHighJitContext(loaded);
    expect(rax(loaded)).toBe(LOOP_SUM);
    expect(loaded.traceProfile.worker.backgroundCompile.compiled).toBeGreaterThan(0);
    expect(loaded.runtimeStats.jitInstructions).toBeGreaterThan(0n);
    await runtime.dispose();
  });
});
