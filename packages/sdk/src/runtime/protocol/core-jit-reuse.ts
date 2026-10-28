import { VMError } from "../errors.js";
import { nonnegativeBigint } from "./decoders.js";

/** Record v31 fields 259–286. Rejections follow Rust JitReuseRejection wire codes 0–9. */
export const CORE_JIT_REUSE_KEYS = [
  "jitTierOneReuseAttempts",
  "jitTierOneReuseAdoptions",
  "jitTierOneReuseValidationBytes",
  "jitTierOneReuseRetainedBytes",
  "jitTierOneReuseRejectedMissing",
  "jitTierOneReuseRejectedBudget",
  "jitTierOneReuseRejectedPolicy",
  "jitTierOneReuseRejectedQuarantined",
  "jitTierOneReuseRejectedInvalidSource",
  "jitTierOneReuseRejectedNotResident",
  "jitTierOneReuseRejectedPermission",
  "jitTierOneReuseRejectedUninspectable",
  "jitTierOneReuseRejectedCodeChanged",
  "jitTierOneReuseRejectedCapacity",
  "jitTierTwoReuseAttempts",
  "jitTierTwoReuseAdoptions",
  "jitTierTwoReuseValidationBytes",
  "jitTierTwoReuseRetainedBytes",
  "jitTierTwoReuseRejectedMissing",
  "jitTierTwoReuseRejectedBudget",
  "jitTierTwoReuseRejectedPolicy",
  "jitTierTwoReuseRejectedQuarantined",
  "jitTierTwoReuseRejectedInvalidSource",
  "jitTierTwoReuseRejectedNotResident",
  "jitTierTwoReuseRejectedPermission",
  "jitTierTwoReuseRejectedUninspectable",
  "jitTierTwoReuseRejectedCodeChanged",
  "jitTierTwoReuseRejectedCapacity",
] as const;

export type CoreJitReuseProfile = { readonly [Key in typeof CORE_JIT_REUSE_KEYS[number]]: bigint };

export function jitReuseFromValues(values: readonly bigint[]): CoreJitReuseProfile {
  for (const start of [0, 14]) {
    const attempts = values[start] ?? 0n;
    const adoptions = values[start + 1] ?? 0n;
    const rejections = values.slice(start + 4, start + 14).reduce((sum, value) => sum + value, 0n);
    if (attempts !== adoptions + rejections) {
      throw new VMError("PROTOCOL_ERROR", "JIT reuse attempts do not reconcile with outcomes");
    }
  }
  return {
    jitTierOneReuseAttempts: values[0] ?? 0n,
    jitTierOneReuseAdoptions: values[1] ?? 0n,
    jitTierOneReuseValidationBytes: values[2] ?? 0n,
    jitTierOneReuseRetainedBytes: values[3] ?? 0n,
    jitTierOneReuseRejectedMissing: values[4] ?? 0n,
    jitTierOneReuseRejectedBudget: values[5] ?? 0n,
    jitTierOneReuseRejectedPolicy: values[6] ?? 0n,
    jitTierOneReuseRejectedQuarantined: values[7] ?? 0n,
    jitTierOneReuseRejectedInvalidSource: values[8] ?? 0n,
    jitTierOneReuseRejectedNotResident: values[9] ?? 0n,
    jitTierOneReuseRejectedPermission: values[10] ?? 0n,
    jitTierOneReuseRejectedUninspectable: values[11] ?? 0n,
    jitTierOneReuseRejectedCodeChanged: values[12] ?? 0n,
    jitTierOneReuseRejectedCapacity: values[13] ?? 0n,
    jitTierTwoReuseAttempts: values[14] ?? 0n,
    jitTierTwoReuseAdoptions: values[15] ?? 0n,
    jitTierTwoReuseValidationBytes: values[16] ?? 0n,
    jitTierTwoReuseRetainedBytes: values[17] ?? 0n,
    jitTierTwoReuseRejectedMissing: values[18] ?? 0n,
    jitTierTwoReuseRejectedBudget: values[19] ?? 0n,
    jitTierTwoReuseRejectedPolicy: values[20] ?? 0n,
    jitTierTwoReuseRejectedQuarantined: values[21] ?? 0n,
    jitTierTwoReuseRejectedInvalidSource: values[22] ?? 0n,
    jitTierTwoReuseRejectedNotResident: values[23] ?? 0n,
    jitTierTwoReuseRejectedPermission: values[24] ?? 0n,
    jitTierTwoReuseRejectedUninspectable: values[25] ?? 0n,
    jitTierTwoReuseRejectedCodeChanged: values[26] ?? 0n,
    jitTierTwoReuseRejectedCapacity: values[27] ?? 0n,
  };
}

export const EMPTY_CORE_JIT_REUSE = jitReuseFromValues([]);

export function decodeJitReuse(profile: Record<string, unknown>, schema: number): CoreJitReuseProfile {
  if (schema < 53) {
    if (CORE_JIT_REUSE_KEYS.some(key => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n)) {
      throw new VMError("PROTOCOL_ERROR", "historical JIT reuse counters are not empty");
    }
    return EMPTY_CORE_JIT_REUSE;
  }
  const values = CORE_JIT_REUSE_KEYS.map(key => nonnegativeBigint(profile[key], key));
  return jitReuseFromValues(values);
}
