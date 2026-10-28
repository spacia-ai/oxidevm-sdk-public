import type { CoreJitReuseProfile } from "./core-jit-reuse.js";
import type { CodeSegmentContext } from "./code-segment-context.js";
import { exactKeys, integer, record, string } from "../decode.js";
import { CORE_API_VERSION, JIT_INTERPRET_REASONS, type CoreJitInterpretReason, type CoreJitModuleExit } from "../core-abi.js";
import {
  type SerializedError,
  decodeSerializedError,
  VMError,
} from "../errors.js";
import { JIT_CACHE_BYTES } from "../jit-cache.js";
import { PROTOCOL_VERSION } from "./common.js";
import {
  type CoreCpuState,
  type CoreProbeExit,
  type CoreProbeResult,
  decodeCoreExit,
  decodeCoreState,
  decodeCoreProbeResult,
} from "./core.js";
import {
  decodeBytes,
  finiteNonnegativeNumber,
  nonnegativeBigint,
} from "./decoders.js";
import type { CoreJitDeferralProfile } from "./core-jit-deferral.js";
import type { SystemBackgroundCompileProfile } from "./system-trace-background-compile.js";
import type { SystemJitFailureReason, SystemJitHealthProfile } from "./system-trace-jit-health.js";
import type { SystemJitCodeProfile } from "./system-trace-jit-code.js";
import type { CoreTranslationCoherenceProfile } from "./core-translation-coherence.js";
import type { JitModuleTraceMap } from "./system-trace-jit.js";
import type { JitLoopStats } from "./system-trace-jit-loops.js";
import type { JitAotTrainingStats } from "./system-trace-jit-aot.js";
import type { SystemAotStatus } from "./system-aot.js";
import type { SystemTraceNetworkProfile } from "./system-trace-network.js";
import type { SystemHostAttentionProfile } from "./system-attention.js";

export interface SystemTraceJitModule extends JitModuleTraceMap {
  readonly profileModuleId: string;
  readonly cacheKey: bigint;
  readonly aotTraining: JitAotTrainingStats;
}

export interface SystemTraceJitOperationSample {
  readonly span?: "ordinary" | "specialized";
  readonly profileModuleId: string;
  readonly instructionIndex: number;
  readonly sourceIndex: number;
  readonly operationKind: number;
  readonly samples: number;
}

export type SystemTraceJitEdgeKind =
  | "direct"
  | "conditional"
  | "call"
  | "indirect";

export interface SystemTraceJitEdgeSample {
  readonly sourceProfileModuleId: string;
  readonly targetProfileModuleId: string;
  readonly sourceCacheKey: bigint;
  readonly targetCacheKey: bigint;
  readonly sourceCompileGeneration: number;
  readonly targetCompileGeneration: number;
  readonly sourceDispatchSlot: number;
  readonly targetDispatchSlot: number;
  readonly sourceDispatchGeneration: number;
  readonly targetDispatchGeneration: number;
  readonly sourceInstructionIndex: number;
  readonly targetEntryIndex: number;
  readonly sourceTier: "tier1" | "tier2";
  readonly targetTier: "tier1" | "tier2";
  readonly sourceRip: bigint;
  readonly targetRip: bigint;
  readonly sourceSemantic: number;
  readonly targetSemantic: number;
  readonly kind: SystemTraceJitEdgeKind;
  readonly samples: number;
  readonly retired: bigint;
}

export interface SystemProbeResult extends CoreProbeResult {
  readonly console: Uint8Array;
}

export interface SystemRuntimeStats {
  readonly profile: "x86-64-v3";
  readonly jitState: "active" | "degraded";
  readonly retiredInstructions: bigint;
  readonly jitInstructions: bigint;
  readonly interpretedInstructions: bigint;
  readonly cacheHits: bigint;
  /** Installed modules and their compile latency, on the guest's thread or (since schema 44) in
   * the JIT compiler worker. */
  readonly moduleLoads: bigint;
  readonly compileSamples: number;
  readonly compileP95Milliseconds: number;
  readonly compileMaximumMilliseconds: number;
  readonly guardExits: bigint;
  readonly evictions: bigint;
  readonly cacheEntries: number;
  readonly cacheBytes: number;
  readonly cacheLimitBytes: number;
}

export interface SystemTraceInstruction {
  readonly rip: bigint;
  readonly semantic: number;
  readonly retired: number;
  readonly instructionForm: number | null;
}

export interface SystemTraceRipRange {
  readonly start: bigint;
  readonly end: bigint;
}

export interface SystemTraceRegisters {
  readonly rax: bigint;
  readonly rcx: bigint;
  readonly rdx: bigint;
  readonly rbx: bigint;
  readonly rsp: bigint;
  readonly rbp: bigint;
  readonly rsi: bigint;
  readonly rdi: bigint;
  readonly r8: bigint;
  readonly r9: bigint;
  readonly r10: bigint;
  readonly r11: bigint;
  readonly r12: bigint;
  readonly r13: bigint;
  readonly r14: bigint;
  readonly r15: bigint;
}

export interface SystemTraceCpu {
  readonly rip: bigint;
  readonly rflags: bigint;
  readonly cr3: bigint;
  readonly cpl: CoreCpuState["cpl"];
  readonly mode: CoreCpuState["mode"];
  readonly registers: SystemTraceRegisters | null;
}

