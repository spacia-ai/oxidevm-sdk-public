import { exactKeys, integer, record, string } from "../decode.ts";
import { VMError } from "../errors.ts";
import { MAX_LINKED_JIT_MEMBERS } from "../jit-cache.ts";
import { finiteNonnegativeNumber } from "./decoders.ts";
import type { SystemTraceSnapshot } from "./system.ts";

/** How the execution worker installs Tier-1 modules: compiled on the guest's thread inside the
 * Compile transaction (`immediate`), compiled one module at a time by the JIT compiler worker
 * while the guest interprets the site (`deferred`), or linked into batches the compiler worker
 * compiles together (`batched`). */
export type SystemJitInstallMode = "immediate" | "deferred" | "batched";

export const SYSTEM_JIT_INSTALL_MODES = [
  "immediate",
  "deferred",
  "batched",
] as const satisfies readonly SystemJitInstallMode[];

/** The install mode execution workers use unless a diagnostic page chooses another. */
export const DEFAULT_JIT_INSTALL_MODE: SystemJitInstallMode = "batched";

export function isJitInstallMode(value: unknown): value is SystemJitInstallMode {
  return SYSTEM_JIT_INSTALL_MODES.some((mode) => mode === value);
}

export function decodeJitInstallMode(value: unknown): SystemJitInstallMode {
  const mode = string(value, "JIT install mode");
  if (!isJitInstallMode(mode)) {
    throw new VMError("PROTOCOL_ERROR", "JIT install mode is invalid");
  }
  return mode;
}

/** Why compiles stay on the guest's thread although the install mode defers them. */
export type SystemBackgroundCompileFallback = "compiler-unavailable" | "compiler-failed";

/**
 * Schema 44: the execution worker's side of Tier-1 compiles off the guest's thread. Every
 * submitted module is compiled, failed, abandoned (worker failure, timeout or no compiler),
 * discarded (its runtime was reset first) or still in flight, waiting in a batch or compiling.
 * Joins are deferrals of a module already in flight; refusals are deferrals the core refused and
 * queue-full ones the compiler had no room for, both compiled on the guest's thread instead.
 * Schema 45 adds linked batches.
 */
export interface SystemBackgroundCompileProfile {
  readonly installMode: SystemJitInstallMode;
  readonly fallback: SystemBackgroundCompileFallback | null;
  readonly submitted: number;
  readonly joined: number;
  readonly refused: number;
  readonly queueFull: number;
  readonly compiled: number;
  readonly failed: number;
  readonly abandoned: number;
  readonly discarded: number;
  /** Results for compiles the worker no longer tracked, ignored. */
  readonly staleResults: number;
  readonly inFlight: number;
  readonly peakInFlight: number;
  /** Compile time the compiler reported for installed modules. */
  readonly compileMilliseconds: number;
  /** Submission to installation, summed over installed modules. */
  readonly latencyMilliseconds: number;
  /** Execution slices ended early because a compiled module was ready. */
  readonly earlyYields: number;
  /** Linked modules sent to the compiler, each holding at least two Tier-1 modules. */
  readonly batches: number;
  /** Tier-1 modules compiled inside linked modules. */
  readonly batchedModules: number;
  /** Members of the largest linked module. */
  readonly largestBatch: number;
  /** Batches the core refused to link; their modules compiled standalone instead. */
  readonly linkFailures: number;
}

const COUNT_KEYS = [
  "submitted",
  "joined",
  "refused",
  "queueFull",
  "compiled",
  "failed",
  "abandoned",
  "discarded",
  "staleResults",
  "inFlight",
  "peakInFlight",
  "earlyYields",
] as const satisfies readonly (keyof SystemBackgroundCompileProfile)[];

/** Schema 45: linked batches. */
const BATCH_KEYS = [
  "batches",
  "batchedModules",
  "largestBatch",
  "linkFailures",
] as const satisfies readonly (keyof SystemBackgroundCompileProfile)[];

