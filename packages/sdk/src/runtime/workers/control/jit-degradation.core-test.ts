import { afterEach, describe, expect, it, vi } from "vitest";

import { VMError } from "../../errors.js";
import { backgroundCompileReconciles } from "../../protocol/system-trace-background-compile.js";
import { decodeSystemTraceProfile } from "../../protocol/system-trace-profile.js";
import { type Core, readCoreRuntimeProfile } from "./core.js";
import type { JitDegradation } from "./jit-health.js";
import { JitRuntime } from "./jit-runtime.js";
import { instantiateLinkedJitModule } from "./jit-module-install.js";
import {
  ITERATIONS,
  LOOP_RETIRED,
  LOOP_SUM,
  deferredRuntime,
  loadStagedCore,
  rax,
  runToHalt,
  summingLoop,
  summingLoops,
} from "./jit-runtime.test-support.js";
import { NetworkLink } from "./network-link.js";
import { readSystemTrace } from "./trace.js";

// A Tier-1 module the browser cannot compile or instantiate (SpiderMonkey and V8 out of
// executable code memory, or a rejected module) degrades the JIT; the guest keeps running on the
// interpreter with the same results. These drive the real core, as `jit-runtime.core-test.ts`.

const SUB_SUM = (1n << 64n) - LOOP_SUM;

/** Makes the browser's `WebAssembly.Module` or `WebAssembly.Instance` constructor throw while
 * `failing` is set; every other call reaches the real engine. */
function failingEngine(
  constructor: "Module" | "Instance",
  error: () => Error,
): { failing: boolean } {
  const state = { failing: false };
  if (constructor === "Module") {
    const Original = WebAssembly.Module;
    vi.spyOn(WebAssembly, "Module").mockImplementation(function (bytes: BufferSource) {
      if (state.failing) throw error();
      return new Original(bytes);
    });
  } else {
    const Original = WebAssembly.Instance;
    vi.spyOn(WebAssembly, "Instance").mockImplementation(function (
      module: WebAssembly.Module,
      imports?: WebAssembly.Imports,
    ) {
      if (state.failing) throw error();
      return new Original(module, imports);
    });
  }
  return state;
}

function outOfMemory(): RangeError {
  return new RangeError("WebAssembly.Module(): Out of memory: Cannot allocate Wasm code");
}

