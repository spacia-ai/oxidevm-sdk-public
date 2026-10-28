/** Decodes the profile section of a system trace snapshot: worker, disk, agent and network
 * profiles, with the counter invariants that make an incomplete or inconsistent profile fail. */
import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";
import {
  finiteNonnegativeNumber,
  nonnegativeBigint,
} from "./decoders.js";
import {
  LEGACY_SYSTEM_INTERPRETER_REASONS,
  LEGACY_SYSTEM_JIT_EVICTION_REASONS,
  SYSTEM_INTERPRETER_REASONS,
  SYSTEM_JIT_EVICTION_REASONS,
  type SystemInterpreterReason,
  type SystemInterpreterReasonProfile,
  type SystemJitEvictionReason,
  type SystemJitEvictionReasonProfile,
  type SystemJitDistanceBuckets,
  type SystemTraceProfile,
  type SystemTraceSnapshot,
  type CoreRuntimeProfile,
} from "./system.js";
import { decodeSystemTraceDiskProfile } from "./system-trace-disk.js";
import { decodeSystemTraceNetworkProfile } from "./system-trace-network.js";
import { decodeSystemTraceSession } from "./system-trace-session.js";
import { decodeInterpretedActionReasonProfiles, emptyInterpretedActionReasonProfiles } from "./system-trace-interpreted-actions.js";
import {
  decodeBackgroundCompileProfile,
  emptyBackgroundCompileProfile,
} from "./system-trace-background-compile.js";
import {
  coreRecordVersionForTrace,
  decodeCoreRuntimeProfile,
  EMPTY_CORE_RUNTIME_PROFILE,
} from "./system-trace-core-profile.js";
import { decodeJitFailure } from "./system-trace-identity.js";
import { decodeSystemHostAttentionProfile, emptySystemHostAttentionProfile } from "./system-attention.js";
import { decodeJitCodeProfile, emptyJitCodeProfile } from "./system-trace-jit-code.js";
import {
  decodeJitHealthProfile,
  emptyJitHealthProfile,
  stickyFailureMatchesHealth,
} from "./system-trace-jit-health.js";
import {
  emptyInterpreterReasonProfiles,
  legacyEvictedTraceCount,
} from "./system-trace-legacy.js";

const ARCHITECTURAL_STATE_MASK = 0x0000_000f_0000_ffffn;
const WORKER_PROFILE_KEYS_V23 = [
  "dispatchVictimAge",
  "dispatchSubsequentRecompiles",
  "dispatchRecompileReuseDistance",
  "dispatchEvictionTrackingDropped",
] as const;
const WORKER_PROFILE_KEYS_V24 = [
  "dormantJitReactivations",
  "dormantJitReactivationBytes",
] as const;

