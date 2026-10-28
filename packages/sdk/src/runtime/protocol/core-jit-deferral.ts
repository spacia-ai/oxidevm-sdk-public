import { VMError } from "../errors.ts";
import { nonnegativeBigint } from "./decoders.ts";

/**
 * Tier-1 modules compiled off the guest's thread (the core's `state/jit_deferral.rs`): core
 * runtime profile record v24 fields 237-254 and system trace schema 44, in record order.
 * Refusals follow the core's `JitDeferralRefusal`; settles follow `JitSettleOutcome`, then the
 * settles of an artifact no longer in flight. Outstanding artifacts and bytes are gauges.
 */
export interface CoreJitDeferralProfile {
  readonly jitDeferrals: bigint;
  readonly jitDeferralJoins: bigint;
  readonly jitDeferralRefusedInstallOnly: bigint;
  readonly jitDeferralRefusedTierTwo: bigint;
  readonly jitDeferralRefusedAot: bigint;
  readonly jitDeferralRefusedExecuted: bigint;
  readonly jitDeferralRefusedNotCached: bigint;
  readonly jitDeferralRefusedBound: bigint;
  readonly jitDeferralSettledCompiled: bigint;
  readonly jitDeferralSettledFailed: bigint;
  readonly jitDeferralSettledAbandoned: bigint;
  readonly jitDeferralSettledNotInFlight: bigint;
  readonly jitDeferralOutstanding: bigint;
  readonly jitDeferralOutstandingBytes: bigint;
  readonly jitCompilePendingInterprets: bigint;
  readonly jitCompilePendingInterpreterPasses: bigint;
  readonly jitCompilePendingEvictions: bigint;
  readonly jitChainMissingCompilePending: bigint;
}

/** Every field in core record order. */
export const CORE_JIT_DEFERRAL_KEYS = [
  "jitDeferrals",
  "jitDeferralJoins",
  "jitDeferralRefusedInstallOnly",
  "jitDeferralRefusedTierTwo",
  "jitDeferralRefusedAot",
  "jitDeferralRefusedExecuted",
  "jitDeferralRefusedNotCached",
  "jitDeferralRefusedBound",
  "jitDeferralSettledCompiled",
  "jitDeferralSettledFailed",
  "jitDeferralSettledAbandoned",
  "jitDeferralSettledNotInFlight",
  "jitDeferralOutstanding",
  "jitDeferralOutstandingBytes",
  "jitCompilePendingInterprets",
  "jitCompilePendingInterpreterPasses",
  "jitCompilePendingEvictions",
  "jitChainMissingCompilePending",
] as const satisfies readonly (keyof CoreJitDeferralProfile)[];

/** Whether `key` is a gauge rather than a counter: a delta keeps a gauge's end value. */
export function isJitDeferralGauge(key: keyof CoreJitDeferralProfile): boolean {
  return key === "jitDeferralOutstanding" || key === "jitDeferralOutstandingBytes";
}

/** The first system trace schema that carries the deferral profile. */
export const CORE_JIT_DEFERRAL_SCHEMA = 44;

/** Builds the profile from values in `CORE_JIT_DEFERRAL_KEYS` order; a missing value is zero. */
export function jitDeferralFromValues(values: readonly bigint[]): CoreJitDeferralProfile {
  const at = (index: number): bigint => values[index] ?? 0n;
  return {
    jitDeferrals: at(0),
    jitDeferralJoins: at(1),
    jitDeferralRefusedInstallOnly: at(2),
    jitDeferralRefusedTierTwo: at(3),
    jitDeferralRefusedAot: at(4),
    jitDeferralRefusedExecuted: at(5),
    jitDeferralRefusedNotCached: at(6),
    jitDeferralRefusedBound: at(7),
    jitDeferralSettledCompiled: at(8),
    jitDeferralSettledFailed: at(9),
    jitDeferralSettledAbandoned: at(10),
    jitDeferralSettledNotInFlight: at(11),
    jitDeferralOutstanding: at(12),
    jitDeferralOutstandingBytes: at(13),
    jitCompilePendingInterprets: at(14),
    jitCompilePendingInterpreterPasses: at(15),
    jitCompilePendingEvictions: at(16),
    jitChainMissingCompilePending: at(17),
  };
}

export const EMPTY_CORE_JIT_DEFERRAL = jitDeferralFromValues([]);

/**
 * Every artifact that entered flight has settled or is still outstanding, and an artifact in
 * flight has module bytes.
 */
export function jitDeferralReconciles(profile: CoreJitDeferralProfile): boolean {
  return profile.jitDeferrals
    === profile.jitDeferralSettledCompiled
      + profile.jitDeferralSettledFailed
      + profile.jitDeferralSettledAbandoned
      + profile.jitDeferralOutstanding
    && (profile.jitDeferralOutstanding === 0n) === (profile.jitDeferralOutstandingBytes === 0n);
}

/** The deferral fields a system trace schema carries. */
export function jitDeferralKeysForSchema(
  schemaVersion: number,
): readonly (keyof CoreJitDeferralProfile)[] {
  return schemaVersion >= CORE_JIT_DEFERRAL_SCHEMA ? CORE_JIT_DEFERRAL_KEYS : [];
}

/**
 * Decodes the fields of a system trace core profile; all are absent before schema 44, where a
 * present field must be zero.
 */
export function decodeJitDeferral(
  profile: Readonly<Record<string, unknown>>,
  schemaVersion: number,
): CoreJitDeferralProfile {
  if (schemaVersion < CORE_JIT_DEFERRAL_SCHEMA) {
    if (
      CORE_JIT_DEFERRAL_KEYS.some(
        (key) => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n,
      )
    ) {
      throw new VMError("PROTOCOL_ERROR", "legacy JIT deferral profile is not empty");
    }
    return EMPTY_CORE_JIT_DEFERRAL;
  }
  const decoded = jitDeferralFromValues(
    CORE_JIT_DEFERRAL_KEYS.map((key) => nonnegativeBigint(profile[key], key)),
  );
  if (!jitDeferralReconciles(decoded)) {
    throw new VMError("PROTOCOL_ERROR", "JIT deferral counters do not reconcile");
  }
  return decoded;
}