export interface SystemTraceJitContext {
  readonly cr3: bigint;
  readonly forceExit: boolean;
  readonly entryIndex: number;
  readonly readEpoch: number;
  readonly writeEpoch: bigint;
  readonly lastDispatchSlot: number | null;
  readonly dispatchEpoch: bigint;
  readonly pendingWrites: bigint;
}

export interface CoreInstructionSiteProfile extends CodeSegmentContext {
  readonly rip: bigint;
  readonly physicalFrame: bigint;
  readonly generation: bigint;
  readonly firstAttempt: bigint;
  readonly lastAttempt: bigint;
  readonly samples: bigint;
  readonly committedSamples: bigint;
  readonly entryOffset: number;
  readonly codeAttributes: number;
  readonly capabilityRevision: 0 | 1;
  readonly semantic: number;
  readonly instructionId: number | null;
  readonly addressSpace: bigint | null;
  readonly identityAvailability: "measured" | "unavailable:legacy-record";
  readonly mode: 0 | 1 | 2 | 3;
  readonly cpl: 0 | 1 | 2 | 3;
  readonly profile: 0 | 1 | 2;
}

export interface CoreJitAdmissionSiteProfile extends CodeSegmentContext {
  readonly rip: bigint;
  readonly physicalFrame: bigint;
  readonly generation: bigint;
  readonly firstObservation: bigint;
  readonly lastObservation: bigint;
  readonly entryOffset: number;
  readonly visits: number;
  readonly requiredVisits: number;
  readonly codeAttributes: number;
  readonly capabilityRevision: 0 | 1;
  readonly mode: 0 | 1 | 2 | 3;
  readonly cpl: 0 | 1 | 2 | 3;
  readonly profile: 0 | 1 | 2;
  readonly blocked: boolean;
  readonly blockedReason: CoreJitBlockReason | null;
  readonly admitted: boolean;
  readonly cached: boolean;
}

export type CoreJitBlockReason =
  | "unsupported-semantic"
  | "quarantined-semantic"
  | "unsupported-cpu-context"
  | "translation-fault"
  | "decode-or-translation-fault"
  | "lowering-failure"
  | "emission-failure"
  | "candidate-limit"
  | "module-size-limit";

export interface CoreWorkloadProfile {
  readonly samplePeriod: number;
  readonly instructionAttempts: bigint;
  readonly instructionCommits: bigint;
  readonly siteSamples: bigint;
  readonly droppedSiteSamples: bigint;
  readonly unmappedAdmissionSites: bigint;
  readonly semanticAttempts: readonly bigint[];
  readonly semanticCommits: readonly bigint[];
  readonly sites: readonly CoreInstructionSiteProfile[];
  readonly admissionSites: readonly CoreJitAdmissionSiteProfile[];
  readonly cacheConflictCapacity: number;
  /** Profile-only deterministic pair-sampling period (record v12+, one for v11). */
  readonly cacheConflictSamplePeriod: number;
  /** Profile-only sampled collisions before bounded retention (record v12+). */
  readonly cacheConflictSamples: bigint;
  /** Profile-only sampled collisions omitted by bounded retention (record v11+). */
  readonly droppedCacheConflicts: bigint;
  /** Profile-only interval since the previous runtime-profile read (record v11+). */
  readonly cacheConflicts: readonly CoreCacheConflictProfile[];
}

export interface CoreCacheConflictProfile {
  readonly kind: "dispatch" | "read" | "write";
  readonly index: number | null;
  readonly incomingTag: bigint;
  readonly displacedTag: bigint | null;
  readonly addressSpace: bigint;
  readonly sampledConflicts: bigint;
  readonly alternations: bigint;
  readonly reuseDistance: CoreCacheConflictDistanceBuckets;
  readonly pairAvailability: "measured" | "unavailable:legacy-record";
}

export interface CoreCacheConflictDistanceBuckets {
  readonly "0-15": bigint;
  readonly "16-63": bigint;
  readonly "64-255": bigint;
  readonly "256-1023": bigint;
  readonly "1024+": bigint;
}