export function decodeSystemTraceProfile(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): SystemTraceProfile {
  const profile = record(value, "system trace profile");
  exactKeys(profile, ["worker", "disk", "agent", ...(schemaVersion >= 43 ? ["network"] : [])]);
  const worker = record(profile["worker"], "system worker profile");
  const workerKeys = [
    "jitBatches",
    "jitMilliseconds",
    "interpreterBatches",
    "interpreterMilliseconds",
    "compileMilliseconds",
  ] as const;
  exactKeys(
    worker,
    schemaVersion >= 21
      ? [
          "core",
          "jitBatches",
          "jitInstructions",
          "jitChainTransitions",
          "jitMilliseconds",
          "jitCacheHits",
          "jitGuardExits",
          "interpreterBatches",
          "interpreterMilliseconds",
          "prepareCalls",
          "prepareSamples",
          "prepareSampleMilliseconds",
          "executionLoopCalls",
          "executionLoopMilliseconds",
          "taskYields",
          "taskYieldMilliseconds",
          "consoleAckWaits",
          "consoleAckWaitMilliseconds",
          "agentTurnWaits",
          "agentTurnWaitMilliseconds",
          ...(schemaVersion >= 35 ? ["session"] : []),
          "compileMilliseconds",
          "instantiateMilliseconds",
          "installMilliseconds",
          "synchronousCompiles",
          "synchronousCompileP95Milliseconds",
          "synchronousCompileMaximumMilliseconds",
          "compileModules",
          "firstCompileModules",
          "recompiledModules",
          "compiledInstructions",
          "compileBytes",
          "maximumCandidateInstructions",
          "maximumCandidateBytes",
          "peakLiveModules",
          "moduleEvictions",
          "peakCacheBytes",
          "emittedIrOperations",
          "foldedIrOperations",
          "elidedIrOperations",
          "initialStateMask",
          "dirtyStateMask",
          "stateMaterializationBoundaries",
          "segmentGuards",
          ...(schemaVersion >= 23 ? WORKER_PROFILE_KEYS_V23 : []),
          ...(schemaVersion >= 24 ? WORKER_PROFILE_KEYS_V24 : []),
          "stickyJitFailure",
          "evictionReasons",
          "interpreterReasons",
          ...(schemaVersion >= 36 ? ["interpretedActionReasons"] : []),
          ...(schemaVersion >= 44 ? ["backgroundCompile"] : []),
          ...(schemaVersion >= 47 ? ["jitHealth"] : []),
          ...(schemaVersion >= 48 ? ["jitCode"] : []),
          ...(schemaVersion >= 54 ? ["hostAttention"] : []),
        ]
      : schemaVersion >= 9
      ? [
          ...workerKeys,
          "jitInstructions",
          ...(schemaVersion >= 11 ? ["jitChainTransitions"] : []),
          "jitCacheHits",
          "jitGuardExits",
          ...(schemaVersion >= 12
            ? [
                "prepareCalls",
                "prepareSamples",
                "prepareSampleMilliseconds",
                "executionLoopCalls",
                "executionLoopMilliseconds",
                "taskYields",
                "taskYieldMilliseconds",
                "consoleAckWaits",
                "consoleAckWaitMilliseconds",
                "agentTurnWaits",
                "agentTurnWaitMilliseconds",
              ]
            : []),
          ...(schemaVersion >= 35 ? ["session"] : []),
          ...(schemaVersion >= 13 ? ["core"] : []),
          "compileRequests",
          "compileTraces",
          "firstCompileTraces",
          "repeatCompileTraces",
          ...(schemaVersion >= 12
            ? [
                "compilerMilliseconds",
                "instantiateMilliseconds",
                "installMilliseconds",
                "compiledInstructions",
              ]
            : []),
          "compileBytes",
          ...(schemaVersion >= 12
            ? [
                "maximumCandidateInstructions",
                "maximumCandidateBytes",
                "maximumBundleTraces",
                "maximumBundleBytes",
                "peakPendingTraces",
                "peakPendingBytes",
                "peakLiveBundles",
                "peakLiveTraces",
              ]
            : []),
          "bundleEvictions",
          "evictedTraces",
          "peakCacheBytes",
          ...(schemaVersion >= 10 ? ["evictionReasons"] : []),
          "interpreterReasons",
        ]
      : schemaVersion >= 8
      ? [
          ...workerKeys,
          "jitInstructions",
          "jitCacheHits",
          "jitGuardExits",
          "compileRequests",
          "compileTraces",
          "compileBytes",
          "bundleEvictions",
          "peakCacheBytes",
          "interpreterReasons",
        ]
      : schemaVersion >= 7
        ? [...workerKeys, "interpreterReasons"]
      : workerKeys,
    [
      ...(schemaVersion < 23 ? WORKER_PROFILE_KEYS_V23 : []),
      ...(schemaVersion < 24 ? WORKER_PROFILE_KEYS_V24 : []),
    ],
  );
  const suppliedWorkerV23Keys = WORKER_PROFILE_KEYS_V23.filter(
    (key) => worker[key] !== undefined,
  );
  if (
    schemaVersion < 23 &&
    suppliedWorkerV23Keys.length !== 0
  ) {
    if (suppliedWorkerV23Keys.length !== WORKER_PROFILE_KEYS_V23.length) {
      throw new VMError("PROTOCOL_ERROR", "legacy dispatch profile is incomplete");
    }
    const victim = decodeJitDistanceBuckets(worker["dispatchVictimAge"], "dispatch victim age");
    const reuse = decodeJitDistanceBuckets(
      worker["dispatchRecompileReuseDistance"],
      "dispatch recompile reuse distance",
    );
    if (
      Object.values(victim).some((count) => count !== 0) ||
      Object.values(reuse).some((count) => count !== 0) ||
      integer(worker["dispatchSubsequentRecompiles"], "dispatch subsequent recompiles", 0) !== 0 ||
      integer(worker["dispatchEvictionTrackingDropped"], "dropped dispatch eviction tracking", 0) !== 0
    ) {
      throw new VMError("PROTOCOL_ERROR", "legacy dispatch profile is not empty");
    }
  }
  const suppliedWorkerV24Keys = WORKER_PROFILE_KEYS_V24.filter(
    (key) => worker[key] !== undefined,
  );
  if (schemaVersion < 24 && suppliedWorkerV24Keys.length !== 0) {
    if (suppliedWorkerV24Keys.length !== WORKER_PROFILE_KEYS_V24.length) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "legacy dormant-reactivation profile is incomplete",
      );
    }
    if (
      integer(worker["dormantJitReactivations"], "dormant JIT reactivations", 0) !== 0 ||
      integer(worker["dormantJitReactivationBytes"], "dormant JIT reactivation bytes", 0) !== 0
    ) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "legacy dormant-reactivation profile is not empty",
      );
    }
  }
  const agent = record(profile["agent"], "system agent profile");
  exactKeys(agent, [
    "requests",
    "spawnedProcesses",
    "stdinBytes",
    "stdoutBytes",
    "stderrBytes",
  ]);
  const decoded: SystemTraceProfile = {
    worker: {
      core:
        schemaVersion >= 13
          ? decodeCoreRuntimeProfile(worker["core"], schemaVersion)
          : EMPTY_CORE_RUNTIME_PROFILE,
      jitBatches: integer(worker["jitBatches"], "JIT profile batches", 0),
      jitInstructions:
        schemaVersion >= 8
          ? nonnegativeBigint(
              worker["jitInstructions"],
              "JIT profile instructions",
            )
          : 0n,
      jitChainTransitions:
        schemaVersion >= 11
          ? nonnegativeBigint(
              worker["jitChainTransitions"],
              "JIT chain transitions",
            )
          : 0n,
      jitMilliseconds: finiteNonnegativeNumber(
        worker["jitMilliseconds"],
        "JIT profile duration",
      ),
      jitCacheHits:
        schemaVersion >= 8
          ? nonnegativeBigint(worker["jitCacheHits"], "JIT profile cache hits")
          : 0n,
      jitGuardExits:
        schemaVersion >= 8
          ? nonnegativeBigint(
              worker["jitGuardExits"],
              "JIT profile guard exits",
            )
          : 0n,
      interpreterBatches: integer(
        worker["interpreterBatches"],
        "interpreter profile batches",
        0,
      ),
      interpreterMilliseconds: finiteNonnegativeNumber(
        worker["interpreterMilliseconds"],
        "interpreter profile duration",
      ),
      prepareCalls:
        schemaVersion >= 12
          ? integer(worker["prepareCalls"], "JIT prepare calls", 0)
          : 0,
      prepareSamples:
        schemaVersion >= 12
          ? integer(worker["prepareSamples"], "JIT prepare samples", 0)
          : 0,
      prepareSampleMilliseconds:
        schemaVersion >= 12
          ? finiteNonnegativeNumber(
              worker["prepareSampleMilliseconds"],
              "sampled JIT prepare duration",
            )
          : 0,
      executionLoopCalls:
        schemaVersion >= 12
          ? integer(worker["executionLoopCalls"], "execution loop calls", 0)
          : 0,
      executionLoopMilliseconds:
        schemaVersion >= 12
          ? finiteNonnegativeNumber(
              worker["executionLoopMilliseconds"],
              "execution loop duration",
            )
          : 0,
      taskYields:
        schemaVersion >= 12
          ? integer(worker["taskYields"], "control worker task yields", 0)
          : 0,
      taskYieldMilliseconds:
        schemaVersion >= 12
          ? finiteNonnegativeNumber(
              worker["taskYieldMilliseconds"],
              "control worker task yield duration",
            )
          : 0,
      consoleAckWaits:
        schemaVersion >= 12
          ? integer(worker["consoleAckWaits"], "console acknowledgement waits", 0)
          : 0,
      consoleAckWaitMilliseconds:
        schemaVersion >= 12
          ? finiteNonnegativeNumber(
              worker["consoleAckWaitMilliseconds"],
              "console acknowledgement wait duration",
            )
          : 0,
      agentTurnWaits:
        schemaVersion >= 12
          ? integer(worker["agentTurnWaits"], "guest-agent worker waits", 0)
          : 0,
      agentTurnWaitMilliseconds:
        schemaVersion >= 12
          ? finiteNonnegativeNumber(
              worker["agentTurnWaitMilliseconds"],
              "guest-agent worker wait duration",
            )
          : 0,
      ...(schemaVersion >= 35 ? { session: decodeSystemTraceSession(worker["session"], schemaVersion) } : {}),
      compileMilliseconds: finiteNonnegativeNumber(
        worker["compileMilliseconds"],
        "JIT compile profile duration",
      ),
      instantiateMilliseconds:
        schemaVersion >= 12
          ? finiteNonnegativeNumber(
              worker["instantiateMilliseconds"],
              "JIT instantiate duration",
            )
          : 0,
      installMilliseconds:
        schemaVersion >= 12
          ? finiteNonnegativeNumber(
              worker["installMilliseconds"],
              "JIT install duration",
            )
          : 0,
      synchronousCompiles:
        schemaVersion >= 21
          ? integer(worker["synchronousCompiles"], "synchronous JIT compiles", 0)
          : schemaVersion >= 8
            ? integer(worker["compileRequests"], "JIT compile requests", 0)
            : 0,
      synchronousCompileP95Milliseconds:
        schemaVersion >= 21
          ? integer(
              worker["synchronousCompileP95Milliseconds"],
              "synchronous JIT compile p95",
              0,
            )
          : 0,
      dormantJitReactivations:
        schemaVersion >= 24
          ? integer(
              worker["dormantJitReactivations"],
              "dormant JIT reactivations",
              0,
            )
          : 0,
      dormantJitReactivationBytes:
        schemaVersion >= 24
          ? integer(
              worker["dormantJitReactivationBytes"],
              "dormant JIT reactivation bytes",
              0,
            )
          : 0,
      synchronousCompileMaximumMilliseconds:
        schemaVersion >= 21
          ? integer(
              worker["synchronousCompileMaximumMilliseconds"],
              "synchronous JIT compile maximum",
              0,
            )
          : 0,
      compileModules:
        schemaVersion >= 21
          ? integer(worker["compileModules"], "JIT compiled modules", 0)
          : schemaVersion >= 8
            ? integer(worker["compileTraces"], "JIT compiled traces", 0)
            : 0,
      firstCompileModules:
        schemaVersion >= 21
          ? integer(
              worker["firstCompileModules"],
              "first-time JIT compiled modules",
              0,
            )
          : schemaVersion >= 9
            ? integer(
                worker["firstCompileTraces"],
                "first-time JIT compiled traces",
                0,
              )
            : 0,
      recompiledModules:
        schemaVersion >= 21
          ? integer(worker["recompiledModules"], "recompiled JIT modules", 0)
          : schemaVersion >= 9
            ? integer(worker["repeatCompileTraces"], "recompiled JIT traces", 0)
            : 0,
      compiledInstructions:
        schemaVersion >= 12
          ? nonnegativeBigint(
              worker["compiledInstructions"],
              "compiled guest instructions",
            )
          : 0n,
      compileBytes:
        schemaVersion >= 8
          ? integer(worker["compileBytes"], "JIT compiled bytes", 0)
          : 0,
      maximumCandidateInstructions:
        schemaVersion >= 12
          ? integer(
              worker["maximumCandidateInstructions"],
              "maximum JIT candidate instructions",
              0,
            )
          : 0,
      maximumCandidateBytes:
        schemaVersion >= 12
          ? integer(
              worker["maximumCandidateBytes"],
              "maximum JIT candidate bytes",
              0,
            )
          : 0,
      peakLiveModules:
        schemaVersion >= 21
          ? integer(worker["peakLiveModules"], "peak live JIT modules", 0)
          : schemaVersion >= 12
            ? integer(worker["peakLiveBundles"], "peak live JIT bundles", 0)
            : 0,
      moduleEvictions:
        schemaVersion >= 21
          ? integer(worker["moduleEvictions"], "JIT module evictions", 0)
          : schemaVersion >= 8
            ? integer(worker["bundleEvictions"], "JIT bundle evictions", 0)
            : 0,
      peakCacheBytes:
        schemaVersion >= 8
          ? integer(worker["peakCacheBytes"], "JIT peak cache bytes", 0)
          : 0,
      emittedIrOperations:
        schemaVersion >= 21
          ? integer(worker["emittedIrOperations"], "emitted JIT IR operations", 0)
          : 0,
      foldedIrOperations:
        schemaVersion >= 21
          ? integer(worker["foldedIrOperations"], "folded JIT IR operations", 0)
          : 0,
      elidedIrOperations:
        schemaVersion >= 21
          ? integer(worker["elidedIrOperations"], "elided JIT IR operations", 0)
          : 0,
      initialStateMask:
        schemaVersion >= 21
          ? nonnegativeBigint(worker["initialStateMask"], "initial JIT state mask")
          : 0n,
      dirtyStateMask:
        schemaVersion >= 21
          ? nonnegativeBigint(worker["dirtyStateMask"], "dirty JIT state mask")
          : 0n,
      stateMaterializationBoundaries:
        schemaVersion >= 21
          ? integer(
              worker["stateMaterializationBoundaries"],
              "JIT state materialization boundaries",
              0,
            )
          : 0,
      segmentGuards:
        schemaVersion >= 21
          ? integer(worker["segmentGuards"], "JIT segment guards", 0)
          : 0,
      dispatchVictimAge:
        schemaVersion >= 23
          ? decodeJitDistanceBuckets(worker["dispatchVictimAge"], "dispatch victim age")
          : emptyJitDistanceBuckets(),
      dispatchSubsequentRecompiles:
        schemaVersion >= 23
          ? integer(
              worker["dispatchSubsequentRecompiles"],
              "dispatch subsequent recompiles",
              0,
            )
          : 0,
      dispatchRecompileReuseDistance:
        schemaVersion >= 23
          ? decodeJitDistanceBuckets(
              worker["dispatchRecompileReuseDistance"],
              "dispatch recompile reuse distance",
            )
          : emptyJitDistanceBuckets(),
      dispatchEvictionTrackingDropped:
        schemaVersion >= 23
          ? integer(
              worker["dispatchEvictionTrackingDropped"],
              "dropped dispatch eviction tracking",
              0,
            )
          : 0,
      stickyJitFailure:
        schemaVersion >= 21 ? decodeJitFailure(worker["stickyJitFailure"], schemaVersion) : null,
      evictionReasons:
        schemaVersion >= 10
          ? decodeJitEvictionReasonProfiles(
              worker["evictionReasons"],
              schemaVersion,
            )
          : emptyJitEvictionReasonProfiles(),
      interpreterReasons:
        schemaVersion >= 7
          ? decodeInterpreterReasonProfiles(
              worker["interpreterReasons"],
              schemaVersion,
            )
          : emptyInterpreterReasonProfiles(),
      interpretedActionReasons:
        schemaVersion >= 36
          ? decodeInterpretedActionReasonProfiles(worker["interpretedActionReasons"], schemaVersion)
          : emptyInterpretedActionReasonProfiles(),
      backgroundCompile:
        schemaVersion >= 44
          ? decodeBackgroundCompileProfile(worker["backgroundCompile"], schemaVersion)
          : emptyBackgroundCompileProfile(),
      jitHealth:
        schemaVersion >= 47
          ? decodeJitHealthProfile(worker["jitHealth"])
          : emptyJitHealthProfile(),
      jitCode:
        schemaVersion >= 48
          ? decodeJitCodeProfile(worker["jitCode"])
          : emptyJitCodeProfile(),
      hostAttention:
        schemaVersion >= 54
          ? decodeSystemHostAttentionProfile(worker["hostAttention"])
          : emptySystemHostAttentionProfile(),
    },
    disk: decodeSystemTraceDiskProfile(profile["disk"], schemaVersion),
    ...(schemaVersion >= 43 ? { network: decodeSystemTraceNetworkProfile(profile["network"], schemaVersion) } : {}),
    agent: {
      requests: integer(agent["requests"], "agent profile requests", 0),
      spawnedProcesses: integer(
        agent["spawnedProcesses"],
        "agent profile process count",
        0,
      ),
      stdinBytes: integer(agent["stdinBytes"], "agent profile stdin bytes", 0),
      stdoutBytes: integer(
        agent["stdoutBytes"],
        "agent profile stdout bytes",
        0,
      ),
      stderrBytes: integer(
        agent["stderrBytes"],
        "agent profile stderr bytes",
        0,
      ),
    },
  };
  const legacyCompilingBatches =
    schemaVersion >= 7 && schemaVersion < 21
      ? decodeLegacyCompilingBatches(worker["interpreterReasons"])
      : 0;
  if (
    schemaVersion >= 7 &&
    SYSTEM_INTERPRETER_REASONS.reduce(
      (total, reason) =>
        total + decoded.worker.interpreterReasons[reason].batches,
      0,
    ) + legacyCompilingBatches !== decoded.worker.interpreterBatches
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "interpreter reason counters do not agree",
    );
  }
  if (
    schemaVersion >= 10 &&
    (SYSTEM_JIT_EVICTION_REASONS.reduce(
      (total, reason) => total + decoded.worker.evictionReasons[reason].modules,
      0,
    ) !== decoded.worker.moduleEvictions ||
      (schemaVersion < 21 &&
        legacyEvictedTraceCount(worker) !==
          integer(worker["evictedTraces"], "evicted JIT traces", 0)))
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "JIT eviction reason counters do not agree",
    );
  }
  const chain = decoded.worker.core;
  if (
    schemaVersion >= 29 &&
    chain.enabled &&
    (chain.jitTier1Retired + chain.jitTier2Retired !== decoded.worker.jitInstructions ||
      chain.jitTier1Retired !==
        chain.jitTier1Ring0Retired + chain.jitTier1Ring3Retired ||
      chain.jitTier2Retired !==
        chain.jitTier2Ring0Retired + chain.jitTier2Ring3Retired)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      `JIT tier-retirement counters do not agree: tier1=${chain.jitTier1Retired.toString()} (ring0=${chain.jitTier1Ring0Retired.toString()}, ring3=${chain.jitTier1Ring3Retired.toString()}), tier2=${chain.jitTier2Retired.toString()} (ring0=${chain.jitTier2Ring0Retired.toString()}, ring3=${chain.jitTier2Ring3Retired.toString()}), jit=${decoded.worker.jitInstructions.toString()}`,
    );
  }
  if (
    schemaVersion >= 21 &&
    // Schema 44 compiles modules off the guest's thread too.
    (decoded.worker.synchronousCompiles + decoded.worker.backgroundCompile.compiled
      !== decoded.worker.compileModules ||
      decoded.worker.firstCompileModules + decoded.worker.recompiledModules !==
        decoded.worker.compileModules ||
      decoded.worker.synchronousCompileP95Milliseconds >
        decoded.worker.synchronousCompileMaximumMilliseconds ||
      (decoded.worker.synchronousCompiles + decoded.worker.backgroundCompile.compiled === 0 &&
        decoded.worker.synchronousCompileMaximumMilliseconds !== 0) ||
      ((decoded.worker.initialStateMask | decoded.worker.dirtyStateMask) &
        ~ARCHITECTURAL_STATE_MASK) !==
        0n ||
      decoded.worker.segmentGuards < decoded.worker.compileModules)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "synchronous JIT compile counters do not agree",
    );
  }
  if (
    schemaVersion >= 47
    && !stickyFailureMatchesHealth(decoded.worker.stickyJitFailure, decoded.worker.jitHealth)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "sticky JIT failure does not match the JIT health profile",
    );
  }
  const workload = chain.workload;
  const expectedCoreRecordVersion = coreRecordVersionForTrace(schemaVersion);
  if (schemaVersion >= 23 && chain.recordVersion !== expectedCoreRecordVersion) {
    throw new VMError(
      "PROTOCOL_ERROR",
      `system trace schema ${schemaVersion.toString()} requires core profile record ${expectedCoreRecordVersion.toString()}, received ${chain.recordVersion.toString()}`,
    );
  }
  if (
    schemaVersion >= 23 &&
    (chain.jitRegionReadyPages > chain.jitRegionDiscoveredPages ||
      chain.jitRegionReadyBlocks > chain.jitRegionDiscoveredBlocks ||
      chain.jitRegionReadyInstructions > chain.jitRegionDiscoveredInstructions ||
      chain.jitRegionUncoveredPages > chain.jitRegionReadyPages ||
      chain.jitRegionUncoveredBlocks > chain.jitRegionReadyBlocks ||
      chain.jitRegionUncoveredInstructions > chain.jitRegionReadyInstructions ||
      [
        chain.jitRegionStopInstructionLimit,
        chain.jitRegionStopBlockLimit,
        chain.jitRegionStopPageLimit,
        chain.jitRegionStopDecodeOrLowering,
        chain.jitRegionStopSuccessorNotReady,
        chain.jitRegionStopAlreadyCovered,
        chain.jitRegionStopIndirectOrHostExit,
      ].some((count) => count > chain.jitRegionCandidates))
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "JIT region counters do not agree",
    );
  }
  if (
    schemaVersion >= 23 &&
    workload.cacheConflictSamples >
      chain.jitDispatchMissTag + chain.jitReadCacheMissTag + chain.jitWriteCacheMissTag
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "JIT cache-conflict counters do not agree",
    );
  }
  if (
    schemaVersion >= 24 &&
    ((decoded.worker.dormantJitReactivations === 0) !==
      (decoded.worker.dormantJitReactivationBytes === 0) ||
      chain.jitDispatchSlotClearEntriesCleared >
        chain.jitDispatchSlotClearEntriesScanned ||
      chain.jitDispatchSlotClearEntriesScanned % 65_536n !== 0n)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "direct-cache profiling counters do not agree",
    );
  }
  if (
    schemaVersion >= 23 &&
    (jitDistanceTotal(decoded.worker.dispatchVictimAge) !==
      decoded.worker.evictionReasons["dispatch-slot"].modules ||
      jitDistanceTotal(decoded.worker.dispatchRecompileReuseDistance) !==
        decoded.worker.dispatchSubsequentRecompiles ||
      decoded.worker.dispatchSubsequentRecompiles > decoded.worker.recompiledModules)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "dispatch reuse-distance counters do not agree",
    );
  }
  if (
    schemaVersion >= 18 &&
    (chain.decodeMappingInvalidationChanges >
      chain.decodeMappingRevalidations ||
      chain.decodeMappingCr3Changes > chain.decodeMappingRevalidations ||
      chain.decodeMappingPolicyChanges > chain.decodeMappingRevalidations)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "decode mapping revalidation counters do not agree",
    );
  }
  if (
    schemaVersion >= 21 &&
    (chain.jitColdBlockExecutions > chain.jitBlockObservations ||
      chain.jitHotBlockTransitions > chain.jitColdBlockExecutions ||
      chain.jitHotBoundaryStops > chain.jitBlockObservations ||
      chain.jitPartialBudgetFallbacks > chain.jitResidentTierLoopCalls)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "resident JIT tier-loop counters do not agree",
    );
  }
  if (schemaVersion >= 14 && !jitChainProfileReconciles(chain)) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "JIT chain profile counters do not agree",
    );
  }
  if (
    schemaVersion >= 15 &&
    chain.jitAdmissionChecks !==
      chain.jitAdmissionRejections +
        chain.jitCandidatePrepareFailures +
        chain.jitCandidateBlocked +
        chain.jitCandidateEmitFailures +
        chain.jitCandidateCompiles
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "JIT admission profile counters do not agree",
    );
  }
  if (
    schemaVersion >= 28 &&
    (chain.jitTier2Eligible !== chain.jitTier2PromotionAttempts ||
      chain.jitTier2PromotionAttempts !==
        chain.jitTier2Compiles + chain.jitTier2Failures)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "Tier-2 promotion counters do not agree",
    );
  }
  if (
    schemaVersion >= 29 &&
    chain.jitTier2Failures !==
      chain.jitTier2FailureMachineUnavailable +
        chain.jitTier2FailureWriteTracking +
        chain.jitTier2FailureUnsupportedCpuContext +
        chain.jitTier2FailureDecodeOrTranslationFault +
        chain.jitTier2FailureQuarantinedSemantic +
        chain.jitTier2FailureUnsupportedSemantic +
        chain.jitTier2FailureUnsupportedForm +
        chain.jitTier2FailureEmission +
        chain.jitTier2FailureModuleSizeLimit +
        chain.jitTier2FailureCandidateLimit +
        chain.jitTier2FailureStaleProfile +
        chain.jitTier2FailureIneligibleTrace +
        chain.jitTier2FailureResidentBudget +
        chain.jitTier2FailureNoRegion +
        chain.jitTier2FailureNoEligibleEdges +
        chain.jitTier2FailureInsufficientInternalization +
        chain.jitTier2FailureNoRecurrentComponent
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "Tier-2 failure counters do not agree",
    );
  }
  if (
    schemaVersion >= 29 &&
    chain.jitTraceRecordedEdges !==
      chain.jitTraceAcceptedEdges +
        chain.jitTraceStaleEdges +
        chain.jitTraceDroppedEdges
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "trace-recording edge counters do not agree",
    );
  }
  if (
    schemaVersion >= 29 &&
    (chain.jitTraceReadSiteVisits !==
        chain.jitTraceReadReuses +
          chain.jitTraceReadRefreshes +
          chain.jitTraceReadIneligible ||
      chain.jitTraceWriteSiteVisits !==
        chain.jitTraceWriteReuses +
          chain.jitTraceWriteRefreshes +
          chain.jitTraceWriteIneligible ||
      chain.jitTraceReadFirstVisits >
        chain.jitTraceReadRefreshes + chain.jitTraceReadIneligible ||
      chain.jitTraceReadPageChanges >
        chain.jitTraceReadRefreshes + chain.jitTraceReadIneligible ||
      chain.jitTraceReadUnsafe > chain.jitTraceReadRefreshes ||
      chain.jitTraceWriteFirstVisits >
        chain.jitTraceWriteRefreshes + chain.jitTraceWriteIneligible ||
      chain.jitTraceWritePageChanges >
        chain.jitTraceWriteRefreshes + chain.jitTraceWriteIneligible ||
      chain.jitTraceWriteUnsafe > chain.jitTraceWriteRefreshes)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "Tier-2 trace-memory counters do not agree",
    );
  }
  if (
    schemaVersion >= 16 &&
    (chain.jitCacheReusedTranslations > chain.jitCandidateCompiles ||
      chain.jitCacheEightHitTranslations >
        chain.jitCacheReusedTranslations ||
      chain.jitCacheThirtyTwoHitTranslations >
        chain.jitCacheEightHitTranslations)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "JIT translation reuse counters do not agree",
    );
  }
  if (
    schemaVersion >= 17 &&
    (chain.jitChainCoverageTargets > chain.jitChainMissingCoverage ||
      chain.jitChainCoverageEightMissTargets >
        chain.jitChainCoverageTargets ||
      chain.jitChainCoverageThirtyTwoMissTargets >
        chain.jitChainCoverageEightMissTargets ||
      chain.jitChainCoverageSixtyFourMissTargets >
        chain.jitChainCoverageThirtyTwoMissTargets ||
      chain.jitChainCoverageAdmissionResetTargets >
        chain.jitChainCoverageAdmissionResets ||
      chain.jitChainCoverageAdmissionResetTargets >
        chain.jitChainCoverageTargets ||
      chain.jitChainCoverageAdmissionResets >
        chain.jitChainMissingCoverage ||
      chain.jitChainCoverageTargets +
        7n * chain.jitChainCoverageEightMissTargets +
        24n * chain.jitChainCoverageThirtyTwoMissTargets +
        32n * chain.jitChainCoverageSixtyFourMissTargets >
        chain.jitChainMissingCoverage)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "JIT missing-coverage heat counters do not agree",
    );
  }
  return decoded;
}


