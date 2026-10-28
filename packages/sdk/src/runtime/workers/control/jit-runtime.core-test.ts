import { describe, expect, it } from "vitest";

import { backgroundCompileReconciles } from "../../protocol/system-trace-background-compile.js";
import { decodeSystemTraceProfile } from "../../protocol/system-trace-profile.js";
import { readCoreRuntimeProfile } from "./core.js";
import { JitRuntime } from "./jit-runtime.js";
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
import { configureSystemTrace } from "./trace-configuration.js";

describe("JitRuntime against the real core", () => {
  it("compiles a hot loop, runs it translated, and reconciles retired work", async () => {
    const loaded = await loadStagedCore();
    const runtime = new JitRuntime();
    runtime.initialize();

    const retired = runToHalt(loaded, runtime, summingLoop("add"));

    expect(retired).toBe(LOOP_RETIRED);
    expect(rax(loaded)).toBe(LOOP_SUM);
    expect(loaded.traceProfile.worker.compileModules).toBeGreaterThan(0);
    expect(loaded.runtimeStats.jitInstructions).toBeGreaterThan(0n);
    expect(loaded.runtimeStats.jitInstructions + loaded.runtimeStats.interpretedInstructions)
      .toBe(retired);
  });

  it("reuses the compiled module when the same code is translated again", async () => {
    const loaded = await loadStagedCore();
    const runtime = new JitRuntime();
    runtime.initialize();
    runToHalt(loaded, runtime, summingLoop("add"));
    const compiled = loaded.traceProfile.worker.compileModules;
    const hits = loaded.runtimeStats.cacheHits;

    const retired = runToHalt(loaded, runtime, summingLoop("add"));

    expect(retired).toBe(LOOP_RETIRED);
    expect(rax(loaded)).toBe(LOOP_SUM);
    expect(loaded.traceProfile.worker.compileModules).toBe(compiled);
    expect(loaded.runtimeStats.cacheHits).toBeGreaterThan(hits);
  });

  it("compiles changed code instead of running a stale translation", async () => {
    const loaded = await loadStagedCore();
    const runtime = new JitRuntime();
    runtime.initialize();
    runToHalt(loaded, runtime, summingLoop("add"));
    const compiled = loaded.traceProfile.worker.compileModules;

    runToHalt(loaded, runtime, summingLoop("sub"));

    expect(rax(loaded)).toBe((1n << 64n) - LOOP_SUM);
    expect(loaded.traceProfile.worker.compileModules).toBeGreaterThan(compiled);
  });
});