export interface CoreRuntimeProfile
  extends CoreTranslationCoherenceProfile, CoreJitDeferralProfile, CoreJitReuseProfile {
  readonly recordVersion:
    9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31;
  readonly enabled: boolean;
  readonly decodeCacheHits: bigint;
  readonly decodeCacheMisses: bigint;
  readonly decodeCacheEmpty: bigint;
  readonly decodeCacheTagMismatches: bigint;
  readonly decodeMappingFastHits: bigint;
  readonly decodeMappingRevalidations: bigint;
  readonly decodeMappingMismatches: bigint;
  readonly decodeMappingInvalidationChanges: bigint;
  readonly decodeMappingCr3Changes: bigint;
  readonly decodeMappingPolicyChanges: bigint;
  readonly decodeGenerationFastHits: bigint;
  readonly decodeGenerationChecks: bigint;
  readonly decodeGenerationMismatches: bigint;
  readonly decodedBytes: bigint;
  readonly tlbHits: bigint;
  readonly tlbMisses: bigint;
  readonly tlbProbeHits: bigint;
  readonly tlbProbeMisses: bigint;
  readonly tlbInvlpg: bigint;
  readonly tlbInvpcidIndividual: bigint;
  readonly tlbInvpcidSingleContext: bigint;
  readonly tlbInvpcidAllNonGlobal: bigint;
  readonly tlbInvpcidAll: bigint;
  readonly jitChainAttempts: bigint;
  readonly jitChainHits: bigint;
  readonly jitChainMissingCoverage: bigint;
  readonly jitChainMissingCache: bigint;
  readonly jitChainMissingDispatchSlot: bigint;
  readonly jitChainMissingEntry: bigint;
  readonly jitChainInvalidCode: bigint;
  readonly jitChainContextFailures: bigint;
  readonly jitCodeWritePages: bigint;
  readonly jitCodeWriteInvalidations: bigint;
  readonly jitCacheReplacements: bigint;
  readonly jitCacheCapacityEvictions: bigint;
  readonly jitDispatchSlotRebindings: bigint;
  readonly jitAdmissionChecks: bigint;
  readonly jitAdmissionRejections: bigint;
  readonly jitCandidatePrepareFailures: bigint;
  readonly jitCandidateBlocked: bigint;
  readonly jitCandidateEmitFailures: bigint;
  readonly jitCandidateCompiles: bigint;
  readonly jitCacheReuseHits: bigint;
  readonly jitCacheReusedTranslations: bigint;
  readonly jitCacheEightHitTranslations: bigint;
  readonly jitCacheThirtyTwoHitTranslations: bigint;
  readonly jitChainCoverageTargets: bigint;
  readonly jitChainCoverageEightMissTargets: bigint;
  readonly jitChainCoverageThirtyTwoMissTargets: bigint;
  readonly jitChainCoverageSixtyFourMissTargets: bigint;
  readonly jitChainCoverageAdmissionResets: bigint;
  readonly jitChainCoverageAdmissionResetTargets: bigint;
  readonly jitResidentTierLoopCalls: bigint;
  readonly jitBlockObservations: bigint;
  readonly jitColdBlockExecutions: bigint;
  readonly jitHotBlockTransitions: bigint;
  readonly jitHotBoundaryStops: bigint;
  readonly jitPartialBudgetFallbacks: bigint;
  readonly jitMemoryReads: bigint;
  readonly jitMemoryPreflightWrites: bigint;
  readonly jitMemoryStageWrites: bigint;
  readonly jitMemoryWrites: bigint;
  readonly jitMemoryDirectPreflightWrites: bigint;
  readonly jitReadCacheMissCrossPage: bigint;
  readonly jitReadCacheMissTag: bigint;
  readonly jitReadCacheMissEpoch: bigint;
  readonly jitReadCacheMissUnexplained: bigint;
  readonly jitReadCacheMissPendingWrites: bigint;
  readonly jitWriteCacheMissCrossPage: bigint;
  readonly jitWriteCacheMissTag: bigint;
  readonly jitWriteCacheMissEpoch: bigint;
  readonly jitWriteCacheMissPendingWrites: bigint;
  readonly jitWriteCacheMissUnexplained: bigint;
  readonly jitDispatchMissTag: bigint;
  readonly jitDispatchMissEpoch: bigint;
  readonly jitDispatchMissTargetSlot: bigint;
  readonly jitDispatchMissActiveSlot: bigint;
  readonly jitDispatchMissPendingWrites: bigint;
  readonly jitDispatchMissInterruptShadow: bigint;
  readonly jitDispatchMissAddressSpace: bigint;
  /** Legacy schema <= 28 counter; zero for record version 16 and later. */
  readonly jitDispatchMissCr3: bigint;
  readonly jitDispatchMissCpl: bigint;
  readonly jitDispatchMissUnexplained: bigint;
  readonly jitDispatchMissEmpty: bigint;
  readonly jitDispatchEpochInvalidations: bigint;
  readonly jitDispatchFullInvalidations: bigint;
  readonly jitDispatchPageInvalidations: bigint;
  readonly jitDispatchPageSlotsCleared: bigint;
  readonly jitRegionCandidates: bigint;
  readonly jitRegionDiscoveredPages: bigint;
  readonly jitRegionDiscoveredBlocks: bigint;
  readonly jitRegionDiscoveredInstructions: bigint;
  readonly jitRegionReadyPages: bigint;
  readonly jitRegionReadyBlocks: bigint;
  readonly jitRegionReadyInstructions: bigint;
  readonly jitRegionUncoveredPages: bigint;
  readonly jitRegionUncoveredBlocks: bigint;
  readonly jitRegionUncoveredInstructions: bigint;
  readonly jitRegionStopInstructionLimit: bigint;
  readonly jitRegionStopBlockLimit: bigint;
  readonly jitRegionStopPageLimit: bigint;
  readonly jitRegionStopDecodeOrLowering: bigint;
  readonly jitRegionStopSuccessorNotReady: bigint;
  readonly jitRegionStopAlreadyCovered: bigint;
  readonly jitRegionStopIndirectOrHostExit: bigint;
  readonly jitRegionStopArchitecturalEventBoundary: bigint;
  readonly jitAdmissionEvictedCold: bigint;
  readonly jitAdmissionEvictedHot: bigint;
  readonly jitAdmissionEvictedBlocked: bigint;
  readonly jitAdmissionArbitraryFallbacks: bigint;
  readonly jitAdmissionIdentityChanges: bigint;
  readonly jitAdmissionDroppedIdentityObservations: bigint;
  readonly jitReadCacheHits: bigint;
  readonly jitWriteCacheHits: bigint;
  readonly jitReadVictimHits: bigint;
  readonly jitWriteVictimHits: bigint;
  readonly jitRmwEligible: bigint;
  readonly jitRmwReadReuses: bigint;
  readonly jitRmwWriteReuses: bigint;
  readonly jitDispatchSlotClearEntriesScanned: bigint;
  readonly jitDispatchSlotClearEntriesCleared: bigint;
  readonly jitTailChainTransitions: bigint;
  readonly jitTier2Eligible: bigint;
  readonly jitTier2PromotionAttempts: bigint;
  readonly jitTier2Compiles: bigint;
  readonly jitTier2Failures: bigint;
  readonly jitTier2CompiledInstructions: bigint;
  readonly jitTier2ExecutionEntries: bigint;
  readonly jitTier2FailureMachineUnavailable: bigint;
  readonly jitTier2FailureWriteTracking: bigint;
  readonly jitTier2FailureUnsupportedCpuContext: bigint;
  readonly jitTier2FailureDecodeOrTranslationFault: bigint;
  readonly jitTier2FailureQuarantinedSemantic: bigint;
  readonly jitTier2FailureUnsupportedSemantic: bigint;
  readonly jitTier2FailureUnsupportedForm: bigint;
  readonly jitTier2FailureEmission: bigint;
  readonly jitTier2FailureModuleSizeLimit: bigint;
  readonly jitTier2FailureCandidateLimit: bigint;
  readonly jitTier2FailureStaleProfile: bigint;
  /** Legacy aggregate; current runtime records emit zero and use exact buckets. */
  readonly jitTier2FailureIneligibleTrace: bigint;
  readonly jitTier2FailureResidentBudget: bigint;
  readonly jitTier2FailureNoRegion: bigint;
  readonly jitTier2FailureNoEligibleEdges: bigint;
  readonly jitTier2FailureInsufficientInternalization: bigint;
  readonly jitTier2FailureNoRecurrentComponent: bigint;
  readonly jitTier1Retired: bigint;
  readonly jitTier2Retired: bigint;
  readonly jitTier1Ring0Retired: bigint;
  readonly jitTier1Ring3Retired: bigint;
  readonly jitTier2Ring0Retired: bigint;
  readonly jitTier2Ring3Retired: bigint;
  readonly jitResidentAdapterCompletions: bigint;
  readonly jitAdapterExitsReturned: bigint;
  readonly jitResidentTaskSwitches: bigint;
  readonly jitResidentZeroRetirementExhaustions: bigint;
  readonly jitResidentHostWaitExits: bigint;
  readonly jitDispatchRebindSameModuleCrossAddressSpace: bigint;
  readonly jitDispatchRebindDifferentModule: bigint;
  readonly jitDispatchRebindSameAddressSpace: bigint;
  readonly jitBindingInvalidationsUnregister: bigint;
  readonly jitBindingInvalidationsEviction: bigint;
  readonly jitBindingInvalidationsReplacement: bigint;
  readonly jitActiveBindings: bigint;
  readonly jitActiveArtifacts: bigint;
  readonly jitActiveAddressSpaces: bigint;
  readonly jitAliasBindings: bigint;
  readonly jitAliasReuses: bigint;
  readonly jitCacheBindingBytes: bigint;
  readonly jitCacheArtifactBytes: bigint;
  readonly jitCacheTotalBytes: bigint;
  readonly jitAotLookups: bigint;
  readonly jitAotMatches: bigint;
  readonly jitAotAmbiguous: bigint;
  readonly jitAotDeclines: bigint;
  readonly jitAotRegistrations: bigint;
  readonly jitAotRegistrationRejections: bigint;
  readonly jitAotDispatches: bigint;
  readonly jitAotRetired: bigint;
  readonly jitAotDynamicCompilesAvoided: bigint;
  readonly syscallCpuClones: bigint;
  readonly sysretCpuClones: bigint;
  readonly replacementCommitCpuClones: bigint;
  readonly jitTraceReadIneligible: bigint;
  readonly jitTraceWriteIneligible: bigint;
  readonly jitTraceInternalEdges: bigint;
  readonly jitTraceExternalEdges: bigint;
  readonly jitTraceCurrentStateOps: bigint;
  readonly jitTraceProposedStateOps: bigint;
  readonly jitTraceCurrentFlagOps: bigint;
  readonly jitTraceProposedFlagOps: bigint;
  readonly jitTraceCurrentMaterializations: bigint;
  readonly jitTraceProposedMaterializations: bigint;
  readonly jitTraceAddedGuards: bigint;
  readonly jitTraceRecordingWindows: bigint;
  readonly jitTraceRecordedEdges: bigint;
  readonly jitTraceAcceptedEdges: bigint;
  readonly jitTraceStaleEdges: bigint;
  readonly jitTraceDroppedEdges: bigint;
  readonly jitTraceRecordedRetired: bigint;
  readonly jitTraceSelectedRoots: bigint;
  readonly jitTraceReadSiteVisits: bigint;
  readonly jitTraceReadFirstVisits: bigint;
  readonly jitTraceReadReuses: bigint;
  readonly jitTraceReadPageChanges: bigint;
  readonly jitTraceReadRefreshes: bigint;
  readonly jitTraceReadUnsafe: bigint;
  readonly jitTraceWriteSiteVisits: bigint;
  readonly jitTraceWriteFirstVisits: bigint;
  readonly jitTraceWriteReuses: bigint;
  readonly jitTraceWritePageChanges: bigint;
  readonly jitTraceWriteRefreshes: bigint;
  readonly jitTraceWriteUnsafe: bigint;
  readonly workload: CoreWorkloadProfile;
}

