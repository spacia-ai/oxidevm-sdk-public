import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { nonnegativeBigint } from "./decoders.js";

/**
 * Whether the execution worker still compiles Tier-1 modules (system trace schema 47, Userspace
 * worker protocol 57). `exhausted`: the browser ran out of executable code memory while compiling
 * or instantiating a module; `disabled`: the engine rejected a module for another reason. In both,
 * translations already installed keep running and every site without one runs on the interpreter
 * from an instruction boundary; no guest-visible state changes.
 */
export type SystemJitState = "active" | "exhausted" | "disabled";

/** Why a translated module could not be compiled or instantiated. `module-abi` is a module that
 * compiled but could not be instantiated or linked for another reason. */
export type SystemJitFailureReason = "code-memory" | "module-compilation" | "module-abi";

export const SYSTEM_JIT_FAILURE_REASONS = [
  "code-memory",
  "module-compilation",
  "module-abi",
] as const satisfies readonly SystemJitFailureReason[];

/** The exact guard that rejected a delayed raw Tier-2 install (JIT ABI 88). */
export const JIT_PROMOTION_DISCARD_REASONS = [
  "not-in-flight", "machine-unavailable", "translation-unavailable",
  "cpu-context-changed", "already-bound", "code-pages-changed",
] as const;
export type JitPromotionDiscardReason = typeof JIT_PROMOTION_DISCARD_REASONS[number];

export interface JitPromotionDiscardDetail {
  readonly generation: number;
  readonly cacheKey: bigint;
  readonly reason: JitPromotionDiscardReason;
}

export function emptyPromotionDiscardCounts(): Record<JitPromotionDiscardReason, number> {
  return {
    "not-in-flight": 0, "machine-unavailable": 0, "translation-unavailable": 0,
    "cpu-context-changed": 0, "already-bound": 0, "code-pages-changed": 0,
  };
}

/** Where the failure happened: the JIT compiler worker, the guest's thread, or instantiation. */
export type SystemJitFailurePhase = "background-compile" | "synchronous-compile" | "instantiation";

export const SYSTEM_JIT_FAILURE_PHASES = [
  "background-compile",
  "synchronous-compile",
  "instantiation",
] as const satisfies readonly SystemJitFailurePhase[];

/** Bounds on the browser error recorded with the first failure. */
export const MAX_JIT_FAILURE_ERROR_NAME = 64;
export const MAX_JIT_FAILURE_MESSAGE = 256;

/** The first failure of a JIT runtime generation: the module, the cause and the browser's error. */
export interface SystemJitFailureDetail {
  readonly generation: number;
  readonly cacheKey: bigint;
  readonly reason: SystemJitFailureReason;
  readonly phase: SystemJitFailurePhase;
  /** The browser error's `name`, such as `RangeError` or `CompileError`, bounded. */
  readonly errorName: string;
  /** The browser error's message, bounded; it names no guest data. */
  readonly message: string;
}

export interface SystemJitHealthProfile {
  readonly state: SystemJitState;
  /** Why the state left `active`; null while active. */
  readonly reason: SystemJitFailureReason | null;
  /** Modules that failed to compile or instantiate, by reason. */
  readonly failures: Readonly<Record<SystemJitFailureReason, number>>;
  readonly firstFailure: SystemJitFailureDetail | null;
  /** Compile or Install actions the core would not park, ended unexecuted and run on the
   * interpreter because the JIT no longer compiles. */
  readonly interpretedCompiles: number;
  /** Compile actions whose translation was parked in the core, which then interprets its sites
   * without offering it again, because the JIT no longer compiles. */
  readonly parkedCompiles: number;
  /** Failed speculative Tier-2 promotions, without degrading Tier 1. Absent when none failed
   * or in archived captures before trace schema 51 / worker protocol 66. */
  readonly promotionFailures?: {
    readonly counts: Readonly<Record<SystemJitFailureReason, number>>;
    readonly firstFailure: SystemJitFailureDetail;
  };
  /** Guarded delayed installs discarded without executing; first identity per generation.
   * Absent when none were discarded or in archives before schema 51 / protocol 66. */
  readonly promotionDiscards?: {
    readonly counts: Readonly<Record<JitPromotionDiscardReason, number>>;
    readonly firstDiscard: JitPromotionDiscardDetail;
  };
}