describe("JitRuntime with modules compiled off the guest's thread", () => {
  for (const capacity of [0, 64]) {
    for (const received of [false, true]) {
      it(`keeps pending compilation accounted for when tracing resets to ${String(capacity)} with results ${received ? "received" : "in flight"}`, async () => {
        const loaded = await loadStagedCore();
        const { runtime, compilers } = deferredRuntime();
        let reset = false;
        const retired = runToHalt(loaded, runtime, summingLoop("add"), () => {
          const compiler = compilers.at(-1);
          if (compiler === undefined || compiler.pending === 0) return;
          if (!reset) {
            reset = true;
            const outstanding = loaded.traceProfile.worker.backgroundCompile.inFlight;
            if (received) compiler.release();
            configureSystemTrace(loaded, undefined, capacity, false, [], [], "faults-only");
            const background = loaded.traceProfile.worker.backgroundCompile;
            expect(background).toMatchObject({
              installMode: "deferred", submitted: outstanding, inFlight: outstanding,
              peakInFlight: outstanding, compiled: 0,
            });
            expect(backgroundCompileReconciles(background)).toBe(true);
          }
          compiler.release();
        });
        const worker = loaded.traceProfile.worker;
        expect(reset).toBe(true);
        expect(retired).toBe(LOOP_RETIRED);
        expect(rax(loaded)).toBe(LOOP_SUM);
        expect(backgroundCompileReconciles(worker.backgroundCompile)).toBe(true);
        expect(worker.compileModules).toBe(worker.backgroundCompile.compiled);
        expect(readCoreRuntimeProfile(loaded).jitDeferralOutstanding).toBe(0n);
        await runtime.dispose();
      });
    }
  }

  it("keeps completed compilation counters and install mode when capture is reconfigured", async () => {
    const loaded = await loadStagedCore();
    const { runtime, compilers } = deferredRuntime();
    runToHalt(loaded, runtime, summingLoop("add"), () => compilers.at(-1)?.release());
    const moduleLoads = loaded.runtimeStats.moduleLoads;
    const compiled = loaded.traceProfile.worker.backgroundCompile.compiled;
    configureSystemTrace(loaded, undefined, 64, false, [], [], "faults-only");
    expect(loaded.traceProfile.worker.backgroundCompile).toMatchObject({
      installMode: "deferred", submitted: compiled, compiled, inFlight: 0,
    });
    expect(runToHalt(loaded, runtime, summingLoop("add"))).toBe(LOOP_RETIRED);
    expect(rax(loaded)).toBe(LOOP_SUM);
    expect(loaded.runtimeStats.moduleLoads).toBe(moduleLoads);
    expect(backgroundCompileReconciles(loaded.traceProfile.worker.backgroundCompile)).toBe(true);
    await runtime.dispose();
  });

  it("exports a complete decodable profile after reconfiguration of a running JIT", async () => {
    const loaded = await loadStagedCore();
    const { runtime, compilers } = deferredRuntime();
    runToHalt(loaded, runtime, summingLoop("add"), () => compilers.at(-1)?.release());
    const snapshot = () => readSystemTrace(loaded, undefined, "", {
      kind: "disabled", reason: "no-catalog", catalogSha256: null, indexSha256: null,
      keyId: null, signatureVerified: false, encounters: 0, instantiateMilliseconds: 0, packs: [],
    }, { active: false, paused: false, stopping: false, awaitingConsoleAck: false, waiting: "none" }, NetworkLink.absent(loaded));
    const decode = () => { const value = snapshot(); return decodeSystemTraceProfile(value.profile, value.schemaVersion); };
    expect(decode).not.toThrow();
    configureSystemTrace(loaded, undefined, 64, false, [], [], "faults-only");
    expect(decode).not.toThrow();
    expect(runToHalt(loaded, runtime, summingLoop("add"))).toBe(LOOP_RETIRED);
    expect(decode).not.toThrow();
    await runtime.dispose();
  });

  it("interprets a hot loop while its module compiles, then runs the installed module", async () => {
    const loaded = await loadStagedCore();
    const { runtime, compilers } = deferredRuntime();
    let blocks = 0;

    const retired = runToHalt(loaded, runtime, summingLoop("add"), () => {
      blocks += 1;
      // Let the guest interpret a few blocks before each compile finishes.
      if (blocks % 4 === 0) compilers.at(-1)?.release();
    });

    const worker = loaded.traceProfile.worker;
    const background = worker.backgroundCompile;
    expect(retired).toBe(LOOP_RETIRED);
    expect(rax(loaded)).toBe(LOOP_SUM);
    expect(background.installMode).toBe("deferred");
    expect(background.submitted).toBeGreaterThan(0);
    expect(background.compiled).toBe(background.submitted);
    expect(backgroundCompileReconciles(background)).toBe(true);
    expect(worker.synchronousCompiles).toBe(0);
    expect(worker.compileModules).toBe(background.compiled);
    expect(loaded.runtimeStats.moduleLoads).toBe(BigInt(background.compiled));
    expect(worker.interpretedActionReasons["compile-pending"].batches).toBeGreaterThan(0);
    expect(loaded.runtimeStats.jitInstructions).toBeGreaterThan(0n);
    expect(loaded.runtimeStats.jitInstructions + loaded.runtimeStats.interpretedInstructions)
      .toBe(retired);
    const core = readCoreRuntimeProfile(loaded);
    expect(core.jitDeferrals).toBe(BigInt(background.submitted));
    expect(core.jitDeferralSettledCompiled).toBe(BigInt(background.compiled));
    expect(core.jitDeferralOutstanding).toBe(0n);
    expect(core.jitCompilePendingInterprets).toBeGreaterThan(0n);
  });

  it("retries a compile its worker abandoned", async () => {
    const loaded = await loadStagedCore();
    const { runtime, compilers } = deferredRuntime();
    let crashed = false;

    const retired = runToHalt(loaded, runtime, summingLoop("add"), () => {
      const compiler = compilers.at(-1);
      if (compiler === undefined || compiler.pending === 0) return;
      compiler.answer = crashed ? "compiled" : "crash";
      crashed = true;
      compiler.release();
    });

    const background = loaded.traceProfile.worker.backgroundCompile;
    expect(retired).toBe(LOOP_RETIRED);
    expect(rax(loaded)).toBe(LOOP_SUM);
    expect(background.abandoned).toBeGreaterThan(0);
    expect(background.compiled).toBeGreaterThan(0);
    expect(backgroundCompileReconciles(background)).toBe(true);
    expect(readCoreRuntimeProfile(loaded).jitDeferralSettledAbandoned)
      .toBe(BigInt(background.abandoned));
  });

  it("abandons compiles in flight when the runtime is invalidated", async () => {
    const loaded = await loadStagedCore();
    const { runtime, compilers } = deferredRuntime();
    let invalidated = false;

    const retired = runToHalt(loaded, runtime, summingLoop("add"), () => {
      const compiler = compilers.at(-1);
      if (compiler === undefined || compiler.pending === 0) return;
      if (!invalidated) {
        invalidated = true;
        runtime.invalidate();
        return;
      }
      compiler.release();
    });

    const background = loaded.traceProfile.worker.backgroundCompile;
    expect(retired).toBe(LOOP_RETIRED);
    expect(rax(loaded)).toBe(LOOP_SUM);
    expect(background.discarded).toBe(1);
    expect(backgroundCompileReconciles(background)).toBe(true);
  });
});