export interface SystemJitDistanceBuckets {
  readonly "0-15": number;
  readonly "16-63": number;
  readonly "64-255": number;
  readonly "256-1023": number;
  readonly "1024+": number;
}

export interface SystemTraceSessionState {
  readonly active: boolean;
  readonly paused: boolean;
  readonly stopping: boolean;
  readonly awaitingConsoleAck: boolean;
  readonly waiting: "none" | "run" | "yield-idle" | "yield-task" | "paused" | "console-ack";
}

export interface SystemTraceProfile {
  readonly worker: {
    readonly core: CoreRuntimeProfile;
    readonly jitBatches: number;
    readonly jitInstructions: bigint;
    readonly jitChainTransitions: bigint;
    readonly jitMilliseconds: number;
    readonly jitCacheHits: bigint;
    readonly jitGuardExits: bigint;
    readonly interpreterBatches: number;
    readonly interpreterMilliseconds: number;
    readonly prepareCalls: number;
    readonly prepareSamples: number;
    readonly prepareSampleMilliseconds: number;
    readonly executionLoopCalls: number;
    readonly executionLoopMilliseconds: number;
    readonly taskYields: number;
    readonly taskYieldMilliseconds: number;
    readonly consoleAckWaits: number;
    readonly consoleAckWaitMilliseconds: number;
    readonly agentTurnWaits: number;
    readonly agentTurnWaitMilliseconds: number;
    /** Schema 35: the control worker's session pump state at capture time. */
    readonly session?: SystemTraceSessionState;
    readonly compileMilliseconds: number;
    readonly instantiateMilliseconds: number;
    readonly installMilliseconds: number;
    readonly synchronousCompiles: number;
    readonly dormantJitReactivations: number;
    readonly dormantJitReactivationBytes: number;
    readonly synchronousCompileP95Milliseconds: number;
    readonly synchronousCompileMaximumMilliseconds: number;
    readonly compileModules: number;
    readonly firstCompileModules: number;
    readonly recompiledModules: number;
    readonly compiledInstructions: bigint;
    readonly compileBytes: number;
    readonly maximumCandidateInstructions: number;
    readonly maximumCandidateBytes: number;
    readonly peakLiveModules: number;
    readonly moduleEvictions: number;
    readonly peakCacheBytes: number;
    readonly emittedIrOperations: number;
    readonly foldedIrOperations: number;
    readonly elidedIrOperations: number;
    readonly initialStateMask: bigint;
    readonly dirtyStateMask: bigint;
    readonly stateMaterializationBoundaries: number;
    readonly segmentGuards: number;
    readonly dispatchVictimAge: SystemJitDistanceBuckets;
    readonly dispatchSubsequentRecompiles: number;
    readonly dispatchRecompileReuseDistance: SystemJitDistanceBuckets;
    readonly dispatchEvictionTrackingDropped: number;
    readonly stickyJitFailure: SystemJitFailure | null;
    readonly evictionReasons: Readonly<
      Record<SystemJitEvictionReason, SystemJitEvictionReasonProfile>
    >;
    readonly interpreterReasons: Readonly<
      Record<SystemInterpreterReason, SystemInterpreterReasonProfile>
    >;
    /** Schema 36; zero for earlier evidence. */
    readonly interpretedActionReasons: Readonly<
      Record<SystemInterpretedActionReason, SystemInterpretedActionReasonProfile>
    >;
    /** Schema 44; immediate and empty for earlier evidence. */
    readonly backgroundCompile: SystemBackgroundCompileProfile;
    /** Schema 47: whether the JIT still compiles, and why not; active for earlier evidence. */
    readonly jitHealth: SystemJitHealthProfile;
    /** Schema 48: estimated executable memory of compiled translations and the code budget;
     * empty for earlier evidence. */
    readonly jitCode: SystemJitCodeProfile;
    /** Schema 54: slices ended early to serve host work; empty for earlier evidence. */
    readonly hostAttention: SystemHostAttentionProfile;
  };
  readonly disk: {
    readonly enabled: boolean;
    readonly requests: number;
    readonly failures: number;
    readonly reads: number;
    readonly readBytes: number;
    readonly writes: number;
    readonly writtenBytes: number;
    readonly zeroes: number;
    readonly zeroedBytes: number;
    readonly discards: number;
    readonly discardedBytes: number;
    readonly flushes: number;
    readonly waitMilliseconds: number;
    readonly maximumWaitMilliseconds: number;
    readonly maximumQueueDepth?: number;
    readonly busyReturns?: number;
    readonly maximumInFlight?: number;
    readonly delayedFailures?: number;
    readonly backendFailures?: number;
    readonly protocolFailures?: number;
    readonly timeoutFailures?: number;
    readonly quotaFailures?: number;
    readonly stickyFailure?: {
      readonly sequence: number;
      readonly reason: "backend" | "protocol" | "timeout" | "quota";
      readonly operation?: "read" | "write" | "zero" | "flush";
      readonly offset?: number;
      readonly length?: number;
    };
  };
  readonly agent: {
    readonly requests: number;
    readonly spawnedProcesses: number;
    readonly stdinBytes: number;
    readonly stdoutBytes: number;
    readonly stderrBytes: number;
  };
  /** Schema 43: the full-system network link on a live read; null for checkpoints and frozen
   * captures, absent before schema 43. */
  readonly network?: SystemTraceNetworkProfile | null;
}