function emptyJitDistanceBuckets(): SystemJitDistanceBuckets {
  return { "0-15": 0, "16-63": 0, "64-255": 0, "256-1023": 0, "1024+": 0 };
}

function decodeJitDistanceBuckets(
  value: unknown,
  label: string,
): SystemJitDistanceBuckets {
  const buckets = record(value, label);
  exactKeys(buckets, ["0-15", "16-63", "64-255", "256-1023", "1024+"]);
  return {
    "0-15": integer(buckets["0-15"], `${label} 0-15`, 0),
    "16-63": integer(buckets["16-63"], `${label} 16-63`, 0),
    "64-255": integer(buckets["64-255"], `${label} 64-255`, 0),
    "256-1023": integer(buckets["256-1023"], `${label} 256-1023`, 0),
    "1024+": integer(buckets["1024+"], `${label} 1024+`, 0),
  };
}

function jitDistanceTotal(buckets: SystemJitDistanceBuckets): number {
  return (
    buckets["0-15"] +
    buckets["16-63"] +
    buckets["64-255"] +
    buckets["256-1023"] +
    buckets["1024+"]
  );
}

function decodeJitEvictionReasonProfiles(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): Readonly<
  Record<SystemJitEvictionReason, SystemJitEvictionReasonProfile>
> {
  const profiles = record(value, "JIT eviction reason profiles");
  exactKeys(
    profiles,
    schemaVersion >= 48 ? SYSTEM_JIT_EVICTION_REASONS : LEGACY_SYSTEM_JIT_EVICTION_REASONS,
  );
  const decode = (reason: SystemJitEvictionReason) => profiles[reason] === undefined
    ? { modules: 0, bytes: 0 }
    : decodeJitEvictionReasonProfile(profiles[reason], reason, schemaVersion);
  return {
    "byte-capacity": decode("byte-capacity"),
    "code-budget": decode("code-budget"),
    "dispatch-slot": decode("dispatch-slot"),
    "duplicate-install": decode("duplicate-install"),
    "stale-registration": decode("stale-registration"),
    "trace-reconfiguration": decode("trace-reconfiguration"),
  };
}