export function emptyJitFailureCounts(): Record<SystemJitFailureReason, number> {
  return { "code-memory": 0, "module-compilation": 0, "module-abi": 0 };
}

export function emptyJitHealthProfile(): SystemJitHealthProfile {
  return {
    state: "active",
    reason: null,
    failures: emptyJitFailureCounts(),
    firstFailure: null,
    interpretedCompiles: 0,
    parkedCompiles: 0,
  };
}

export function decodeJitFailureReason(value: unknown, label: string): SystemJitFailureReason {
  const reason = string(value, label);
  const known = SYSTEM_JIT_FAILURE_REASONS.find((candidate) => candidate === reason);
  if (known === undefined) throw protocol(`${label} is invalid`);
  return known;
}

/** A state is `active` exactly when nothing failed; `exhausted` follows a code-memory failure
 * and `disabled` any other failure, and the reason and first failure were counted. */
export function jitHealthReconciles(profile: SystemJitHealthProfile): boolean {
  const total = SYSTEM_JIT_FAILURE_REASONS.reduce(
    (sum, reason) => sum + profile.failures[reason],
    0,
  );
  if (profile.state === "active") {
    return total === 0
      && profile.reason === null
      && profile.firstFailure === null
      && profile.interpretedCompiles === 0
      && profile.parkedCompiles === 0;
  }
  const { reason, firstFailure } = profile;
  if (reason === null || firstFailure === null) return false;
  const stateMatches = profile.state === "exhausted"
    ? reason === "code-memory"
    : reason !== "code-memory";
  return stateMatches
    && profile.failures[reason] >= 1
    && profile.failures[firstFailure.reason] >= 1;
}

export function decodeJitHealthProfile(value: unknown): SystemJitHealthProfile {
  const profile = record(value, "JIT health profile");
  exactKeys(profile, [
    "state", "reason", "failures", "firstFailure", "interpretedCompiles", "parkedCompiles",
  ], ["promotionFailures", "promotionDiscards"]);
  const state = string(profile["state"], "JIT state");
  if (state !== "active" && state !== "exhausted" && state !== "disabled") {
    throw protocol("JIT state is invalid");
  }
  const failures = record(profile["failures"], "JIT failure counts");
  exactKeys(failures, SYSTEM_JIT_FAILURE_REASONS);
  const counts = emptyJitFailureCounts();
  for (const reason of SYSTEM_JIT_FAILURE_REASONS) {
    counts[reason] = integer(failures[reason], `JIT ${reason} failures`, 0);
  }
  const decoded: SystemJitHealthProfile = {
    state,
    reason: profile["reason"] === null
      ? null
      : decodeJitFailureReason(profile["reason"], "JIT degradation reason"),
    failures: counts,
    firstFailure: profile["firstFailure"] === null
      ? null
      : decodeJitFailureDetail(profile["firstFailure"]),
    interpretedCompiles: integer(profile["interpretedCompiles"], "JIT interpreted compiles", 0),
    parkedCompiles: integer(profile["parkedCompiles"], "JIT parked compiles", 0),
    ...(profile["promotionFailures"] === undefined ? {} : { promotionFailures: decodePromotionFailures(profile["promotionFailures"]) }),
    ...(profile["promotionDiscards"] === undefined ? {} : { promotionDiscards: decodePromotionDiscards(profile["promotionDiscards"]) }),
  };
  if (!jitHealthReconciles(decoded)) {
    throw protocol("JIT health profile does not reconcile");
  }
  return decoded;
}