const MILLISECOND_KEYS = [
  "compileMilliseconds",
  "latencyMilliseconds",
] as const satisfies readonly (keyof SystemBackgroundCompileProfile)[];

export function emptyBackgroundCompileProfile(): SystemBackgroundCompileProfile {
  return {
    installMode: "immediate",
    fallback: null,
    submitted: 0,
    joined: 0,
    refused: 0,
    queueFull: 0,
    compiled: 0,
    failed: 0,
    abandoned: 0,
    discarded: 0,
    staleResults: 0,
    inFlight: 0,
    peakInFlight: 0,
    compileMilliseconds: 0,
    latencyMilliseconds: 0,
    earlyYields: 0,
    batches: 0,
    batchedModules: 0,
    largestBatch: 0,
    linkFailures: 0,
  };
}

/** Every submitted module has one outcome or is still in flight, and every linked module holds
 * between two and `MAX_LINKED_JIT_MEMBERS` of them. */
export function backgroundCompileReconciles(profile: SystemBackgroundCompileProfile): boolean {
  const batches = profile.batches === 0
    ? profile.batchedModules === 0 && profile.largestBatch === 0
    : profile.largestBatch >= 2
      && profile.batchedModules >= 2 * profile.batches
      && profile.batchedModules <= profile.largestBatch * profile.batches;
  return profile.submitted
    === profile.compiled + profile.failed + profile.abandoned + profile.discarded + profile.inFlight
    && profile.inFlight <= profile.peakInFlight
    && profile.batchedModules <= profile.submitted
    && profile.largestBatch <= MAX_LINKED_JIT_MEMBERS
    && batches;
}

export function decodeBackgroundCompileProfile(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): SystemBackgroundCompileProfile {
  const profile = record(value, "background compile profile");
  const linked = schemaVersion >= 45;
  exactKeys(profile, [
    "installMode",
    "fallback",
    ...COUNT_KEYS,
    ...(linked ? BATCH_KEYS : []),
    ...MILLISECOND_KEYS,
  ]);
  const installMode = decodeJitInstallMode(profile["installMode"]);
  if (!linked && installMode === "batched") {
    throw new VMError("PROTOCOL_ERROR", "JIT install mode is invalid");
  }
  const rawFallback = profile["fallback"];
  const fallback = rawFallback === null ? null : string(rawFallback, "background compile fallback");
  if (fallback !== null && fallback !== "compiler-unavailable" && fallback !== "compiler-failed") {
    throw new VMError("PROTOCOL_ERROR", "background compile fallback is invalid");
  }
  const count = (key: (typeof COUNT_KEYS)[number] | (typeof BATCH_KEYS)[number]) =>
    integer(profile[key], `background compile ${key}`, 0);
  const batchCount = (key: (typeof BATCH_KEYS)[number]) => (linked ? count(key) : 0);
  const milliseconds = (key: (typeof MILLISECOND_KEYS)[number]) =>
    finiteNonnegativeNumber(profile[key], `background compile ${key}`);
  const decoded: SystemBackgroundCompileProfile = {
    installMode,
    fallback,
    submitted: count("submitted"),
    joined: count("joined"),
    refused: count("refused"),
    queueFull: count("queueFull"),
    compiled: count("compiled"),
    failed: count("failed"),
    abandoned: count("abandoned"),
    discarded: count("discarded"),
    staleResults: count("staleResults"),
    inFlight: count("inFlight"),
    peakInFlight: count("peakInFlight"),
    compileMilliseconds: milliseconds("compileMilliseconds"),
    latencyMilliseconds: milliseconds("latencyMilliseconds"),
    earlyYields: count("earlyYields"),
    batches: batchCount("batches"),
    batchedModules: batchCount("batchedModules"),
    largestBatch: batchCount("largestBatch"),
    linkFailures: batchCount("linkFailures"),
  };
  if (!backgroundCompileReconciles(decoded)) {
    throw new VMError("PROTOCOL_ERROR", "background compile counters do not reconcile");
  }
  return decoded;
}