function decodeJitEvictionReasonProfile(
  value: unknown,
  reason: SystemJitEvictionReason,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): SystemJitEvictionReasonProfile {
  const profile = record(value, `${reason} JIT eviction profile`);
  exactKeys(
    profile,
    schemaVersion >= 21
      ? ["modules", "bytes"]
      : ["bundles", "traces", "bytes"],
  );
  return {
    modules:
      schemaVersion >= 21
        ? integer(profile["modules"], `${reason} evicted modules`, 0)
        : integer(profile["bundles"], `${reason} evicted bundles`, 0),
    bytes: integer(profile["bytes"], `${reason} evicted bytes`, 0),
  };
}

function emptyJitEvictionReasonProfiles(): Readonly<
  Record<SystemJitEvictionReason, SystemJitEvictionReasonProfile>
> {
  const empty = { modules: 0, bytes: 0 };
  return {
    "byte-capacity": empty,
    "code-budget": empty,
    "dispatch-slot": empty,
    "duplicate-install": empty,
    "stale-registration": empty,
    "trace-reconfiguration": empty,
  };
}

export function decodeInterpreterReasonProfiles(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): Readonly<
  Record<SystemInterpreterReason, SystemInterpreterReasonProfile>
> {
  const profiles = record(value, "interpreter reason profiles");
  exactKeys(
    profiles,
    schemaVersion >= 48
      ? SYSTEM_INTERPRETER_REASONS
      : schemaVersion >= 21
        ? LEGACY_SYSTEM_INTERPRETER_REASONS
        : ["admission", "compiling", "degraded", "guard", "quarantine"],
  );
  const decode = (reason: SystemInterpreterReason) => profiles[reason] === undefined
    ? { batches: 0, instructions: 0n, milliseconds: 0 }
    : decodeInterpreterReasonProfile(profiles[reason], reason);
  return {
    admission: decode("admission"),
    "code-budget": decode("code-budget"),
    degraded: decode("degraded"),
    guard: decode("guard"),
    quarantine: decode("quarantine"),
  };
}

