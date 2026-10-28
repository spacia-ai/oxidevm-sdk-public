import type { SystemJitFailure } from "../../protocol/system.js";
import {
  JIT_PROMOTION_DISCARD_REASONS,
  emptyPromotionDiscardCounts,
  type JitPromotionDiscardDetail,
  type JitPromotionDiscardReason,
  MAX_JIT_FAILURE_ERROR_NAME,
  SYSTEM_JIT_FAILURE_REASONS,
  MAX_JIT_FAILURE_MESSAGE,
  type SystemJitFailureDetail,
  type SystemJitFailurePhase,
  type SystemJitFailureReason,
  type SystemJitHealthProfile,
  type SystemJitState,
  emptyJitFailureCounts,
} from "../../protocol/system-trace-jit-health.js";

/**
 * Whether one core's JIT still compiles Tier-1 modules. This owns the JIT state, the failure
 * counts by typed reason and the first failure; the JIT runtime and the deferred install report
 * failures here and read the state, and profiles copy it.
 *
 * A module the browser cannot compile or instantiate never ends guest execution: the site runs
 * on the interpreter from its instruction boundary and installed translations keep running. A
 * code-memory failure marks the JIT `exhausted` and any other one `disabled`; neither submits new
 * compiles for the rest of the runtime generation.
 *
 * There is no recovery attempt: this is the safety net behind the code budget
 * (`jit-code-budget.ts`), which keeps an engine family with a known executable-memory limit away
 * from it by evicting translations and asking for dead code to be collected. Reaching this state
 * means the engine refused a module anyway, and a retry would most likely fail again and spend a
 * compile. A new runtime generation (a new machine or Userspace runtime) starts `active` again.
 */
export interface MutableJitHealth {
  state: SystemJitState;
  reason: SystemJitFailureReason | null;
  readonly failures: Record<SystemJitFailureReason, number>;
  firstFailure: SystemJitFailureDetail | null;
  interpretedCompiles: number;
  parkedCompiles: number;
  readonly promotionFailures: Record<SystemJitFailureReason, number>;
  firstPromotionFailure: SystemJitFailureDetail | null;
  readonly promotionDiscards: Record<JitPromotionDiscardReason, number>;
  firstPromotionDiscard: JitPromotionDiscardDetail | null;
}

/** A browser error reduced to the parts a profile may carry. */
export interface JitFailureError {
  readonly name: string;
  readonly message: string;
}

/** The JIT leaving `active`, reported once per runtime generation. */
export interface JitDegradation {
  readonly state: Exclude<SystemJitState, "active">;
  readonly reason: SystemJitFailureReason;
  readonly failure: SystemJitFailureDetail;
}

const OUT_OF_MEMORY = /out of memory/iu;

export function createJitHealth(): MutableJitHealth {
  return {
    state: "active",
    reason: null,
    failures: emptyJitFailureCounts(),
    firstFailure: null,
    interpretedCompiles: 0,
    parkedCompiles: 0,
    promotionFailures: emptyJitFailureCounts(),
    firstPromotionFailure: null,
    promotionDiscards: emptyPromotionDiscardCounts(),
    firstPromotionDiscard: null,
  };
}

/** A new runtime generation: the JIT compiles again. */
export function resetJitHealth(health: MutableJitHealth): void {
  health.state = "active";
  health.reason = null;
  for (const reason of SYSTEM_JIT_FAILURE_REASONS) {
    health.failures[reason] = 0;
    health.promotionFailures[reason] = 0;
  }
  health.firstFailure = null;
  health.interpretedCompiles = 0;
  health.parkedCompiles = 0;
  health.firstPromotionFailure = null;
  for (const reason of JIT_PROMOTION_DISCARD_REASONS) health.promotionDiscards[reason] = 0;
  health.firstPromotionDiscard = null;
}

/**
 * The browser's WebAssembly engine refused to compile or instantiate a translated module. Only
 * the compile and instantiate calls raise it, so an SDK or core invariant failing around them (a
 * `VMError`, or any other error) stays a fault instead of degrading the JIT.
 */
export class JitModuleFailure extends Error {
  readonly phase: SystemJitFailurePhase;
  readonly engineError: JitFailureError;

  constructor(phase: SystemJitFailurePhase, cause: unknown) {
    const engineError = jitFailureError(cause);
    super(`${phase} failed: ${engineError.name}: ${engineError.message}`);
    this.name = "JitModuleFailure";
    this.phase = phase;
    this.engineError = engineError;
  }
}

/** Runs one engine compile or instantiate call, raising its failure as a `JitModuleFailure`. */
export function engineJitCall<T>(phase: SystemJitFailurePhase, call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw new JitModuleFailure(phase, error);
  }
}

export function jitFailureError(error: unknown): JitFailureError {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "non-Error", message: "non-Error failure" };
}