/** Why the worker ran the interpreter. `code-budget` (schema 48): the code budget refused the
 * site's compile (`SystemJitCodeProfile.refusals` says why). */
export type SystemInterpreterReason =
  | "admission"
  | "code-budget"
  | "degraded"
  | "guard"
  | "quarantine";

export const SYSTEM_INTERPRETER_REASONS = [
  "admission",
  "code-budget",
  "degraded",
  "guard",
  "quarantine",
] as const satisfies readonly SystemInterpreterReason[];

/** The interpreter reasons of schemas 21–47. */
export const LEGACY_SYSTEM_INTERPRETER_REASONS = [
  "admission",
  "degraded",
  "guard",
  "quarantine",
] as const satisfies readonly SystemInterpreterReason[];

export interface SystemInterpreterReasonProfile {
  readonly batches: number;
  readonly instructions: bigint;
  readonly milliseconds: number;
}

/** Schema 36: the core's own reason for every interpreted action, so an
 * "admission" batch is attributed to halted, partial-budget, missing code
 * identity or cold admission rather than one bucket. Schema 44 adds
 * compile-pending: the site's module is compiling off the guest's thread.
 * Schema 49 adds code-page-fault: reached code needs interpreter fault admission.
 * Mirrors `CoreJitInterpretReason` in declaration order. */
