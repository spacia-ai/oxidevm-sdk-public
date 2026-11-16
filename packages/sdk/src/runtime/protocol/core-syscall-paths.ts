import { VMError } from "../errors.js";
import { nonnegativeBigint } from "./decoders.js";

/**
 * Record v32 fields 287–308: syscalls a translated block asked for in place (the stops follow Rust
 * `InBlockSyscallStop` codes 0–2), syscalls stepped without the interpreter loop, and the Userspace
 * runtime's short path (the declines follow Rust `PlainDecline` in order).
 */
export const CORE_SYSCALL_PATH_KEYS_V32 = [
  "jitInBlockSyscalls",
  "jitInBlockSyscallContinues",
  "jitInBlockSyscallStopOwnerBoundary",
  "jitInBlockSyscallStopTranslationSettled",
  "jitInBlockSyscallStopDispatchNotReady",
  "jitDirectSyscallSteps",
  "plainSyscallsQuiet",
  "plainSyscallsCompleted",
  "plainSyscallDeclinedNotInTable",
  "plainSyscallDeclinedLeaseTooShort",
  "plainSyscallDeclinedDescriptorNotPlain",
  "plainSyscallDeclinedSeccomp",
  "plainSyscallDeclinedTracing",
  "plainSyscallDeclinedEntryState",
  "plainSyscallDeclinedRseqSlice",
  "plainSyscallDeclinedPendingSignal",
  "plainSyscallDeclinedEffectsQueued",
  "plainSyscallDeclinedServicingPending",
  "plainSyscallDeclinedStagedInput",
  "plainSyscallDeclinedKernelWork",
  "plainSyscallDeclinedMemoryPressure",
  "plainSyscallDeclinedFrozen",
] as const;

/** Record v33 field 309: a write that could exceed a finite `RLIMIT_FSIZE` (the fifteenth `PlainDecline`). */
export const CORE_SYSCALL_PATH_KEYS_V33 = ["plainSyscallDeclinedFileSizeLimit"] as const;
export const CORE_SYSCALL_PATH_KEYS = [...CORE_SYSCALL_PATH_KEYS_V32, ...CORE_SYSCALL_PATH_KEYS_V33] as const;

/** The first System trace schema that carries the record v32 counters. */
export const SYSCALL_PATHS_TRACE_SCHEMA = 55;
/** The first System trace schema that carries the record v33 counter. */
export const SYSCALL_PATHS_V33_TRACE_SCHEMA = 56;

export type CoreSyscallPathProfile = { readonly [Key in typeof CORE_SYSCALL_PATH_KEYS[number]]: bigint };

export function syscallPathsFromValues(values: readonly bigint[]): CoreSyscallPathProfile {
  const value = (index: number): bigint => values[index] ?? 0n;
  if (value(0) !== value(1) + value(2) + value(3) + value(4)) {
    throw new VMError("PROTOCOL_ERROR", "in-block syscalls do not reconcile with their outcomes");
  }
  return {
    jitInBlockSyscalls: value(0),
    jitInBlockSyscallContinues: value(1),
    jitInBlockSyscallStopOwnerBoundary: value(2),
    jitInBlockSyscallStopTranslationSettled: value(3),
    jitInBlockSyscallStopDispatchNotReady: value(4),
    jitDirectSyscallSteps: value(5),
    plainSyscallsQuiet: value(6),
    plainSyscallsCompleted: value(7),
    plainSyscallDeclinedNotInTable: value(8),
    plainSyscallDeclinedLeaseTooShort: value(9),
    plainSyscallDeclinedDescriptorNotPlain: value(10),
    plainSyscallDeclinedSeccomp: value(11),
    plainSyscallDeclinedTracing: value(12),
    plainSyscallDeclinedEntryState: value(13),
    plainSyscallDeclinedRseqSlice: value(14),
    plainSyscallDeclinedPendingSignal: value(15),
    plainSyscallDeclinedEffectsQueued: value(16),
    plainSyscallDeclinedServicingPending: value(17),
    plainSyscallDeclinedStagedInput: value(18),
    plainSyscallDeclinedKernelWork: value(19),
    plainSyscallDeclinedMemoryPressure: value(20),
    plainSyscallDeclinedFrozen: value(21),
    plainSyscallDeclinedFileSizeLimit: value(22),
  };
}

export const EMPTY_CORE_SYSCALL_PATHS = syscallPathsFromValues([]);

export function decodeSyscallPaths(profile: Record<string, unknown>, schema: number): CoreSyscallPathProfile {
  if (schema < SYSCALL_PATHS_TRACE_SCHEMA) {
    if (CORE_SYSCALL_PATH_KEYS.some(key => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n)) {
      throw new VMError("PROTOCOL_ERROR", "historical syscall path counters are not empty");
    }
    return EMPTY_CORE_SYSCALL_PATHS;
  }
  if (schema < SYSCALL_PATHS_V33_TRACE_SCHEMA) {
    if (CORE_SYSCALL_PATH_KEYS_V33.some(key => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n)) {
      throw new VMError("PROTOCOL_ERROR", "historical syscall path counters are not empty");
    }
    return syscallPathsFromValues(CORE_SYSCALL_PATH_KEYS_V32.map(key => nonnegativeBigint(profile[key], key)));
  }
  return syscallPathsFromValues(CORE_SYSCALL_PATH_KEYS.map(key => nonnegativeBigint(profile[key], key)));
}
