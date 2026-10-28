import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";
import { nonnegativeBigint } from "./decoders.js";
import {
  SYSTEM_INTERPRETED_ACTION_REASONS,
  type SystemInterpretedActionReason,
  type SystemInterpretedActionReasonProfile,
  type SystemTraceSnapshot,
} from "./system.js";

type Profiles = Readonly<Record<SystemInterpretedActionReason, SystemInterpretedActionReasonProfile>>;

/** One value per interpreted-action reason, spelled out so the compiler
 * proves the record complete without a type assertion. */
export function interpretedActionReasonRecord<T>(
  make: (reason: SystemInterpretedActionReason) => T,
): Record<SystemInterpretedActionReason, T> {
  return {
    "machine-not-jit-capable": make("machine-not-jit-capable"),
    "execution-budget": make("execution-budget"),
    halted: make("halted"),
    "partial-budget": make("partial-budget"),
    "missing-code-identity": make("missing-code-identity"),
    "cold-admission": make("cold-admission"),
    "unsupported-semantic": make("unsupported-semantic"),
    "unsupported-form": make("unsupported-form"),
    "unsupported-context": make("unsupported-context"),
    "decode-or-translation-fault": make("decode-or-translation-fault"),
    "quarantined-semantic": make("quarantined-semantic"),
    "emission-failure": make("emission-failure"),
    "module-size-limit": make("module-size-limit"),
    "candidate-limit": make("candidate-limit"),
    "compile-pending": make("compile-pending"),
    "code-page-fault": make("code-page-fault"),
    "performance-overflow-boundary": make("performance-overflow-boundary"),
    "pending-virtual-interrupt": make("pending-virtual-interrupt"),
  };
}

/** Per-reason interpreted actions, carried from schema 36: the core names why
 * a batch ran in the interpreter (halted, partial budget, missing code
 * identity, cold admission, a blocked candidate), so an interpreted phase is
 * attributed to its mechanism instead of the control worker's coarse bucket. */
export function decodeInterpretedActionReasonProfiles(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): Profiles {
  if (schemaVersion < 36) throw new VMError("PROTOCOL_ERROR", "interpreted action reasons require trace schema 36");
  const profiles = record(value, "interpreted action reason profiles");
  const available = (reason: SystemInterpretedActionReason): boolean =>
    schemaVersion >= (reason === "code-page-fault" ? 49 : reason === "compile-pending" ? 44 : reason === "pending-virtual-interrupt" ? 47 : reason === "performance-overflow-boundary" ? 46 : 36);
  // Retain archived schemas while they remain supported. A projected zero is
  // allowed; an archived schema cannot attribute work to a future mechanism.
  exactKeys(profiles, SYSTEM_INTERPRETED_ACTION_REASONS.filter(available),
    SYSTEM_INTERPRETED_ACTION_REASONS.filter(reason => !available(reason)));
  return interpretedActionReasonRecord(reason => {
    if (!available(reason) && profiles[reason] === undefined) {
      return { batches: 0, instructions: 0n };
    }
    const profile = record(profiles[reason], `${reason} interpreted action profile`);
    exactKeys(profile, ["batches", "instructions"]);
    const decoded = {
      batches: integer(profile["batches"], `${reason} interpreted action batches`, 0),
      instructions: nonnegativeBigint(profile["instructions"], `${reason} interpreted action instructions`),
    };
    if (!available(reason) && (decoded.batches !== 0 || decoded.instructions !== 0n)) {
      throw new VMError("PROTOCOL_ERROR", `archived trace cannot contain ${reason} work`);
    }
    return decoded;
  });
}

export function emptyInterpretedActionReasonProfiles(): Profiles {
  return interpretedActionReasonRecord(() => ({ batches: 0, instructions: 0n }));
}