export type SystemInterpretedActionReason = CoreJitInterpretReason;

export const SYSTEM_INTERPRETED_ACTION_REASONS = JIT_INTERPRET_REASONS.map(([, reason]) => reason);

export interface SystemInterpretedActionReasonProfile {
  readonly batches: number;
  readonly instructions: bigint;
}

/** Why a live block left the store. `code-budget` (schema 48): live translations' estimated
 * machine code would pass the engine family's code budget. */
export type SystemJitEvictionReason =
  | "byte-capacity"
  | "code-budget"
  | "dispatch-slot"
  | "duplicate-install"
  | "stale-registration"
  | "trace-reconfiguration";

export const SYSTEM_JIT_EVICTION_REASONS = [
  "byte-capacity",
  "code-budget",
  "dispatch-slot",
  "duplicate-install",
  "stale-registration",
  "trace-reconfiguration",
] as const satisfies readonly SystemJitEvictionReason[];

/** The eviction reasons of schemas 10–47. */
export const LEGACY_SYSTEM_JIT_EVICTION_REASONS = [
  "byte-capacity",
  "dispatch-slot",
  "duplicate-install",
  "stale-registration",
  "trace-reconfiguration",
] as const satisfies readonly SystemJitEvictionReason[];

export interface SystemJitEvictionReasonProfile {
  readonly modules: number;
  readonly bytes: number;
}

/** The first JIT failure of a runtime generation; `code-memory` from schema 47. */
export interface SystemJitFailure {
  readonly generation: number;
  readonly cacheKey: bigint;
  readonly reason: SystemJitFailureReason;
}

/** Where a translated block's code came from: its own module, a member of a linked batch of
 * Tier-1 modules (schema 45), or a member of an AOT pack. */
export type SystemTraceJitArtifact =
  | { readonly kind: "dynamic" }
  | {
      readonly kind: "linked";
      /** The batch's number in its JIT runtime, from 1. */
      readonly batch: number;
      readonly memberIndex: number;
      readonly members: number;
    }
  | {
      readonly kind: "aot";
      readonly packSha256: string;
      readonly memberIndex: number;
      readonly memberEntryOffset: bigint;
      readonly imageBase: bigint;
      readonly codePages: readonly {
        readonly linear: bigint;
        readonly physical: bigint;
        readonly generation: bigint;
        readonly globalSupervisor: boolean;
      }[];
    };

export type SystemTraceEvent =
  | {
      readonly kind: "compile";
      readonly sequence: number;
      readonly workerTimestamp: number;
      readonly startRip: bigint;
      readonly cacheKey: bigint;
      readonly dispatchSlot: number;
      readonly moduleBytes: number;
      readonly compileMilliseconds: number;
      readonly instructions: readonly SystemTraceInstruction[];
    }
  | {
      readonly kind: "jit";
      readonly sequence: number;
      readonly workerTimestamp: number;
      readonly before: SystemTraceCpu;
      readonly after: SystemTraceCpu;
      readonly cacheKey: bigint;
      readonly cacheHit: boolean;
      readonly dispatchSlot: number;
      readonly lastDispatchSlot: number | null;
      readonly budget: number;
      readonly steps: bigint;
      readonly durationMilliseconds: number;
      readonly exit: CoreJitModuleExit;
      readonly instructions: readonly SystemTraceInstruction[];
      readonly contextBefore: SystemTraceJitContext;
      readonly contextBoundary: SystemTraceJitContext;
      readonly contextAfter: SystemTraceJitContext;
      readonly artifact?: SystemTraceJitArtifact;
    }
  | {
      readonly kind: "interpreter";
      readonly sequence: number;
      readonly workerTimestamp: number;
      readonly before: SystemTraceCpu;
      readonly after: SystemTraceCpu;
      readonly budget: number;
      readonly steps: bigint;
      readonly durationMilliseconds: number;
      readonly reason: SystemInterpreterReason | "compiling";
      readonly exit: CoreProbeExit["kind"];
    };

