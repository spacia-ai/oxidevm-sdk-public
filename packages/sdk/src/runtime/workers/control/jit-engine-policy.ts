import { MAX_LINKED_JIT_MEMBERS } from "../../jit-cache.js";
import type { SystemJitEngineFamily } from "../../protocol/system-trace-jit-code.js";
import type { JitBatchPolicy } from "./jit-deferred-install.js";

/**
 * The browser engine's machine-code behaviour as the Tier-1 JIT sees it, and the policy chosen
 * for it. This is the only owner of engine-family detection: the code budget, the batch policy
 * and the profile read the family from here.
 *
 * Calibrated 2026-10-10 on stock Firefox 151 (official build) and 149 (Fedora), Linux x86-64,
 * headless, with the Userspace `bun dev` Vite workload of the rc.3 image, sampling the content
 * process's executable mappings. Playwright's Firefox is not a valid source: its Juggler attaches
 * a debugger to worker globals, so SpiderMonkey compiles every module as debug Baseline code
 * without Ion, which is larger (the alpha.7 constants came from it and overestimated stock
 * Firefox's code about twofold).
 * - Executable memory fits 30 MiB + 76 KiB per module + 2.84 bytes per Wasm byte (528 samples,
 *   linked batches of 1, 4, 16 and 64 members, RMSE 28 MiB), with no growth once hot functions
 *   tiered up. The estimate below (64 KiB allocations, 3 bytes per Wasm byte, 64 KiB per module)
 *   is 6-13% above that fit for every batch size; in the workload, executable memory including
 *   the core's own code stayed at 0.97-1.01 times the live estimate.
 * - All JS and Wasm code of the content process shares one 2,044 MiB executable-memory reserve
 *   (`MaxCodeBytesPerProcess`). Uniform 128 KiB modules filled it completely, but without a
 *   budget the workload's compiles failed at 1,520 MiB committed (74%), 28 s after spawn, with
 *   524 MiB of the reserve still free: mixed allocation sizes fragment it. The JIT then degraded
 *   to the interpreter (Vite ready at 351 s) and profile reads failed with "out of memory".
 * - Wasm code is not charged to the garbage collector's heap triggers (measured for alpha.7): a
 *   worker that keeps running collected evicted translations only after ~100 s; a transient
 *   64 MiB `ArrayBuffer` triggered the collection at once (malloc-bytes trigger).
 *
 * V8 compiles each function lazily at its first call, so uncalled members cost nothing, and it
 * collects on its own committed-code thresholds; JavaScriptCore was not measured. Both keep the
 * policy they had before engine families existed: no code budget, and batches sealed whenever
 * the compiler is idle.
 */
export type JitEngineFamily = SystemJitEngineFamily;

/** How the store estimates a compiled module's executable-memory cost from its Wasm bytes. */
export interface JitCodeEstimate {
  /** The engine's executable-memory allocation unit; every allocation rounds up to it. */
  readonly granuleBytes: number;
  /** Machine-code bytes per Wasm byte, as a ratio of integers (`numerator / denominator`). */
  readonly codeBytesPerWasmByte: { readonly numerator: number; readonly denominator: number };
  /** Executable memory every module allocates besides its function code. */
  readonly moduleOverheadBytes: number;
}

/** The code budget of one core's compiled translations (`jit-code-budget.ts`). */
export interface JitCodeBudgetPolicy {
  /** Estimated machine-code bytes the core's live translations may hold. */
  readonly budgetBytes: number;
  /** Budget evictions stop once live code and reservations are at most this many bytes. */
  readonly evictionTargetBytes: number;
  /** Dead code past which the store asks the engine to collect. */
  readonly collectionThresholdBytes: number;
  /** Dead code beyond the budget past which compiles are refused until it is collected. */
  readonly unreclaimedSlackBytes: number;
  /** The first collection request's transient allocation; doubled while requests go unanswered. */
  readonly collectionRequestBytes: number;
  readonly maximumCollectionRequestBytes: number;
  /** Requests closer together than this wait for the previous one's collection. */
  readonly collectionIntervalMilliseconds: number;
}

export interface JitEnginePolicy {
  readonly family: JitEngineFamily;
  readonly estimate: JitCodeEstimate;
  /** Null: no code budget; only the byte cache bounds the store. */
  readonly codeBudget: JitCodeBudgetPolicy | null;
  readonly batch: JitBatchPolicy;
}

