import type {
  SystemInterpretedActionReason,
  SystemInterpreterReason,
  SystemJitEvictionReason,
  SystemTraceProfile,
} from "../../protocol.js";
import {
  emptyBackgroundCompileProfile,
  type SystemBackgroundCompileProfile,
} from "../../protocol/system-trace-background-compile.js";
import { interpretedActionReasonRecord } from "../../protocol/system-trace-interpreted-actions.js";
import { emptySystemHostAttentionProfile, type MutableSystemHostAttentionProfile } from "../../protocol/system-attention.js";

export interface MutableRuntimeStats {
  jitInstructions: bigint;
  interpretedInstructions: bigint;
  cacheHits: bigint;
  moduleLoads: bigint;
  compileSamples: number;
  compileMaximumMilliseconds: number;
  readonly compileLatency: Uint32Array<ArrayBuffer>;
  guardExits: bigint;
  evictions: bigint;
}

export interface MutableSystemTraceProfile {
  readonly worker: {
    jitBatches: number;
    jitInstructions: bigint;
    jitChainTransitions: bigint;
    jitMilliseconds: number;
    jitCacheHits: bigint;
    jitGuardExits: bigint;
    interpreterBatches: number;
    interpreterMilliseconds: number;
    prepareCalls: number;
    prepareSamples: number;
    prepareSampleMilliseconds: number;
    executionLoopCalls: number;
    executionLoopMilliseconds: number;
    taskYields: number;
    taskYieldMilliseconds: number;
    consoleAckWaits: number;
    consoleAckWaitMilliseconds: number;
    agentTurnWaits: number;
    agentTurnWaitMilliseconds: number;
    compileMilliseconds: number;
    instantiateMilliseconds: number;
    installMilliseconds: number;
    synchronousCompiles: number;
    dormantJitReactivations: number;
    dormantJitReactivationBytes: number;
    compileModules: number;
    firstCompileModules: number;
    recompiledModules: number;
    compiledInstructions: bigint;
    compileBytes: number;
    maximumCandidateInstructions: number;
    maximumCandidateBytes: number;
    peakLiveModules: number;
    moduleEvictions: number;
    peakCacheBytes: number;
    emittedIrOperations: number;
    foldedIrOperations: number;
    elidedIrOperations: number;
    initialStateMask: bigint;
    dirtyStateMask: bigint;
    stateMaterializationBoundaries: number;
    segmentGuards: number;
    readonly dispatchVictimAge: MutableJitDistanceBuckets;
    dispatchSubsequentRecompiles: number;
    readonly dispatchRecompileReuseDistance: MutableJitDistanceBuckets;
    dispatchEvictionTrackingDropped: number;
    readonly evictionReasons: Record<
      SystemJitEvictionReason,
      MutableJitEvictionReasonProfile
    >;
    readonly interpreterReasons: Record<
      SystemInterpreterReason,
      MutableInterpreterReasonProfile
    >;
    readonly interpretedActionReasons: Record<
      SystemInterpretedActionReason,
      { batches: number; instructions: bigint }
    >;
    readonly backgroundCompile: MutableBackgroundCompileProfile;
    readonly hostAttention: MutableSystemHostAttentionProfile;
  };
  readonly agent: {
    requests: number;
    spawnedProcesses: number;
    stdinBytes: number;
    stdoutBytes: number;
    stderrBytes: number;
  };
}

export type MutableBackgroundCompileProfile = {
  -readonly [Key in keyof SystemBackgroundCompileProfile]: SystemBackgroundCompileProfile[Key];
};

interface MutableInterpreterReasonProfile {
  batches: number;
  instructions: bigint;
  milliseconds: number;
}

interface MutableJitEvictionReasonProfile {
  modules: number;
  bytes: number;
}

export function createSystemTraceProfile(): MutableSystemTraceProfile {
  return {
    worker: {
      jitBatches: 0,
      jitInstructions: 0n,
      jitChainTransitions: 0n,
      jitMilliseconds: 0,
      jitCacheHits: 0n,
      jitGuardExits: 0n,
      interpreterBatches: 0,
      interpreterMilliseconds: 0,
      prepareCalls: 0,
      prepareSamples: 0,
      prepareSampleMilliseconds: 0,
      executionLoopCalls: 0,
      executionLoopMilliseconds: 0,
      taskYields: 0,
      taskYieldMilliseconds: 0,
      consoleAckWaits: 0,
      consoleAckWaitMilliseconds: 0,
      agentTurnWaits: 0,
      agentTurnWaitMilliseconds: 0,
      compileMilliseconds: 0,
      instantiateMilliseconds: 0,
      installMilliseconds: 0,
      synchronousCompiles: 0,
      dormantJitReactivations: 0,
      dormantJitReactivationBytes: 0,
      compileModules: 0,
      firstCompileModules: 0,
      recompiledModules: 0,
      compiledInstructions: 0n,
      compileBytes: 0,
      maximumCandidateInstructions: 0,
      maximumCandidateBytes: 0,
      peakLiveModules: 0,
      moduleEvictions: 0,
      peakCacheBytes: 0,
      emittedIrOperations: 0,
      foldedIrOperations: 0,
      elidedIrOperations: 0,
      initialStateMask: 0n,
      dirtyStateMask: 0n,
      stateMaterializationBoundaries: 0,
      segmentGuards: 0,
      dispatchVictimAge: createJitDistanceBuckets(),
      dispatchSubsequentRecompiles: 0,
      dispatchRecompileReuseDistance: createJitDistanceBuckets(),
      dispatchEvictionTrackingDropped: 0,
      evictionReasons: createJitEvictionReasonProfiles(),
      interpreterReasons: createInterpreterReasonProfiles(),
      interpretedActionReasons: createInterpretedActionReasonProfiles(),
      backgroundCompile: emptyBackgroundCompileProfile(),
      hostAttention: emptySystemHostAttentionProfile(),
    },
    agent: {
      requests: 0,
      spawnedProcesses: 0,
      stdinBytes: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
    },
  };
}

