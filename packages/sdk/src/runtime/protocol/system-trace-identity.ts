import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { nonnegativeBigint } from "./decoders.js";
import { decodeJitFailureReason } from "./system-trace-jit-health.js";
import type {
  SystemTraceProfile,
  SystemTraceRipRange,
  SystemTraceSnapshot,
} from "./system.js";

export function decodeJitFailure(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): SystemTraceProfile["worker"]["stickyJitFailure"] {
  if (value === null) return null;
  const failure = record(value, "sticky JIT failure");
  exactKeys(failure, ["generation", "cacheKey", "reason"]);
  const reason = decodeJitFailureReason(failure["reason"], "sticky JIT failure reason");
  if (reason === "code-memory" && schemaVersion < 47) {
    throw new VMError("PROTOCOL_ERROR", "sticky JIT failure reason is invalid");
  }
  return {
    generation: integer(failure["generation"], "sticky JIT failure generation", 0),
    cacheKey: nonnegativeBigint(failure["cacheKey"], "sticky JIT failure cache key"),
    reason,
  };
}

export function decodeSystemTraceTrigger(
  value: unknown,
): SystemTraceSnapshot["trigger"] {
  if (value === null) return null;
  const trigger = string(value, "system trace trigger");
  if (
    trigger !== "guest-process-exit" &&
    trigger !== "guest-process-protocol" &&
    trigger !== "guest-stderr"
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "system trace trigger is invalid",
    );
  }
  return trigger;
}

export function decodeSystemTraceExecutionMode(
  value: unknown,
): SystemTraceSnapshot["executionMode"] {
  const mode = string(value, "system trace execution mode");
  if (
    mode !== "tiered" &&
    mode !== "interpreter-only" &&
    mode !== "semantic-quarantine"
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "system trace execution mode is invalid",
    );
  }
  return mode;
}

export function decodeInterpretedSemantics(
  value: unknown,
): readonly number[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "interpreted semantic list is invalid",
    );
  }
  const semantics = value.map((semantic) =>
    integer(semantic, "interpreted semantic", 0, 0xffff),
  );
  if (new Set(semantics).size !== semantics.length) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "interpreted semantic list contains duplicates",
    );
  }
  return semantics;
}

export function decodeInterpretedRipRanges(
  value: unknown,
): readonly SystemTraceRipRange[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "interpreted RIP range list is invalid",
    );
  }
  let previousEnd = 0n;
  return value.map((entry, index) => {
    const range = record(entry, "interpreted RIP range");
    exactKeys(range, ["start", "end"]);
    const start = nonnegativeBigint(
      range["start"],
      "interpreted RIP range start",
    );
    const end = nonnegativeBigint(range["end"], "interpreted RIP range end");
    if (
      start >= end ||
      end > 0xffff_ffff_ffff_ffffn ||
      (index !== 0 && start < previousEnd)
    ) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "interpreted RIP ranges must be ordered, non-overlapping u64 intervals",
      );
    }
    previousEnd = end;
    return { start, end };
  });
}
