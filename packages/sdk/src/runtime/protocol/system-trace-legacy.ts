import { exactKeys, integer, record } from "../decode.js";
import {
  LEGACY_SYSTEM_JIT_EVICTION_REASONS,
  type SystemInterpreterReason,
  type SystemInterpreterReasonProfile,
} from "./system.js";

export function legacyEvictedTraceCount(
  worker: Readonly<Record<string, unknown>>,
): number {
  const profiles = record(worker["evictionReasons"], "JIT eviction reason profiles");
  exactKeys(profiles, LEGACY_SYSTEM_JIT_EVICTION_REASONS);
  return LEGACY_SYSTEM_JIT_EVICTION_REASONS.reduce((total, reason) => {
    const profile = record(profiles[reason], `${reason} JIT eviction profile`);
    return total + integer(profile["traces"], `${reason} evicted traces`, 0);
  }, 0);
}

export function emptyInterpreterReasonProfiles(): Readonly<
  Record<SystemInterpreterReason, SystemInterpreterReasonProfile>
> {
  const empty = { batches: 0, instructions: 0n, milliseconds: 0 };
  return {
    admission: empty,
    "code-budget": empty,
    degraded: empty,
    guard: empty,
    quarantine: empty,
  };
}