/** The typed reason of a failure: running out of executable code memory (a `RangeError`, or an
 * engine's "out of memory" from any phase), or else the phase's own failure. */
export function classifyJitFailure(
  phase: SystemJitFailurePhase,
  error: JitFailureError,
): SystemJitFailureReason {
  if (error.name === "RangeError" || OUT_OF_MEMORY.test(error.message)) return "code-memory";
  return phase === "instantiation" ? "module-abi" : "module-compilation";
}

/** Records one compile or instantiation that failed; returns the degradation when the failure
 * took the JIT out of `active`. `disabled` is final, and `exhausted` yields only to it; that
 * later change is recorded in the state, not reported again. */
export function recordJitFailure(
  health: MutableJitHealth,
  failure: {
    readonly phase: SystemJitFailurePhase;
    readonly generation: number;
    readonly cacheKey: bigint;
    readonly error: JitFailureError;
    /** Set for a fault around the engine call, which is recorded as `module-abi`. */
    readonly reason?: SystemJitFailureReason;
  },
): JitDegradation | undefined {
  const reason = failure.reason ?? classifyJitFailure(failure.phase, failure.error);
  health.failures[reason] += 1;
  const detail = failureDetail(failure, reason);
  health.firstFailure ??= detail;
  const state = reason === "code-memory" ? "exhausted" : "disabled";
  const previous = health.state;
  if (previous === "disabled" || previous === state) return undefined;
  health.state = state;
  health.reason = reason;
  return previous === "active" ? { state, reason, failure: detail } : undefined;
}

/** A speculative raw trace failed. Tier-1 admission and installed code stay usable. */
export function recordPromotionFailure(
  health: MutableJitHealth,
  failure: Parameters<typeof recordJitFailure>[1],
): void {
  const reason = failure.reason ?? classifyJitFailure(failure.phase, failure.error);
  health.promotionFailures[reason] += 1;
  health.firstPromotionFailure ??= failureDetail(failure, reason);
}

/** A delayed trace no longer satisfies a core-owned guard; Tier 1 stays active. */
export function recordPromotionDiscard(health: MutableJitHealth, detail: JitPromotionDiscardDetail): void {
  health.promotionDiscards[detail.reason] += 1;
  health.firstPromotionDiscard ??= detail;
}

function failureDetail(
  failure: Parameters<typeof recordJitFailure>[1],
  reason: SystemJitFailureReason,
): SystemJitFailureDetail {
  return {
    generation: failure.generation,
    cacheKey: failure.cacheKey,
    reason,
    phase: failure.phase,
    errorName: failure.error.name.slice(0, MAX_JIT_FAILURE_ERROR_NAME),
    message: failure.error.message.slice(0, MAX_JIT_FAILURE_MESSAGE),
  };
}

/** A compile action ran on the interpreter because the JIT no longer compiles. */
export function recordInterpretedCompile(health: MutableJitHealth): void {
  health.interpretedCompiles += 1;
}

/** A compile action's translation was parked in the core because the JIT no longer compiles. */
export function recordParkedCompile(health: MutableJitHealth): void {
  health.parkedCompiles += 1;
}

export function jitHealthProfile(health: MutableJitHealth): SystemJitHealthProfile {
  return {
    state: health.state,
    reason: health.reason,
    failures: { ...health.failures },
    firstFailure: health.firstFailure,
    interpretedCompiles: health.interpretedCompiles,
    parkedCompiles: health.parkedCompiles,
    ...(health.firstPromotionFailure === null ? {} : {
      promotionFailures: { counts: { ...health.promotionFailures }, firstFailure: health.firstPromotionFailure },
    }),
    ...(health.firstPromotionDiscard === null ? {} : {
      promotionDiscards: { counts: { ...health.promotionDiscards }, firstDiscard: health.firstPromotionDiscard },
    }),
  };
}

/** The trace profile's sticky failure: the first failure's identity. */
export function stickyJitFailure(health: MutableJitHealth): SystemJitFailure | null {
  const first = health.firstFailure;
  return first === null
    ? null
    : { generation: first.generation, cacheKey: first.cacheKey, reason: first.reason };
}

/** The structured record a composition root logs once when its JIT degrades; it carries the
 * browser error's bounded name and message and no guest data. */
export function jitDegradationWarning(
  runtime: "system" | "userspace",
  degradation: JitDegradation,
): Readonly<Record<string, string>> {
  const { failure } = degradation;
  return {
    runtime,
    state: degradation.state,
    reason: degradation.reason,
    phase: failure.phase,
    cacheKey: `0x${failure.cacheKey.toString(16)}`,
    error: `${failure.errorName}: ${failure.message}`,
    effect: "translated code already installed keeps running; new code runs on the interpreter",
  };
}