function decodedTrace(loaded: Core) {
  const value = readSystemTrace(loaded, undefined, "", {
    kind: "disabled", reason: "no-catalog", catalogSha256: null, indexSha256: null,
    keyId: null, signatureVerified: false, encounters: 0, instantiateMilliseconds: 0, packs: [],
  }, { active: false, paused: false, stopping: false, awaitingConsoleAck: false, waiting: "none" }, NetworkLink.absent(loaded));
  return decodeSystemTraceProfile(value.profile, value.schemaVersion);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a background compile the engine refuses", () => {
  it("runs the site on the interpreter when the compiler runs out of executable memory", async () => {
    const loaded = await loadStagedCore();
    const degradations: JitDegradation[] = [];
    const { runtime, compilers } = deferredRuntime("deferred", (event) => degradations.push(event));

    const retired = runToHalt(loaded, runtime, summingLoop("add"), () => {
      const compiler = compilers.at(-1);
      if (compiler === undefined) return;
      compiler.answer = "out-of-memory";
      compiler.release();
    });

    expect(retired).toBe(LOOP_RETIRED);
    expect(rax(loaded)).toBe(LOOP_SUM);
    expect(loaded.runtimeStats.jitInstructions + loaded.runtimeStats.interpretedInstructions)
      .toBe(retired);
    const health = loaded.jitHealth;
    expect(health.state).toBe("exhausted");
    expect(health.reason).toBe("code-memory");
    expect(health.failures).toEqual({ "code-memory": 1, "module-compilation": 0, "module-abi": 0 });
    expect(health.firstFailure).toMatchObject({
      reason: "code-memory", phase: "background-compile", errorName: "Error", message: "out of memory",
    });
    // An exhausted JIT submits nothing more: the site's later Compile actions are interpreted.
    const background = loaded.traceProfile.worker.backgroundCompile;
    expect(background.submitted).toBe(1);
    expect(background.failed).toBe(1);
    expect(backgroundCompileReconciles(background)).toBe(true);
    // The site's translation is parked: the core interprets it without offering it again.
    expect(health.parkedCompiles).toBeGreaterThan(0);
    const core = readCoreRuntimeProfile(loaded);
    expect(core.jitDeferralSettledFailed).toBe(1n);
    expect(core.jitDeferralOutstanding).toBe(1n);
    expect(core.jitCompilePendingInterprets).toBeGreaterThan(0n);
    expect(degradations).toEqual([
      { state: "exhausted", reason: "code-memory", failure: health.firstFailure },
    ]);
    const profile = decodedTrace(loaded);
    expect(profile.worker.jitHealth).toMatchObject({ state: "exhausted", reason: "code-memory" });
    expect(profile.worker.stickyJitFailure).toMatchObject({ reason: "code-memory" });
  });

  it("settles parked translations when the runtime is invalidated", async () => {
    const loaded = await loadStagedCore();
    const { runtime, compilers } = deferredRuntime();
    runToHalt(loaded, runtime, summingLoop("add"), () => {
      const compiler = compilers.at(-1);
      if (compiler === undefined) return;
      compiler.answer = "out-of-memory";
      compiler.release();
    });
    expect(readCoreRuntimeProfile(loaded).jitDeferralOutstanding).toBe(1n);

    // The next block settles the parked translation as abandoned before it runs.
    runtime.invalidate();
    runtime.runBlock(loaded, 0, 1, false, () => undefined);

    const core = readCoreRuntimeProfile(loaded);
    expect(core.jitDeferralSettledAbandoned).toBe(1n);
    expect(core.jitDeferralOutstanding).toBe(0n);
  });

  it("disables the JIT for a rejected module and still completes the program", async () => {
    const loaded = await loadStagedCore();
    const degradations: JitDegradation[] = [];
    const { runtime, compilers } = deferredRuntime("deferred", (event) => degradations.push(event));

    const retired = runToHalt(loaded, runtime, summingLoop("add"), () => {
      const compiler = compilers.at(-1);
      if (compiler === undefined) return;
      compiler.answer = "failed";
      compiler.release();
    });

    expect(retired).toBe(LOOP_RETIRED);
    expect(rax(loaded)).toBe(LOOP_SUM);
    expect(loaded.jitHealth).toMatchObject({
      state: "disabled",
      reason: "module-compilation",
      firstFailure: { phase: "background-compile", errorName: "CompileError" },
    });
    expect(loaded.traceProfile.worker.backgroundCompile.submitted).toBe(1);
    expect(readCoreRuntimeProfile(loaded).jitDeferralSettledFailed).toBe(1n);
    expect(degradations.map((event) => event.state)).toEqual(["disabled"]);
  });

  it("keeps installed translations running after the JIT is exhausted", async () => {
    const loaded = await loadStagedCore();
    const { runtime, compilers } = deferredRuntime();
    const program = summingLoops(2);

    const retired = runToHalt(loaded, runtime, program, () => {
      const compiler = compilers.at(-1);
      if (compiler === undefined || compiler.pending === 0) return;
      compiler.answer =
        loaded.traceProfile.worker.backgroundCompile.compiled === 0 ? "compiled" : "out-of-memory";
      compiler.release();
    });

    expect(rax(loaded)).toBe(2n * LOOP_SUM);
    expect(loaded.jitHealth.state).toBe("exhausted");
    const worker = loaded.traceProfile.worker;
    expect(worker.compileModules).toBe(1);
    const jitBefore = loaded.runtimeStats.jitInstructions;
    const hitsBefore = loaded.runtimeStats.cacheHits;

    expect(runToHalt(loaded, runtime, program)).toBe(retired);
    expect(rax(loaded)).toBe(2n * LOOP_SUM);
    expect(worker.compileModules).toBe(1);
    expect(loaded.runtimeStats.cacheHits).toBeGreaterThan(hitsBefore);
    expect(loaded.runtimeStats.jitInstructions - jitBefore)
      .toBeGreaterThan(3n * BigInt(ITERATIONS - 100));
  });

  it("degrades when a compiled module cannot be instantiated", async () => {
    const loaded = await loadStagedCore();
    const { runtime, compilers } = deferredRuntime();
    const engine = failingEngine("Instance", () => new RangeError("Out of memory"));

    const retired = runToHalt(loaded, runtime, summingLoop("add"), () => {
      const compiler = compilers.at(-1);
      if (compiler === undefined || compiler.pending === 0) return;
      // The module instantiates when it settles, between the guest's blocks.
      engine.failing = true;
      compiler.release();
    });

    expect(retired).toBe(LOOP_RETIRED);
    expect(rax(loaded)).toBe(LOOP_SUM);
    expect(loaded.jitHealth).toMatchObject({
      state: "exhausted",
      reason: "code-memory",
      firstFailure: { phase: "instantiation", errorName: "RangeError" },
    });
    expect(backgroundCompileReconciles(loaded.traceProfile.worker.backgroundCompile)).toBe(true);
  });

  it("degrades when a linked batch cannot be instantiated", async () => {
    const loaded = await loadStagedCore();
    const { runtime, compilers } = deferredRuntime("batched");
    const engine = failingEngine("Instance", () => new RangeError("Out of memory"));
    const loops = 4;
    let primed = false;

    runToHalt(loaded, runtime, summingLoops(loops), () => {
      const compiler = compilers.at(-1);
      if (compiler === undefined || compiler.pending === 0) return;
      if (!primed && loaded.traceProfile.worker.backgroundCompile.inFlight < 3) return;
      primed = true;
      // The module instantiates when it settles, between the guest's blocks.
      engine.failing = true;
      compiler.release();
    });

    expect(rax(loaded)).toBe(BigInt(loops) * LOOP_SUM);
    expect(loaded.jitHealth.state).toBe("exhausted");
    expect(loaded.jitHealth.firstFailure?.phase).toBe("instantiation");
    expect(backgroundCompileReconciles(loaded.traceProfile.worker.backgroundCompile)).toBe(true);
    expect(loaded.traceProfile.worker.backgroundCompile.inFlight).toBe(0);
    // Only parked translations stay in flight in the core.
    expect(readCoreRuntimeProfile(loaded).jitDeferralOutstanding)
      .toBeLessThanOrEqual(BigInt(loaded.jitHealth.parkedCompiles));
  });

  it.each(["deferred", "batched"] as const)("still surfaces a fault around %s installation", async (mode) => {
    const loaded = await loadStagedCore();
    const { runtime, compilers } = deferredRuntime(mode);
    const Original = WebAssembly.Instance;
    let broken = false;
    // An instance without the translation's exports is an SDK/engine contract fault, not the
    // browser refusing the module.
    vi.spyOn(WebAssembly, "Instance").mockImplementation(function (
      module: WebAssembly.Module,
      imports?: WebAssembly.Imports,
    ) {
      return broken
        ? new Original(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])))
        : new Original(module, imports);
    });

    expect(() => runToHalt(loaded, runtime, summingLoop("add"), () => {
      const compiler = compilers.at(-1);
      if (compiler === undefined || compiler.pending === 0) return;
      broken = true;
      compiler.release();
    })).toThrow("background JIT compilation failed");
    expect(loaded.jitHealth).toMatchObject({ state: "disabled", reason: "module-abi" });
  });

  it("keeps invalid dispatcher exports outside the linked engine-failure boundary", async () => {
    const loaded = await loadStagedCore();
    const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const Original = WebAssembly.Instance;
    vi.spyOn(WebAssembly, "Instance").mockImplementation(function () {
      return new Original(empty);
    });

    expect(() => instantiateLinkedJitModule(loaded, empty, 1, 8)).toThrow(VMError);
  });
});