function decodePromotionDiscards(value: unknown): NonNullable<SystemJitHealthProfile["promotionDiscards"]> {
  const discards = record(value, "JIT promotion discards");
  exactKeys(discards, ["counts", "firstDiscard"]);
  const raw = record(discards["counts"], "JIT promotion discard counts");
  exactKeys(raw, JIT_PROMOTION_DISCARD_REASONS);
  const counts = emptyPromotionDiscardCounts();
  for (const reason of JIT_PROMOTION_DISCARD_REASONS) counts[reason] = integer(raw[reason], `JIT promotion ${reason} discards`, 0);
  const detail = record(discards["firstDiscard"], "first JIT promotion discard");
  exactKeys(detail, ["generation", "cacheKey", "reason"]);
  const reason = JIT_PROMOTION_DISCARD_REASONS.find((candidate) => candidate === detail["reason"]);
  if (reason === undefined) throw protocol("JIT promotion discard reason is invalid");
  if (counts[reason] < 1) throw protocol("JIT promotion discard counts do not reconcile");
  return { counts, firstDiscard: {
    generation: integer(detail["generation"], "JIT promotion discard generation", 0),
    cacheKey: nonnegativeBigint(detail["cacheKey"], "JIT promotion discard cache key"),
    reason,
  } };
}

function decodePromotionFailures(value: unknown): NonNullable<SystemJitHealthProfile["promotionFailures"]> {
  const failures = record(value, "JIT promotion failures");
  exactKeys(failures, ["counts", "firstFailure"]);
  const raw = record(failures["counts"], "JIT promotion failure counts");
  exactKeys(raw, SYSTEM_JIT_FAILURE_REASONS);
  const counts = emptyJitFailureCounts();
  for (const reason of SYSTEM_JIT_FAILURE_REASONS) counts[reason] = integer(raw[reason], `JIT promotion ${reason} failures`, 0);
  const firstFailure = decodeJitFailureDetail(failures["firstFailure"]);
  if (counts[firstFailure.reason] < 1) throw protocol("JIT promotion failure counts do not reconcile");
  return { counts, firstFailure };
}

function decodeJitFailureDetail(value: unknown): SystemJitFailureDetail {
  const detail = record(value, "first JIT failure");
  exactKeys(detail, ["generation", "cacheKey", "reason", "phase", "errorName", "message"]);
  const phase = string(detail["phase"], "first JIT failure phase");
  const knownPhase = SYSTEM_JIT_FAILURE_PHASES.find((candidate) => candidate === phase);
  if (knownPhase === undefined) throw protocol("first JIT failure phase is invalid");
  const errorName = string(detail["errorName"], "first JIT failure error name");
  const message = string(detail["message"], "first JIT failure message");
  if (errorName.length > MAX_JIT_FAILURE_ERROR_NAME || message.length > MAX_JIT_FAILURE_MESSAGE) {
    throw protocol("first JIT failure error is too long");
  }
  return {
    generation: integer(detail["generation"], "first JIT failure generation", 0),
    cacheKey: nonnegativeBigint(detail["cacheKey"], "first JIT failure cache key"),
    reason: decodeJitFailureReason(detail["reason"], "first JIT failure reason"),
    phase: knownPhase,
    errorName,
    message,
  };
}

function protocol(message: string): VMError {
  return new VMError("PROTOCOL_ERROR", message);
}

/** The sticky failure of a schema-47 profile is the first failure's identity, both owned by the
 * JIT health record. */
export function stickyFailureMatchesHealth(
  sticky: { readonly generation: number; readonly cacheKey: bigint; readonly reason: SystemJitFailureReason } | null,
  health: SystemJitHealthProfile,
): boolean {
  const first = health.firstFailure;
  if (sticky === null || first === null) return sticky === first;
  return sticky.generation === first.generation
    && sticky.cacheKey === first.cacheKey
    && sticky.reason === first.reason;
}
