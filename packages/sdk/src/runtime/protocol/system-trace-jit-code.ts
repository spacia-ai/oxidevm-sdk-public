import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";

/**
 * The executable memory of one core's compiled translations (system trace schema 48, Userspace
 * worker protocol 58), as the execution worker estimates it. A compiled unit is one engine
 * module: a standalone translation or a linked batch. It is live while a live or dormant block
 * holds it, dead once none does, and reclaimed when the garbage collector has finalized its
 * instance. Bytes are estimates from the engine family's model, not measurements.
 */
export type SystemJitEngineFamily = "spidermonkey" | "other";

export const SYSTEM_JIT_ENGINE_FAMILIES = [
  "spidermonkey",
  "other",
] as const satisfies readonly SystemJitEngineFamily[];

/**
 * Why a compile was refused and its site interpreted: live translations and reservations would
 * exceed the budget even after evicting every evictable block (`live-budget`), or dead code the
 * collector has not returned exceeds the budget's slack (`unreclaimed-code`).
 */
export type SystemJitCodeRefusalReason = "live-budget" | "unreclaimed-code";

export const SYSTEM_JIT_CODE_REFUSAL_REASONS = [
  "live-budget",
  "unreclaimed-code",
] as const satisfies readonly SystemJitCodeRefusalReason[];

export interface SystemJitCodeProfile {
  readonly family: SystemJitEngineFamily;
  /** Estimated bytes live translations may hold; null when the family has no code budget. */
  readonly budgetBytes: number | null;
  /** Units compiled since the core was created. */
  readonly units: number;
  readonly liveUnits: number;
  readonly deadUnits: number;
  readonly reclaimedUnits: number;
  /** Estimated bytes of units not yet reclaimed, live and dead. */
  readonly retainedBytes: number;
  readonly deadBytes: number;
  /** Estimates reserved by compiles admitted and not yet installed. */
  readonly reservedBytes: number;
  readonly peakRetainedBytes: number;
  readonly reclaimedBytes: number;
  readonly refusals: Readonly<Record<SystemJitCodeRefusalReason, number>>;
  /** Transient allocations made to trigger a collection of dead code. */
  readonly collectionRequests: number;
  /** The size of the next collection request. */
  readonly collectionRequestBytes: number;
}

export function emptyJitCodeRefusals(): Record<SystemJitCodeRefusalReason, number> {
  return { "live-budget": 0, "unreclaimed-code": 0 };
}

export function emptyJitCodeProfile(): SystemJitCodeProfile {
  return {
    family: "other",
    budgetBytes: null,
    units: 0,
    liveUnits: 0,
    deadUnits: 0,
    reclaimedUnits: 0,
    retainedBytes: 0,
    deadBytes: 0,
    reservedBytes: 0,
    peakRetainedBytes: 0,
    reclaimedBytes: 0,
    refusals: emptyJitCodeRefusals(),
    collectionRequests: 0,
    collectionRequestBytes: 0,
  };
}

/** Every unit is live, dead or reclaimed; dead bytes are part of the retained bytes; a family
 * without a budget never refuses or requests a collection. */
export function jitCodeProfileReconciles(profile: SystemJitCodeProfile): boolean {
  const refusals = SYSTEM_JIT_CODE_REFUSAL_REASONS.reduce(
    (sum, reason) => sum + profile.refusals[reason],
    0,
  );
  return profile.liveUnits + profile.deadUnits + profile.reclaimedUnits === profile.units
    && profile.deadBytes <= profile.retainedBytes
    && profile.retainedBytes <= profile.peakRetainedBytes
    && (profile.deadUnits !== 0 || profile.deadBytes === 0)
    && (profile.liveUnits + profile.deadUnits !== 0 || profile.retainedBytes === 0)
    && (profile.budgetBytes !== null || refusals === 0 && profile.collectionRequests === 0);
}

export function decodeJitCodeProfile(value: unknown): SystemJitCodeProfile {
  const profile = record(value, "JIT code profile");
  exactKeys(profile, [
    "family", "budgetBytes", "units", "liveUnits", "deadUnits", "reclaimedUnits",
    "retainedBytes", "deadBytes", "reservedBytes", "peakRetainedBytes", "reclaimedBytes",
    "refusals", "collectionRequests", "collectionRequestBytes",
  ]);
  const family = string(profile["family"], "JIT engine family");
  const knownFamily = SYSTEM_JIT_ENGINE_FAMILIES.find((candidate) => candidate === family);
  if (knownFamily === undefined) throw protocol("JIT engine family is invalid");
  const refusals = record(profile["refusals"], "JIT code refusals");
  exactKeys(refusals, SYSTEM_JIT_CODE_REFUSAL_REASONS);
  const counts = emptyJitCodeRefusals();
  for (const reason of SYSTEM_JIT_CODE_REFUSAL_REASONS) {
    counts[reason] = integer(refusals[reason], `JIT ${reason} code refusals`, 0);
  }
  const count = (field: string) => integer(profile[field], `JIT code ${field}`, 0);
  const decoded: SystemJitCodeProfile = {
    family: knownFamily,
    budgetBytes: profile["budgetBytes"] === null
      ? null
      : integer(profile["budgetBytes"], "JIT code budget bytes", 1),
    units: count("units"),
    liveUnits: count("liveUnits"),
    deadUnits: count("deadUnits"),
    reclaimedUnits: count("reclaimedUnits"),
    retainedBytes: count("retainedBytes"),
    deadBytes: count("deadBytes"),
    reservedBytes: count("reservedBytes"),
    peakRetainedBytes: count("peakRetainedBytes"),
    reclaimedBytes: count("reclaimedBytes"),
    refusals: counts,
    collectionRequests: count("collectionRequests"),
    collectionRequestBytes: count("collectionRequestBytes"),
  };
  if (!jitCodeProfileReconciles(decoded)) {
    throw protocol("JIT code profile does not reconcile");
  }
  return decoded;
}

function protocol(message: string): VMError {
  return new VMError("PROTOCOL_ERROR", message);
}