describe("JitRuntime with Tier-1 modules linked into batches", () => {
  it("keeps outstanding linked batches and completed compilations accounted for when capture is reconfigured", async () => {
    const loaded = await loadStagedCore();
    const { runtime, compilers } = deferredRuntime("batched");
    const loops = 4;
    let primed = false;
    let reset = false;
    const retired = runToHalt(loaded, runtime, summingLoops(loops), () => {
      const compiler = compilers.at(-1);
      if (compiler === undefined || compiler.pending === 0) return;
      const previous = loaded.traceProfile.worker.backgroundCompile;
      if (!primed && previous.inFlight < 3) return;
      primed = true;
      if (!reset && previous.batches > 0) {
        reset = true;
        const submitted = previous.submitted;
        const compiled = previous.compiled;
        const inFlight = previous.inFlight;
        configureSystemTrace(loaded, undefined, 64, false, [], [], "faults-only");
        const background = loaded.traceProfile.worker.backgroundCompile;
        expect(background).toMatchObject({
          installMode: "batched", submitted, inFlight, compiled,
          batches: 1, batchedModules: 2, largestBatch: 2,
        });
        expect(backgroundCompileReconciles(background)).toBe(true);
      }
      compiler.release();
    });
    const worker = loaded.traceProfile.worker;
    expect(reset).toBe(true);
    expect(retired).toBe(2n + BigInt(loops) * (1n + 3n * BigInt(ITERATIONS)));
    expect(rax(loaded)).toBe(BigInt(loops) * LOOP_SUM);
    expect(backgroundCompileReconciles(worker.backgroundCompile)).toBe(true);
    expect(worker.compileModules).toBe(worker.backgroundCompile.compiled);
    expect(readCoreRuntimeProfile(loaded).jitDeferralOutstanding).toBe(0n);
    await runtime.dispose();
  });

  it("links modules deferred while a compile runs and runs each member translated", async () => {
    const loaded = await loadStagedCore();
    const { runtime, compilers } = deferredRuntime("batched");
    const loops = 4;
    let primed = false;

    const retired = runToHalt(loaded, runtime, summingLoops(loops), () => {
      const compiler = compilers.at(-1);
      if (compiler === undefined || compiler.pending === 0) return;
      // Hold the first compile until two more loops wait for it, so they form one batch.
      if (!primed && loaded.traceProfile.worker.backgroundCompile.inFlight < 3) return;
      primed = true;
      compiler.release();
    });

    const worker = loaded.traceProfile.worker;
    const background = worker.backgroundCompile;
    expect(retired).toBe(2n + BigInt(loops) * (1n + 3n * BigInt(ITERATIONS)));
    expect(rax(loaded)).toBe(BigInt(loops) * LOOP_SUM);
    expect(background.installMode).toBe("batched");
    expect(background.batches).toBeGreaterThan(0);
    expect(background.batchedModules).toBeGreaterThanOrEqual(2);
    expect(background.linkFailures).toBe(0);
    expect(background.compiled).toBe(background.submitted);
    expect(backgroundCompileReconciles(background)).toBe(true);
    expect(worker.compileModules).toBe(background.compiled);
    // A linked batch is one engine module however many translations it holds.
    expect(loaded.runtimeStats.moduleLoads)
      .toBe(BigInt(background.compiled - background.batchedModules + background.batches));
    const linked = [...loaded.jitBlocks.values()].flatMap((block) =>
      block.artifact.kind === "linked" ? [block.artifact] : []);
    expect(linked.length).toBe(background.batchedModules);
    expect(linked.some((artifact) => artifact.batch === 1 && artifact.memberIndex === 1))
      .toBe(true);
    expect(loaded.runtimeStats.jitInstructions + loaded.runtimeStats.interpretedInstructions)
      .toBe(retired);
    const core = readCoreRuntimeProfile(loaded);
    expect(core.jitDeferrals).toBe(BigInt(background.submitted));
    expect(core.jitDeferralSettledCompiled).toBe(BigInt(background.compiled));
    expect(core.jitDeferralOutstanding).toBe(0n);

    // The installed members run the same program translated from its first block.
    const jitBefore = loaded.runtimeStats.jitInstructions;
    expect(runToHalt(loaded, runtime, summingLoops(loops))).toBe(retired);
    expect(rax(loaded)).toBe(BigInt(loops) * LOOP_SUM);
    expect(worker.compileModules).toBe(background.compiled);
    expect(loaded.runtimeStats.jitInstructions - jitBefore)
      .toBeGreaterThan(BigInt(loops) * 3n * BigInt(ITERATIONS - 100));
  });

  it("holds modules until the batch policy's member count and links them into one module", async () => {
    const loaded = await loadStagedCore();
    const { runtime, compilers } = deferredRuntime("batched", undefined, {
      sealMembers: 3,
      sealWaitMilliseconds: 60_000,
    });
    const loops = 6;

    const retired = runToHalt(loaded, runtime, summingLoops(loops), () => {
      compilers.at(-1)?.release();
    });

    expect(retired).toBe(2n + BigInt(loops) * (1n + 3n * BigInt(ITERATIONS)));
    expect(rax(loaded)).toBe(BigInt(loops) * LOOP_SUM);
    const background = loaded.traceProfile.worker.backgroundCompile;
    expect(background.batches).toBeGreaterThan(0);
    expect(background.largestBatch).toBe(3);
    const linked = [...loaded.jitBlocks.values()].filter((block) => block.artifact.kind === "linked");
    expect(linked.length).toBe(background.batchedModules);
    expect(linked.every((block) => block.artifact.kind === "linked" && block.artifact.members === 3))
      .toBe(true);
    await runtime.dispose();
  });

  it("compiles a module alone when the compiler is idle", async () => {
    const loaded = await loadStagedCore();
    const { runtime, compilers } = deferredRuntime("batched");

    const retired = runToHalt(loaded, runtime, summingLoop("add"), () => {
      compilers.at(-1)?.release();
    });

    const background = loaded.traceProfile.worker.backgroundCompile;
    expect(retired).toBe(LOOP_RETIRED);
    expect(rax(loaded)).toBe(LOOP_SUM);
    expect(background.submitted).toBeGreaterThan(0);
    expect(background.batches).toBe(0);
    expect(background.compiled).toBe(background.submitted);
    expect([...loaded.jitBlocks.values()].every((block) => block.artifact.kind === "dynamic"))
      .toBe(true);
  });
});