describe("a synchronous compile the engine refuses", () => {
  it("runs the site on the interpreter when compilation runs out of executable memory", async () => {
    const loaded = await loadStagedCore();
    const degradations: JitDegradation[] = [];
    const runtime = new JitRuntime(undefined, undefined, undefined, (event) => degradations.push(event));
    runtime.initialize();
    runToHalt(loaded, runtime, summingLoop("add"));
    const compiled = loaded.traceProfile.worker.compileModules;
    const engine = failingEngine("Module", outOfMemory);
    engine.failing = true;

    expect(runToHalt(loaded, runtime, summingLoop("sub"))).toBe(LOOP_RETIRED);

    expect(rax(loaded)).toBe(SUB_SUM);
    expect(loaded.traceProfile.worker.compileModules).toBe(compiled);
    expect(loaded.jitHealth).toMatchObject({
      state: "exhausted",
      reason: "code-memory",
      failures: { "code-memory": 1 },
      firstFailure: { phase: "synchronous-compile", errorName: "RangeError" },
    });
    expect(loaded.jitHealth.parkedCompiles).toBeGreaterThan(0);
    expect(degradations).toHaveLength(1);
  });

  it("disables the JIT when a module cannot be instantiated for another reason", async () => {
    const loaded = await loadStagedCore();
    const runtime = new JitRuntime();
    runtime.initialize();
    runToHalt(loaded, runtime, summingLoop("add"));
    const engine = failingEngine("Instance", () => new WebAssembly.LinkError("import mismatch"));
    engine.failing = true;

    expect(runToHalt(loaded, runtime, summingLoop("sub"))).toBe(LOOP_RETIRED);

    expect(rax(loaded)).toBe(SUB_SUM);
    expect(loaded.jitHealth).toMatchObject({
      state: "disabled",
      reason: "module-abi",
      firstFailure: { phase: "instantiation", errorName: "LinkError" },
    });
  });

  it("still surfaces a fault that is not the engine refusing the module", async () => {
    const loaded = await loadStagedCore();
    const runtime = new JitRuntime();
    runtime.initialize();
    runToHalt(loaded, runtime, summingLoop("add"));
    const Original = WebAssembly.Instance;
    vi.spyOn(WebAssembly, "Instance").mockImplementation(function () {
      return new Original(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
    });

    expect(() => runToHalt(loaded, runtime, summingLoop("sub")))
      .toThrow("synchronous JIT generation failed");
    expect(loaded.jitHealth).toMatchObject({ state: "disabled", reason: "module-abi" });
  });
});