export interface SystemTraceSnapshot {
  readonly schemaVersion:
    | 2
    | 3
    | 4
    | 5
    | 6
    | 7
    | 8
    | 9
    | 10
    | 11
    | 12
    | 13
    | 14
    | 15
    | 16
    | 17
    | 18
    | 19
    | 20
    | 21
    | 22
    | 23
    | 24
    | 25
    | 26
    | 27
    | 28
    | 29
    | 30
    | 31
    | 32
    | 33
    | 34
    | 35
    | 36
    | 37
    | 38
    | 39
    | 40
    | 41
    | 42
    | 43
    | 44
    | 45
    | 46
    | 47
    | 48
    | 49
    | 50
    | 51
    | 52
    | 53
    | 54;
  readonly executionMode:
    | "unknown"
    | "tiered"
    | "interpreter-only"
    | "semantic-quarantine";
  readonly interpretedSemantics: readonly number[];
  readonly interpretedRipRanges: readonly SystemTraceRipRange[];
  readonly applicationSampleRate: number;
  readonly runtimeKey: string;
  readonly capturedAt: number;
  readonly trigger:
    | "guest-process-exit"
    | "guest-process-protocol"
    | "guest-stderr"
    | null;
  readonly checkpointPolicy?: "faults-and-stderr" | "faults-only";
  readonly capacity: number;
  readonly dropped: number;
  readonly runtime: SystemRuntimeStats;
  readonly profile: SystemTraceProfile;
  readonly state: SystemTraceCpu;
  readonly consoleTail: string;
  readonly events: readonly SystemTraceEvent[];
  readonly jitModules?: readonly SystemTraceJitModule[];
  /** Archived JIT-54 counters; null when the runtime has no loop specialization. */
  readonly jitLoopStats?: JitLoopStats | null;
  readonly droppedJitModules?: number;
  readonly collidingJitModules?: number;
  readonly jitOperationSamples?: readonly SystemTraceJitOperationSample[];
  readonly jitOperationSampleTotal?: number;
  readonly droppedJitOperationSamples?: number;
  readonly jitOperationSamplePeriod?: number;
  readonly jitEdgeSamples?: readonly SystemTraceJitEdgeSample[];
  readonly jitEdgeSampleTotal?: number;
  readonly droppedJitEdgeSamples?: number;
  readonly jitEdgeSamplePeriod?: number;
  readonly aot?: SystemAotStatus;
}

export interface SystemSliceResult {
  readonly apiVersion: typeof CORE_API_VERSION;
  readonly exit: CoreProbeExit;
  readonly state: CoreCpuState;
  readonly cpus: readonly CoreCpuState[];
  readonly console: Uint8Array;
  readonly runtime: SystemRuntimeStats;
}

export type SystemExecutionEvent =
  | {
      readonly kind: "console";
      readonly data: Uint8Array;
    }
  | {
      readonly kind: "telemetry";
      readonly runtime: SystemRuntimeStats;
      readonly workerTimestamp: number;
    };

export type SystemExecutionWireEvent =
  | {
      readonly version: typeof PROTOCOL_VERSION;
      readonly sessionId: number;
      readonly sequence: number;
      readonly type: "console";
      readonly data: Uint8Array;
    }
  | {
      readonly version: typeof PROTOCOL_VERSION;
      readonly sessionId: number;
      readonly sequence: number;
      readonly type: "telemetry";
      readonly runtime: SystemRuntimeStats;
      readonly workerTimestamp: number;
    }
  | {
      readonly version: typeof PROTOCOL_VERSION;
      readonly sessionId: number;
      readonly sequence: number;
      readonly type: "exit";
      readonly exit: CoreProbeExit;
    }
  | {
      readonly version: typeof PROTOCOL_VERSION;
      readonly sessionId: number;
      readonly sequence: number;
      readonly type: "error";
      readonly error: SerializedError;
    };

export interface SystemExecutionPortAck {
  readonly version: typeof PROTOCOL_VERSION;
  readonly sessionId: number;
  readonly type: "console-ack";
  readonly sequence: number;
}
export function decodeSystemProbeResult(value: unknown): SystemProbeResult {
  const result = record(value, "system probe result");
  exactKeys(result, ["apiVersion", "exit", "state", "console"]);
  const core = decodeCoreProbeResult({
    apiVersion: result["apiVersion"],
    exit: result["exit"],
    state: result["state"],
  });
  return { ...core, console: decodeBytes(result["console"]) };
}

export function decodeSystemSliceResult(value: unknown): SystemSliceResult {
  const result = record(value, "system slice result");
  exactKeys(result, ["apiVersion", "exit", "state", "cpus", "console", "runtime"]);
  if (integer(result["apiVersion"], "apiVersion", CORE_API_VERSION, CORE_API_VERSION) !== CORE_API_VERSION) {
    throw new VMError("PROTOCOL_ERROR", "unsupported core API version");
  }
  if (!Array.isArray(result["cpus"]) || result["cpus"].length < 1 || result["cpus"].length > 4) {
    throw new VMError("PROTOCOL_ERROR", "system CPU state array is invalid");
  }
  const cpus = result["cpus"].map((state) => decodeCoreState(state));
  const state = decodeCoreState(result["state"]);
  return {
    apiVersion: CORE_API_VERSION,
    exit: decodeCoreExit(result["exit"]),
    state,
    cpus,
    console: decodeBytes(result["console"]),
    runtime: decodeSystemRuntimeStats(result["runtime"]),
  };
}

