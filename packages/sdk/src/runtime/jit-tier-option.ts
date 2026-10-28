import { VMError } from "./errors.js";

/** Internal Userspace diagnostic option. Production callers retain Tier 1. */
export const JIT_TIER_OPTION = Symbol.for("oxidevm.internal.jit-tier");
export type UserspaceJitTier = "tier1" | "tier2";

export function decodeUserspaceJitTier(value: unknown): UserspaceJitTier {
  if (value !== "tier1" && value !== "tier2") {
    throw new VMError("PROTOCOL_ERROR", "Userspace JIT tier is invalid");
  }
  return value;
}

export function decodeJitTierOption(options: object): UserspaceJitTier | undefined {
  const value: unknown = Reflect.get(options, JIT_TIER_OPTION);
  if (value === undefined) return undefined;
  if (value !== "tier1" && value !== "tier2") {
    throw new VMError("INVALID_ARGUMENT", "Userspace JIT tier is invalid");
  }
  return value;
}