function decodeInterpreterReasonProfile(
  value: unknown,
  reason: string,
): SystemInterpreterReasonProfile {
  const profile = record(value, `${reason} interpreter profile`);
  exactKeys(profile, ["batches", "instructions", "milliseconds"]);
  return {
    batches: integer(
      profile["batches"],
      `${reason} interpreter batches`,
      0,
    ),
    instructions: nonnegativeBigint(
      profile["instructions"],
      `${reason} interpreter instructions`,
    ),
    milliseconds: finiteNonnegativeNumber(
      profile["milliseconds"],
      `${reason} interpreter duration`,
    ),
  };
}

function decodeLegacyCompilingBatches(value: unknown): number {
  const profiles = record(value, "interpreter reason profiles");
  return decodeInterpreterReasonProfile(
    profiles["compiling"],
    "compiling",
  ).batches;
}

/** Every chain attempt hits or misses for exactly one recorded reason. Schema 44 adds misses on
 * translations whose module is still compiling off the guest's thread; earlier schemas record
 * none. */
export function jitChainProfileReconciles(
  chain: Pick<
    CoreRuntimeProfile,
    | "jitChainAttempts"
    | "jitChainHits"
    | "jitChainMissingCoverage"
    | "jitChainMissingCache"
    | "jitChainMissingDispatchSlot"
    | "jitChainMissingEntry"
    | "jitChainInvalidCode"
    | "jitChainContextFailures"
    | "jitChainMissingCompilePending"
  >,
): boolean {
  return chain.jitChainAttempts ===
    chain.jitChainHits +
      chain.jitChainMissingCoverage +
      chain.jitChainMissingCache +
      chain.jitChainMissingDispatchSlot +
      chain.jitChainMissingEntry +
      chain.jitChainInvalidCode +
      chain.jitChainContextFailures +
      chain.jitChainMissingCompilePending;
}