interface MutableJitDistanceBuckets {
  "0-15": number;
  "16-63": number;
  "64-255": number;
  "256-1023": number;
  "1024+": number;
}

export function createJitDistanceBuckets(): MutableJitDistanceBuckets {
  return { "0-15": 0, "16-63": 0, "64-255": 0, "256-1023": 0, "1024+": 0 };
}

export function recordJitDistance(
  buckets: MutableJitDistanceBuckets,
  distance: number,
): void {
  const key = distance < 16
    ? "0-15"
    : distance < 64
      ? "16-63"
      : distance < 256
        ? "64-255"
        : distance < 1_024
          ? "256-1023"
          : "1024+";
  buckets[key] += 1;
}

function createJitEvictionReasonProfiles(): Record<
  SystemJitEvictionReason,
  MutableJitEvictionReasonProfile
> {
  return {
    "byte-capacity": { modules: 0, bytes: 0 },
    "code-budget": { modules: 0, bytes: 0 },
    "dispatch-slot": { modules: 0, bytes: 0 },
    "duplicate-install": { modules: 0, bytes: 0 },
    "stale-registration": { modules: 0, bytes: 0 },
    "trace-reconfiguration": { modules: 0, bytes: 0 },
  };
}

export function copyJitEvictionReasonProfiles(
  profiles: Readonly<
    Record<SystemJitEvictionReason, MutableJitEvictionReasonProfile>
  >,
): SystemTraceProfile["worker"]["evictionReasons"] {
  return {
    "byte-capacity": { ...profiles["byte-capacity"] },
    "code-budget": { ...profiles["code-budget"] },
    "dispatch-slot": { ...profiles["dispatch-slot"] },
    "duplicate-install": { ...profiles["duplicate-install"] },
    "stale-registration": { ...profiles["stale-registration"] },
    "trace-reconfiguration": { ...profiles["trace-reconfiguration"] },
  };
}

function createInterpreterReasonProfiles(): Record<
  SystemInterpreterReason,
  MutableInterpreterReasonProfile
> {
  return {
    admission: { batches: 0, instructions: 0n, milliseconds: 0 },
    "code-budget": { batches: 0, instructions: 0n, milliseconds: 0 },
    degraded: { batches: 0, instructions: 0n, milliseconds: 0 },
    guard: { batches: 0, instructions: 0n, milliseconds: 0 },
    quarantine: { batches: 0, instructions: 0n, milliseconds: 0 },
  };
}

type MutableInterpretedActionReasonProfiles = MutableSystemTraceProfile["worker"]["interpretedActionReasons"];

export function createInterpretedActionReasonProfiles(): MutableInterpretedActionReasonProfiles {
  return interpretedActionReasonRecord(() => ({ batches: 0, instructions: 0n }));
}

export function copyInterpretedActionReasonProfiles(
  profiles: MutableInterpretedActionReasonProfiles,
): SystemTraceProfile["worker"]["interpretedActionReasons"] {
  return interpretedActionReasonRecord(reason => ({ ...profiles[reason] }));
}

export function copyInterpreterReasonProfiles(
  profiles: Readonly<
    Record<SystemInterpreterReason, MutableInterpreterReasonProfile>
  >,
): SystemTraceProfile["worker"]["interpreterReasons"] {
  return {
    admission: { ...profiles.admission },
    "code-budget": { ...profiles["code-budget"] },
    degraded: { ...profiles.degraded },
    guard: { ...profiles.guard },
    quarantine: { ...profiles.quarantine },
  };
}

export function recordCompileLatency(
  stats: MutableRuntimeStats,
  milliseconds: number,
): void {
  // Publish a completed load and its latency sample atomically.
  stats.moduleLoads += 1n;
  const rounded = Math.max(0, Math.ceil(milliseconds));
  const bucket = Math.min(rounded, stats.compileLatency.length - 1);
  stats.compileLatency[bucket] =
    (stats.compileLatency[bucket] ?? 0) + 1;
  stats.compileSamples += 1;
  stats.compileMaximumMilliseconds = Math.max(
    stats.compileMaximumMilliseconds,
    rounded,
  );
}

export function latencyPercentile(
  histogram: Uint32Array,
  samples: number,
  percentile: number,
): number {
  if (samples === 0) return 0;
  const target = Math.ceil((samples * percentile) / 100);
  let cumulative = 0;
  for (const [milliseconds, count] of histogram.entries()) {
    cumulative += count;
    if (cumulative >= target) return milliseconds;
  }
  return histogram.length - 1;
}