const KIB = 1024;
const MIB = 1024 * KIB;

/** Firefox: estimates calibrated against measured executable mappings (see above). */
export const SPIDERMONKEY_JIT_POLICY: JitEnginePolicy = {
  family: "spidermonkey",
  estimate: {
    granuleBytes: 64 * KIB,
    // Fitted 2.84 including tier-up; 3 keeps the estimate just above the engine's use.
    codeBytesPerWasmByte: { numerator: 3, denominator: 1 },
    moduleOverheadBytes: 64 * KIB,
  },
  codeBudget: {
    // The Vite workload's working set exceeds any safe budget, so the budget sets the peak:
    // 933-945 MiB of executable memory with the core (46% of the reserve, 62% of the point where
    // fragmentation stopped compiles); budget plus slack bounds it near 1,090 MiB (53%). Against
    // the alpha.7 policy (1,216 MiB under the old, twofold estimate; peak 621-629 MiB) it held
    // 1.5 times the live code and halved compiles (55,000-56,000 against 111,500-112,500) and
    // recompiles (27,000 against 78,000) up to the first request; Vite was ready 199-210 s after
    // spawn instead of 226-239 s and the first request took 197-202 s instead of 223-247 s.
    // Budgets of 768 and 832 MiB left the request at 229-231 s; 1,088 MiB cut recompiles by
    // another third but gained no time and peaked at 1,055 MiB.
    // With the DevTools debugger attached (debug Baseline code, measured in Playwright's
    // Firefox), code is 1.96 times the estimate: the same budget held 1,820-1,846 MiB (90%) for
    // 20 minutes without a compile failure. Without a budget, debug code ran out at 1,873 MiB and
    // the JIT degraded to the interpreter with every process still running.
    budgetBytes: 960 * MIB,
    evictionTargetBytes: 832 * MIB,
    collectionThresholdBytes: 64 * MIB,
    unreclaimedSlackBytes: 128 * MIB,
    collectionRequestBytes: 64 * MIB,
    maximumCollectionRequestBytes: 512 * MIB,
    collectionIntervalMilliseconds: 250,
  },
  // Each module costs ~76 KiB besides its code, which batches of 16 spread to ~5 KiB per
  // translation (16 members: 1,135 KiB per 373 KiB unit against 170 KiB per 33 KiB standalone
  // module). Batches of 32 saved 2% of executable memory and did not change readiness; under
  // the budget a unit is evicted whole, so its hot members are recompiled with it.
  batch: { sealMembers: 16, sealWaitMilliseconds: 100 },
};

/** V8, JavaScriptCore and unknown engines: the policy from before engine families. */
export const DEFAULT_JIT_POLICY: JitEnginePolicy = {
  family: "other",
  estimate: {
    granuleBytes: 1,
    codeBytesPerWasmByte: { numerator: 1, denominator: 1 },
    moduleOverheadBytes: 0,
  },
  codeBudget: null,
  batch: { sealMembers: MAX_LINKED_JIT_MEMBERS, sealWaitMilliseconds: 0 },
};

/**
 * The engine family of `global`'s realm, by capability: SpiderMonkey alone defines the
 * non-standard `InternalError` constructor (its "too much recursion" error), in windows and
 * workers alike. User-agent strings are not consulted.
 */
export function detectJitEngineFamily(global: object = globalThis): JitEngineFamily {
  return typeof Reflect.get(global, "InternalError") === "function" ? "spidermonkey" : "other";
}

export function jitEnginePolicy(family: JitEngineFamily = detectJitEngineFamily()): JitEnginePolicy {
  switch (family) {
    case "spidermonkey":
      return SPIDERMONKEY_JIT_POLICY;
    case "other":
      return DEFAULT_JIT_POLICY;
  }
}

/** Estimated executable memory of one compiled module of `wasmBytes` bytes. */
export function estimateJitCodeBytes(estimate: JitCodeEstimate, wasmBytes: number): number {
  const { numerator, denominator } = estimate.codeBytesPerWasmByte;
  const code = Math.ceil((wasmBytes * numerator) / denominator);
  const granule = estimate.granuleBytes;
  return Math.ceil(code / granule) * granule + estimate.moduleOverheadBytes;
}