export function decodeSystemExecutionWireEvent(
  value: unknown,
): SystemExecutionWireEvent {
  const event = record(value, "system execution event");
  const type = string(event["type"], "system execution event type");
  const base = decodeSystemExecutionEventBase(event);
  switch (type) {
    case "console":
      exactKeys(event, [
        "version",
        "sessionId",
        "sequence",
        "type",
        "data",
      ]);
      return { ...base, type, data: decodeBytes(event["data"]) };
    case "telemetry":
      exactKeys(event, [
        "version",
        "sessionId",
        "sequence",
        "type",
        "runtime",
        "workerTimestamp",
      ]);
      return {
        ...base,
        type,
        runtime: decodeSystemRuntimeStats(event["runtime"]),
        workerTimestamp: finiteNonnegativeNumber(
          event["workerTimestamp"],
          "worker timestamp",
        ),
      };
    case "exit":
      exactKeys(event, [
        "version",
        "sessionId",
        "sequence",
        "type",
        "exit",
      ]);
      return { ...base, type, exit: decodeCoreExit(event["exit"]) };
    case "error":
      exactKeys(event, [
        "version",
        "sessionId",
        "sequence",
        "type",
        "error",
      ]);
      return {
        ...base,
        type,
        error: decodeSerializedError(event["error"]),
      };
    default:
      throw new VMError(
        "PROTOCOL_ERROR",
        `unknown system execution event ${type}`,
      );
  }
}

export function decodeSystemExecutionPortAck(
  value: unknown,
): SystemExecutionPortAck {
  const ack = record(value, "system execution acknowledgement");
  exactKeys(ack, ["version", "sessionId", "type", "sequence"]);
  if (
    integer(
      ack["version"],
      "protocol version",
      PROTOCOL_VERSION,
      PROTOCOL_VERSION,
    ) !== PROTOCOL_VERSION
  ) {
    throw new VMError("PROTOCOL_ERROR", "protocol version mismatch");
  }
  if (string(ack["type"], "acknowledgement type") !== "console-ack") {
    throw new VMError(
      "PROTOCOL_ERROR",
      "system execution acknowledgement type is invalid",
    );
  }
  return {
    version: PROTOCOL_VERSION,
    sessionId: integer(ack["sessionId"], "session id", 1),
    type: "console-ack",
    sequence: integer(ack["sequence"], "event sequence", 1),
  };
}

function decodeSystemExecutionEventBase(
  event: Readonly<Record<string, unknown>>,
): {
  readonly version: typeof PROTOCOL_VERSION;
  readonly sessionId: number;
  readonly sequence: number;
} {
  if (
    integer(
      event["version"],
      "protocol version",
      PROTOCOL_VERSION,
      PROTOCOL_VERSION,
    ) !== PROTOCOL_VERSION
  ) {
    throw new VMError("PROTOCOL_ERROR", "protocol version mismatch");
  }
  return {
    version: PROTOCOL_VERSION,
    sessionId: integer(event["sessionId"], "session id", 1),
    sequence: integer(event["sequence"], "event sequence", 1),
  };
}

export function decodeSystemRuntimeStats(value: unknown): SystemRuntimeStats {
  const stats = record(value, "system runtime stats");
  exactKeys(stats, [
    "profile",
    "jitState",
    "retiredInstructions",
    "jitInstructions",
    "interpretedInstructions",
    "cacheHits",
    "moduleLoads",
    "compileSamples",
    "compileP95Milliseconds",
    "compileMaximumMilliseconds",
    "guardExits",
    "evictions",
    "cacheEntries",
    "cacheBytes",
    "cacheLimitBytes",
  ]);
  const profile = string(stats["profile"], "system CPU profile");
  if (profile !== "x86-64-v3") {
    throw new VMError("PROTOCOL_ERROR", "system CPU profile is invalid");
  }
  const jitState = string(stats["jitState"], "system JIT state");
  if (jitState !== "active" && jitState !== "degraded") {
    throw new VMError("PROTOCOL_ERROR", "system JIT state is invalid");
  }
  const retiredInstructions = nonnegativeBigint(
    stats["retiredInstructions"],
    "retired instructions",
  );
  const jitInstructions = nonnegativeBigint(
    stats["jitInstructions"],
    "JIT instructions",
  );
  const interpretedInstructions = nonnegativeBigint(
    stats["interpretedInstructions"],
    "interpreted instructions",
  );
  if (retiredInstructions !== jitInstructions + interpretedInstructions) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "retired instruction counters do not agree",
    );
  }
  const moduleLoads = nonnegativeBigint(
    stats["moduleLoads"],
    "JIT module loads",
  );
  const compileSamples = integer(
    stats["compileSamples"],
    "JIT compile samples",
    0,
  );
  const compileP95Milliseconds = integer(
    stats["compileP95Milliseconds"],
    "JIT compile p95",
    0,
  );
  const compileMaximumMilliseconds = integer(
    stats["compileMaximumMilliseconds"],
    "JIT compile maximum",
    0,
  );
  if (
    BigInt(compileSamples) !== moduleLoads ||
    compileP95Milliseconds > compileMaximumMilliseconds ||
    (compileSamples === 0 && compileMaximumMilliseconds !== 0)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "JIT compile latency counters do not agree",
    );
  }
  const cacheLimitBytes = integer(
    stats["cacheLimitBytes"],
    "JIT cache limit",
    1,
    JIT_CACHE_BYTES,
  );
  return {
    profile,
    jitState,
    retiredInstructions,
    jitInstructions,
    interpretedInstructions,
    cacheHits: nonnegativeBigint(stats["cacheHits"], "JIT cache hits"),
    moduleLoads,
    compileSamples,
    compileP95Milliseconds,
    compileMaximumMilliseconds,
    guardExits: nonnegativeBigint(stats["guardExits"], "JIT guard exits"),
    evictions: nonnegativeBigint(stats["evictions"], "JIT evictions"),
    cacheEntries: integer(stats["cacheEntries"], "JIT cache entries", 0),
    cacheBytes: integer(
      stats["cacheBytes"],
      "JIT cache bytes",
      0,
      cacheLimitBytes,
    ),
    cacheLimitBytes,
  };
}
