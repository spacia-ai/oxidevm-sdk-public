import { CORE_JIT_REUSE_KEYS, decodeJitReuse, EMPTY_CORE_JIT_REUSE } from "./core-jit-reuse.js";
import { coreRecordVersionForTrace } from "./core-profile-versions.js";
export { coreRecordVersionForTrace, coreTraceVersionForRecord } from "./core-profile-versions.js";
import { boolean, exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";
import { nonnegativeBigint } from "./decoders.js";
import {
  CORE_JIT_DEFERRAL_KEYS,
  decodeJitDeferral,
  EMPTY_CORE_JIT_DEFERRAL,
} from "./core-jit-deferral.js";
import {
  CORE_TRANSLATION_COHERENCE_KEYS,
  CORE_TRANSLATION_COHERENCE_KEYS_V41,
  CORE_TRANSLATION_COHERENCE_KEYS_V44,
  CORE_TRANSLATION_COHERENCE_KEYS_V52,
  decodeTranslationCoherence,
  EMPTY_CORE_TRANSLATION_COHERENCE,
} from "./core-translation-coherence.js";
import type { CoreRuntimeProfile, SystemTraceSnapshot } from "./system.js";
import {
  decodeCoreWorkloadProfile,
  emptyCoreWorkloadProfile,
} from "./system-trace-workload.js";

const CORE_PROFILE_KEYS_V23 = [
  "jitRegionCandidates",
  "jitRegionDiscoveredPages",
  "jitRegionDiscoveredBlocks",
  "jitRegionDiscoveredInstructions",
  "jitRegionReadyPages",
  "jitRegionReadyBlocks",
  "jitRegionReadyInstructions",
  "jitRegionUncoveredPages",
  "jitRegionUncoveredBlocks",
  "jitRegionUncoveredInstructions",
  "jitRegionStopInstructionLimit",
  "jitRegionStopBlockLimit",
  "jitRegionStopPageLimit",
  "jitRegionStopDecodeOrLowering",
  "jitRegionStopSuccessorNotReady",
  "jitRegionStopAlreadyCovered",
  "jitRegionStopIndirectOrHostExit",
  "jitAdmissionEvictedCold",
  "jitAdmissionEvictedHot",
  "jitAdmissionEvictedBlocked",
  "jitAdmissionArbitraryFallbacks",
  "jitAdmissionIdentityChanges",
  "jitAdmissionDroppedIdentityObservations",
] as const;
const CORE_PROFILE_KEYS_V24 = [
  "jitReadCacheHits",
  "jitWriteCacheHits",
  "jitDispatchSlotClearEntriesScanned",
  "jitDispatchSlotClearEntriesCleared",
] as const;
const CORE_PROFILE_KEYS_V25 = ["jitReadVictimHits", "jitWriteVictimHits"] as const;
const CORE_PROFILE_KEYS_V26 = ["jitRmwEligible", "jitRmwReadReuses", "jitRmwWriteReuses"] as const;
const CORE_PROFILE_KEYS_V28 = [
  "jitTailChainTransitions",
  "jitTier2Eligible",
  "jitTier2PromotionAttempts",
  "jitTier2Compiles",
  "jitTier2Failures",
  "jitTier2CompiledInstructions",
  "jitTier2ExecutionEntries",
] as const;
const CORE_PROFILE_KEYS_V29 = [
  "jitTier2FailureMachineUnavailable",
  "jitTier2FailureWriteTracking",
  "jitTier2FailureUnsupportedCpuContext",
  "jitTier2FailureDecodeOrTranslationFault",
  "jitTier2FailureQuarantinedSemantic",
  "jitTier2FailureUnsupportedSemantic",
  "jitTier2FailureUnsupportedForm",
  "jitTier2FailureEmission",
  "jitTier2FailureModuleSizeLimit",
  "jitTier2FailureCandidateLimit",
  "jitTier2FailureStaleProfile",
  "jitTier2FailureIneligibleTrace",
  "jitTier2FailureResidentBudget",
  "jitTier2FailureNoRegion",
  "jitTier2FailureNoEligibleEdges",
  "jitTier2FailureInsufficientInternalization",
  "jitTier2FailureNoRecurrentComponent",
  "jitTier1Retired",
  "jitTier2Retired",
  "jitTier1Ring0Retired",
  "jitTier1Ring3Retired",
  "jitTier2Ring0Retired",
  "jitTier2Ring3Retired",
  "jitTraceReadIneligible",
  "jitTraceWriteIneligible",
  "jitTraceInternalEdges",
  "jitTraceExternalEdges",
  "jitTraceCurrentStateOps",
  "jitTraceProposedStateOps",
  "jitTraceCurrentFlagOps",
  "jitTraceProposedFlagOps",
  "jitTraceCurrentMaterializations",
  "jitTraceProposedMaterializations",
  "jitTraceAddedGuards",
  "jitTraceRecordingWindows",
  "jitTraceRecordedEdges",
  "jitTraceAcceptedEdges",
  "jitTraceStaleEdges",
  "jitTraceDroppedEdges",
  "jitTraceRecordedRetired",
  "jitTraceSelectedRoots",
  "jitTraceReadSiteVisits",
  "jitTraceReadFirstVisits",
  "jitTraceReadReuses",
  "jitTraceReadPageChanges",
  "jitTraceReadRefreshes",
  "jitTraceReadUnsafe",
  "jitTraceWriteSiteVisits",
  "jitTraceWriteFirstVisits",
  "jitTraceWriteReuses",
  "jitTraceWritePageChanges",
  "jitTraceWriteRefreshes",
  "jitTraceWriteUnsafe",
] as const;
const CORE_PROFILE_KEYS_V31 = [
  "jitResidentAdapterCompletions",
  "jitAdapterExitsReturned",
  "jitResidentTaskSwitches",
  "jitResidentZeroRetirementExhaustions",
  "jitResidentHostWaitExits",
  "jitDispatchRebindSameModuleCrossAddressSpace",
  "jitDispatchRebindDifferentModule",
  "jitDispatchRebindSameAddressSpace",
  "jitBindingInvalidationsUnregister",
  "jitBindingInvalidationsEviction",
  "jitBindingInvalidationsReplacement",
  "jitActiveBindings",
  "jitActiveArtifacts",
  "jitActiveAddressSpaces",
  "jitAliasBindings",
  "jitAliasReuses",
] as const;
const CORE_PROFILE_KEYS_V32 = [
  "jitCacheBindingBytes",
  "jitCacheArtifactBytes",
  "jitCacheTotalBytes",
] as const;
const CORE_PROFILE_KEYS_V33 = [
  "jitAotLookups",
  "jitAotMatches",
  "jitAotAmbiguous",
  "jitAotDeclines",
  "jitAotRegistrations",
  "jitAotRegistrationRejections",
  "jitAotDispatches",
  "jitAotRetired",
  "jitAotDynamicCompilesAvoided",
] as const;
const CORE_PROFILE_KEYS_V37 = ["syscallCpuClones", "sysretCpuClones", "replacementCommitCpuClones"] as const;
const CORE_PROFILE_KEYS_V43 = ["jitRegionStopArchitecturalEventBoundary"] as const;
const CORE_PROFILE_KEYS_V49 = ["jitReadCacheMissPendingWrites"] as const;
export const EMPTY_CORE_RUNTIME_PROFILE: CoreRuntimeProfile = {
  ...EMPTY_CORE_TRANSLATION_COHERENCE,
  ...EMPTY_CORE_JIT_DEFERRAL,
  ...EMPTY_CORE_JIT_REUSE,
  recordVersion: 30,
  enabled: false,
  decodeCacheHits: 0n,
  decodeCacheMisses: 0n,
  decodeCacheEmpty: 0n,
  decodeCacheTagMismatches: 0n,
  decodeMappingFastHits: 0n,
  decodeMappingRevalidations: 0n,
  decodeMappingMismatches: 0n,
  decodeMappingInvalidationChanges: 0n,
  decodeMappingCr3Changes: 0n,
  decodeMappingPolicyChanges: 0n,
  decodeGenerationFastHits: 0n,
  decodeGenerationChecks: 0n,
  decodeGenerationMismatches: 0n,
  decodedBytes: 0n,
  tlbHits: 0n,
  tlbMisses: 0n,
  tlbProbeHits: 0n,
  tlbProbeMisses: 0n,
  tlbInvlpg: 0n,
  tlbInvpcidIndividual: 0n,
  tlbInvpcidSingleContext: 0n,
  tlbInvpcidAllNonGlobal: 0n,
  tlbInvpcidAll: 0n,
  jitChainAttempts: 0n,
  jitChainHits: 0n,
  jitChainMissingCoverage: 0n,
  jitChainMissingCache: 0n,
  jitChainMissingDispatchSlot: 0n,
  jitChainMissingEntry: 0n,
  jitChainInvalidCode: 0n,
  jitChainContextFailures: 0n,
  jitCodeWritePages: 0n,
  jitCodeWriteInvalidations: 0n,
  jitCacheReplacements: 0n,
  jitCacheCapacityEvictions: 0n,
  jitDispatchSlotRebindings: 0n,
  jitAdmissionChecks: 0n,
  jitAdmissionRejections: 0n,
  jitCandidatePrepareFailures: 0n,
  jitCandidateBlocked: 0n,
  jitCandidateEmitFailures: 0n,
  jitCandidateCompiles: 0n,
  jitCacheReuseHits: 0n,
  jitCacheReusedTranslations: 0n,
  jitCacheEightHitTranslations: 0n,
  jitCacheThirtyTwoHitTranslations: 0n,
  jitChainCoverageTargets: 0n,
  jitChainCoverageEightMissTargets: 0n,
  jitChainCoverageThirtyTwoMissTargets: 0n,
  jitChainCoverageSixtyFourMissTargets: 0n,
  jitChainCoverageAdmissionResets: 0n,
  jitChainCoverageAdmissionResetTargets: 0n,
  jitResidentTierLoopCalls: 0n,
  jitBlockObservations: 0n,
  jitColdBlockExecutions: 0n,
  jitHotBlockTransitions: 0n,
  jitHotBoundaryStops: 0n,
  jitPartialBudgetFallbacks: 0n,
  jitMemoryReads: 0n,
  jitMemoryPreflightWrites: 0n,
  jitMemoryStageWrites: 0n,
  jitMemoryWrites: 0n,
  jitMemoryDirectPreflightWrites: 0n,
  jitReadCacheMissCrossPage: 0n,
  jitReadCacheMissTag: 0n,
  jitReadCacheMissEpoch: 0n,
  jitReadCacheMissUnexplained: 0n,
  jitReadCacheMissPendingWrites: 0n,
  jitWriteCacheMissCrossPage: 0n,
  jitWriteCacheMissTag: 0n,
  jitWriteCacheMissEpoch: 0n,
  jitWriteCacheMissPendingWrites: 0n,
  jitWriteCacheMissUnexplained: 0n,
  jitDispatchMissTag: 0n,
  jitDispatchMissEpoch: 0n,
  jitDispatchMissTargetSlot: 0n,
  jitDispatchMissActiveSlot: 0n,
  jitDispatchMissPendingWrites: 0n,
  jitDispatchMissInterruptShadow: 0n,
  jitDispatchMissAddressSpace: 0n,
  jitDispatchMissCr3: 0n,
  jitDispatchMissCpl: 0n,
  jitDispatchMissUnexplained: 0n,
  jitDispatchMissEmpty: 0n,
  jitDispatchEpochInvalidations: 0n,
  jitDispatchFullInvalidations: 0n,
  jitDispatchPageInvalidations: 0n,
  jitDispatchPageSlotsCleared: 0n,
  jitRegionCandidates: 0n,
  jitRegionDiscoveredPages: 0n,
  jitRegionDiscoveredBlocks: 0n,
  jitRegionDiscoveredInstructions: 0n,
  jitRegionReadyPages: 0n,
  jitRegionReadyBlocks: 0n,
  jitRegionReadyInstructions: 0n,
  jitRegionUncoveredPages: 0n,
  jitRegionUncoveredBlocks: 0n,
  jitRegionUncoveredInstructions: 0n,
  jitRegionStopInstructionLimit: 0n,
  jitRegionStopBlockLimit: 0n,
  jitRegionStopPageLimit: 0n,
  jitRegionStopDecodeOrLowering: 0n,
  jitRegionStopSuccessorNotReady: 0n,
  jitRegionStopAlreadyCovered: 0n,
  jitRegionStopIndirectOrHostExit: 0n,
  jitRegionStopArchitecturalEventBoundary: 0n,
  jitAdmissionEvictedCold: 0n,
  jitAdmissionEvictedHot: 0n,
  jitAdmissionEvictedBlocked: 0n,
  jitAdmissionArbitraryFallbacks: 0n,
  jitAdmissionIdentityChanges: 0n,
  jitAdmissionDroppedIdentityObservations: 0n,
  jitReadCacheHits: 0n,
  jitWriteCacheHits: 0n,
  jitReadVictimHits: 0n,
  jitWriteVictimHits: 0n,
  jitRmwEligible: 0n,
  jitRmwReadReuses: 0n,
  jitRmwWriteReuses: 0n,
  jitDispatchSlotClearEntriesScanned: 0n,
  jitDispatchSlotClearEntriesCleared: 0n,
  jitTailChainTransitions: 0n,
  jitTier2Eligible: 0n,
  jitTier2PromotionAttempts: 0n,
  jitTier2Compiles: 0n,
  jitTier2Failures: 0n,
  jitTier2CompiledInstructions: 0n,
  jitTier2ExecutionEntries: 0n,
  jitTier2FailureMachineUnavailable: 0n,
  jitTier2FailureWriteTracking: 0n,
  jitTier2FailureUnsupportedCpuContext: 0n,
  jitTier2FailureDecodeOrTranslationFault: 0n,
  jitTier2FailureQuarantinedSemantic: 0n,
  jitTier2FailureUnsupportedSemantic: 0n,
  jitTier2FailureUnsupportedForm: 0n,
  jitTier2FailureEmission: 0n,
  jitTier2FailureModuleSizeLimit: 0n,
  jitTier2FailureCandidateLimit: 0n,
  jitTier2FailureStaleProfile: 0n,
  jitTier2FailureIneligibleTrace: 0n,
  jitTier2FailureResidentBudget: 0n,
  jitTier2FailureNoRegion: 0n,
  jitTier2FailureNoEligibleEdges: 0n,
  jitTier2FailureInsufficientInternalization: 0n,
  jitTier2FailureNoRecurrentComponent: 0n,
  jitTier1Retired: 0n,
  jitTier2Retired: 0n,
  jitTier1Ring0Retired: 0n,
  jitTier1Ring3Retired: 0n,
  jitTier2Ring0Retired: 0n,
  jitTier2Ring3Retired: 0n,
  jitResidentAdapterCompletions: 0n,
  jitAdapterExitsReturned: 0n,
  jitResidentTaskSwitches: 0n,
  jitResidentZeroRetirementExhaustions: 0n,
  jitResidentHostWaitExits: 0n,
  jitDispatchRebindSameModuleCrossAddressSpace: 0n,
  jitDispatchRebindDifferentModule: 0n,
  jitDispatchRebindSameAddressSpace: 0n,
  jitBindingInvalidationsUnregister: 0n,
  jitBindingInvalidationsEviction: 0n,
  jitBindingInvalidationsReplacement: 0n,
  jitActiveBindings: 0n,
  jitActiveArtifacts: 0n,
  jitActiveAddressSpaces: 0n,
  jitAliasBindings: 0n,
  jitAliasReuses: 0n,
  jitCacheBindingBytes: 0n,
  jitCacheArtifactBytes: 0n,
  jitCacheTotalBytes: 0n,
  jitAotLookups: 0n,
  jitAotMatches: 0n,
  jitAotAmbiguous: 0n,
  jitAotDeclines: 0n,
  jitAotRegistrations: 0n,
  jitAotRegistrationRejections: 0n,
  jitAotDispatches: 0n,
  jitAotRetired: 0n,
  jitAotDynamicCompilesAvoided: 0n,
  syscallCpuClones: 0n,
  sysretCpuClones: 0n,
  replacementCommitCpuClones: 0n,
  jitTraceReadIneligible: 0n,
  jitTraceWriteIneligible: 0n,
  jitTraceInternalEdges: 0n,
  jitTraceExternalEdges: 0n,
  jitTraceCurrentStateOps: 0n,
  jitTraceProposedStateOps: 0n,
  jitTraceCurrentFlagOps: 0n,
  jitTraceProposedFlagOps: 0n,
  jitTraceCurrentMaterializations: 0n,
  jitTraceProposedMaterializations: 0n,
  jitTraceAddedGuards: 0n,
  jitTraceRecordingWindows: 0n,
  jitTraceRecordedEdges: 0n,
  jitTraceAcceptedEdges: 0n,
  jitTraceStaleEdges: 0n,
  jitTraceDroppedEdges: 0n,
  jitTraceRecordedRetired: 0n,
  jitTraceSelectedRoots: 0n,
  jitTraceReadSiteVisits: 0n,
  jitTraceReadFirstVisits: 0n,
  jitTraceReadReuses: 0n,
  jitTraceReadPageChanges: 0n,
  jitTraceReadRefreshes: 0n,
  jitTraceReadUnsafe: 0n,
  jitTraceWriteSiteVisits: 0n,
  jitTraceWriteFirstVisits: 0n,
  jitTraceWriteReuses: 0n,
  jitTraceWritePageChanges: 0n,
  jitTraceWriteRefreshes: 0n,
  jitTraceWriteUnsafe: 0n,
  workload: emptyCoreWorkloadProfile(),
};

export function decodeCoreRuntimeProfile(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): CoreRuntimeProfile {
  const profile = record(value, "core runtime profile");
  const keys = [
    "enabled",
    "decodeCacheHits",
    "decodeCacheMisses",
    "decodeCacheEmpty",
    "decodeCacheTagMismatches",
    "decodeMappingFastHits",
    "decodeMappingRevalidations",
    "decodeMappingMismatches",
    "decodeGenerationFastHits",
    "decodeGenerationChecks",
    "decodeGenerationMismatches",
    "decodedBytes",
    "tlbHits",
    "tlbMisses",
    "tlbProbeHits",
    "tlbProbeMisses",
  ] as const;
  const profileKeys = schemaVersion >= 14
      ? [
          ...(schemaVersion >= 49 ? CORE_PROFILE_KEYS_V49 : []),
          ...keys,
          ...(schemaVersion >= 18
            ? [
                "decodeMappingInvalidationChanges",
                "decodeMappingCr3Changes",
                "decodeMappingPolicyChanges",
                "tlbInvlpg",
                "tlbInvpcidIndividual",
                "tlbInvpcidSingleContext",
                "tlbInvpcidAllNonGlobal",
                "tlbInvpcidAll",
              ]
            : []),
          ...(schemaVersion >= 19 ? ["workload"] : []),
          "jitChainAttempts",
          "jitChainHits",
          "jitChainMissingCoverage",
          "jitChainMissingCache",
          "jitChainMissingDispatchSlot",
          "jitChainMissingEntry",
          "jitChainInvalidCode",
          "jitChainContextFailures",
          ...(schemaVersion >= 15
            ? [
                "jitCodeWritePages",
                "jitCodeWriteInvalidations",
                "jitCacheReplacements",
                "jitCacheCapacityEvictions",
                "jitDispatchSlotRebindings",
                "jitAdmissionChecks",
                "jitAdmissionRejections",
                "jitCandidatePrepareFailures",
                "jitCandidateBlocked",
                "jitCandidateEmitFailures",
                "jitCandidateCompiles",
                ...(schemaVersion >= 16
                  ? [
                      "jitCacheReuseHits",
                      "jitCacheReusedTranslations",
                      "jitCacheEightHitTranslations",
                      "jitCacheThirtyTwoHitTranslations",
                      ...(schemaVersion >= 17
                        ? [
                            "jitChainCoverageTargets",
                            "jitChainCoverageEightMissTargets",
                            "jitChainCoverageThirtyTwoMissTargets",
                            "jitChainCoverageSixtyFourMissTargets",
                            "jitChainCoverageAdmissionResets",
                            "jitChainCoverageAdmissionResetTargets",
                          ]
                        : []),
                      ...(schemaVersion >= 21
                        ? [
                            "jitResidentTierLoopCalls",
                            "jitBlockObservations",
                            "jitColdBlockExecutions",
                            "jitHotBlockTransitions",
                            "jitHotBoundaryStops",
                            "jitPartialBudgetFallbacks",
                            "jitMemoryReads",
                            "jitMemoryPreflightWrites",
                            "jitMemoryStageWrites",
                            "jitMemoryWrites",
                            "jitMemoryDirectPreflightWrites",
                            "jitReadCacheMissCrossPage",
                            "jitReadCacheMissTag",
                            "jitReadCacheMissEpoch",
                            "jitReadCacheMissUnexplained",
                            "jitWriteCacheMissCrossPage",
                            "jitWriteCacheMissTag",
                            "jitWriteCacheMissEpoch",
                            "jitWriteCacheMissPendingWrites",
                            "jitWriteCacheMissUnexplained",
                            "jitDispatchMissTag",
                            "jitDispatchMissEpoch",
                            "jitDispatchMissTargetSlot",
                            "jitDispatchMissActiveSlot",
                            "jitDispatchMissPendingWrites",
                            "jitDispatchMissInterruptShadow",
                            schemaVersion >= 30
                              ? "jitDispatchMissAddressSpace"
                              : "jitDispatchMissCr3",
                            "jitDispatchMissCpl",
                            "jitDispatchMissUnexplained",
                            "jitDispatchMissEmpty",
                            "jitDispatchEpochInvalidations",
                            "jitDispatchFullInvalidations",
                            "jitDispatchPageInvalidations",
                            "jitDispatchPageSlotsCleared",
                            ...(schemaVersion >= 23 ? CORE_PROFILE_KEYS_V23 : []),
                            ...(schemaVersion >= 24 ? CORE_PROFILE_KEYS_V24 : []),
                            ...(schemaVersion >= 25 ? CORE_PROFILE_KEYS_V25 : []),
                            ...(schemaVersion >= 26 ? CORE_PROFILE_KEYS_V26 : []),
                            ...(schemaVersion >= 28 ? CORE_PROFILE_KEYS_V28 : []),
                            ...(schemaVersion >= 29 ? CORE_PROFILE_KEYS_V29 : []),
                            ...(schemaVersion >= 31 ? CORE_PROFILE_KEYS_V31 : []),
                            ...(schemaVersion >= 32 ? CORE_PROFILE_KEYS_V32 : []),
                            ...(schemaVersion >= 33 ? CORE_PROFILE_KEYS_V33 : []),
                            ...(schemaVersion >= 37 ? CORE_PROFILE_KEYS_V37 : []),
                            ...(schemaVersion >= 40 ? CORE_TRANSLATION_COHERENCE_KEYS : []),
                            ...(schemaVersion >= 41 ? CORE_TRANSLATION_COHERENCE_KEYS_V41 : []),
                            ...(schemaVersion >= 50 ? CORE_JIT_DEFERRAL_KEYS : []),
                            ...(schemaVersion >= 52 ? CORE_TRANSLATION_COHERENCE_KEYS_V52 : []),
                            ...(schemaVersion >= 53 ? CORE_JIT_REUSE_KEYS : []),
                            ...(schemaVersion >= 43 ? CORE_PROFILE_KEYS_V43 : []),
                            ...(schemaVersion >= 44 ? CORE_TRANSLATION_COHERENCE_KEYS_V44 : []),
                          ]
                        : []),
                    ]
                  : []),
              ]
            : []),
        ]
      : keys;
  exactKeys(
    profile,
    schemaVersion >= 22 ? ["recordVersion", ...profileKeys] : profileKeys,
    [
      ...(schemaVersion < 49 ? CORE_PROFILE_KEYS_V49 : []),
      ...(schemaVersion < 22 ? ["recordVersion"] : []),
      ...(schemaVersion < 23 ? CORE_PROFILE_KEYS_V23 : []),
      ...(schemaVersion < 24 ? CORE_PROFILE_KEYS_V24 : []),
      ...(schemaVersion < 25 ? CORE_PROFILE_KEYS_V25 : []),
      ...(schemaVersion < 26 ? CORE_PROFILE_KEYS_V26 : []),
      ...(schemaVersion < 28 ? CORE_PROFILE_KEYS_V28 : []),
      ...(schemaVersion < 29 ? CORE_PROFILE_KEYS_V29 : []),
      ...(schemaVersion < 31 ? CORE_PROFILE_KEYS_V31 : []),
      ...(schemaVersion < 32 ? CORE_PROFILE_KEYS_V32 : []),
      ...(schemaVersion < 33 ? CORE_PROFILE_KEYS_V33 : []),
      ...(schemaVersion < 37 ? CORE_PROFILE_KEYS_V37 : []),
      ...(schemaVersion < 40 ? CORE_TRANSLATION_COHERENCE_KEYS : []),
      ...(schemaVersion < 41 ? CORE_TRANSLATION_COHERENCE_KEYS_V41 : []),
      ...(schemaVersion < 50 ? CORE_JIT_DEFERRAL_KEYS : []),
      ...(schemaVersion < 43 ? CORE_PROFILE_KEYS_V43 : []),
      ...(schemaVersion < 44 ? CORE_TRANSLATION_COHERENCE_KEYS_V44 : []),
      ...(schemaVersion < 52 ? CORE_TRANSLATION_COHERENCE_KEYS_V52 : []),
      ...(schemaVersion < 53 ? CORE_JIT_REUSE_KEYS : []),
      ...(schemaVersion < 30
        ? ["jitDispatchMissAddressSpace" as const]
        : ["jitDispatchMissCr3" as const]),
    ],
  );
  if (schemaVersion < 49 && profile["jitReadCacheMissPendingWrites"] !== undefined
    && nonnegativeBigint(profile["jitReadCacheMissPendingWrites"], "JIT read-cache pending-write misses") !== 0n) {
    throw new VMError("PROTOCOL_ERROR", "historical pending-write read misses are not empty");
  }
  const compatibilityDispatchKey = schemaVersion < 30
    ? "jitDispatchMissAddressSpace"
    : "jitDispatchMissCr3";
  if (
    profile[compatibilityDispatchKey] !== undefined
    && nonnegativeBigint(profile[compatibilityDispatchKey], compatibilityDispatchKey) !== 0n
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "incompatible JIT dispatch identity counter is not empty",
    );
  }
  if (
    schemaVersion < 23 &&
    CORE_PROFILE_KEYS_V23.some(
      (key) => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n,
    )
  ) {
    throw new VMError("PROTOCOL_ERROR", "legacy JIT region profile is not empty");
  }
  if (
    schemaVersion < 24 &&
    CORE_PROFILE_KEYS_V24.some(
      (key) => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n,
    )
  ) {
    throw new VMError("PROTOCOL_ERROR", "legacy direct-cache profile is not empty");
  }
  if (schemaVersion < 25 && CORE_PROFILE_KEYS_V25.some((key) => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n)) {
    throw new VMError("PROTOCOL_ERROR", "legacy victim-cache profile is not empty");
  }
  if (schemaVersion < 26 && CORE_PROFILE_KEYS_V26.some((key) => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n)) {
    throw new VMError("PROTOCOL_ERROR", "legacy RMW-reuse profile is not empty");
  }
  if (schemaVersion < 28 && CORE_PROFILE_KEYS_V28.some((key) => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n)) {
    throw new VMError("PROTOCOL_ERROR", "legacy Tier-2 profile is not empty");
  }
  if (schemaVersion < 29 && CORE_PROFILE_KEYS_V29.some((key) => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n)) {
    throw new VMError("PROTOCOL_ERROR", "legacy Tier-2 failure profile is not empty");
  }
  if (schemaVersion < 31 && CORE_PROFILE_KEYS_V31.some((key) => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n)) {
    throw new VMError("PROTOCOL_ERROR", "legacy resident/JIT binding profile is not empty");
  }
  if (schemaVersion < 32 && CORE_PROFILE_KEYS_V32.some((key) => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n)) {
    throw new VMError("PROTOCOL_ERROR", "legacy JIT cache byte profile is not empty");
  }
  if (schemaVersion < 33 && CORE_PROFILE_KEYS_V33.some((key) => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n)) {
    throw new VMError("PROTOCOL_ERROR", "legacy AOT profile is not empty");
  }
  if (schemaVersion < 37 && CORE_PROFILE_KEYS_V37.some((key) => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n)) {
    throw new VMError("PROTOCOL_ERROR", "legacy CPU copy profile is not empty");
  }
  if (schemaVersion < 43 && profile["jitRegionStopArchitecturalEventBoundary"] !== undefined && nonnegativeBigint(profile["jitRegionStopArchitecturalEventBoundary"], "architectural event boundaries") !== 0n) {
    throw new VMError("PROTOCOL_ERROR", "legacy architectural event boundary profile is not empty");
  }
  const enabled = boolean(
    profile["enabled"],
    "core runtime profile enabled",
  );
  const recordVersion = schemaVersion >= 22
    ? decodeRuntimeRecordVersion(profile["recordVersion"], schemaVersion)
    : 9;
  const v23 = (key: string, label: string) =>
    schemaVersion >= 23 ? nonnegativeBigint(profile[key], label) : 0n;
  const v24 = (key: string, label: string) =>
    schemaVersion >= 24 ? nonnegativeBigint(profile[key], label) : 0n;
  const v25 = (key: string, label: string) =>
    schemaVersion >= 25 ? nonnegativeBigint(profile[key], label) : 0n;
  const v26 = (key: string, label: string) =>
    schemaVersion >= 26 ? nonnegativeBigint(profile[key], label) : 0n;
  const v28 = (key: string, label: string) =>
    schemaVersion >= 28 ? nonnegativeBigint(profile[key], label) : 0n;
  const v29 = (key: string, label: string) =>
    schemaVersion >= 29 ? nonnegativeBigint(profile[key], label) : 0n;
  const v31 = (key: string, label: string) =>
    schemaVersion >= 31 ? nonnegativeBigint(profile[key], label) : 0n;
  const v32 = (key: string, label: string) =>
    schemaVersion >= 32 ? nonnegativeBigint(profile[key], label) : 0n;
  const v33 = (key: string, label: string) =>
    schemaVersion >= 33 ? nonnegativeBigint(profile[key], label) : 0n;
  return {
    ...decodeTranslationCoherence(profile, schemaVersion),
    ...decodeJitDeferral(profile, schemaVersion),
    ...decodeJitReuse(profile, schemaVersion),
    recordVersion,
    enabled,
    decodeCacheHits: nonnegativeBigint(
      profile["decodeCacheHits"],
      "decode-cache hits",
    ),
    decodeCacheMisses: nonnegativeBigint(
      profile["decodeCacheMisses"],
      "decode-cache misses",
    ),
    decodeCacheEmpty: nonnegativeBigint(
      profile["decodeCacheEmpty"],
      "empty decode-cache slots",
    ),
    decodeCacheTagMismatches: nonnegativeBigint(
      profile["decodeCacheTagMismatches"],
      "decode-cache tag mismatches",
    ),
    decodeMappingFastHits: nonnegativeBigint(
      profile["decodeMappingFastHits"],
      "decode mapping fast hits",
    ),
    decodeMappingRevalidations: nonnegativeBigint(
      profile["decodeMappingRevalidations"],
      "decode mapping revalidations",
    ),
    decodeMappingMismatches: nonnegativeBigint(
      profile["decodeMappingMismatches"],
      "decode mapping mismatches",
    ),
    decodeMappingInvalidationChanges:
      schemaVersion >= 18
        ? nonnegativeBigint(
            profile["decodeMappingInvalidationChanges"],
            "decode mapping invalidation changes",
          )
        : 0n,
    decodeMappingCr3Changes:
      schemaVersion >= 18
        ? nonnegativeBigint(
            profile["decodeMappingCr3Changes"],
            "decode mapping CR3 changes",
          )
        : 0n,
    decodeMappingPolicyChanges:
      schemaVersion >= 18
        ? nonnegativeBigint(
            profile["decodeMappingPolicyChanges"],
            "decode mapping policy changes",
          )
        : 0n,
    decodeGenerationFastHits: nonnegativeBigint(
      profile["decodeGenerationFastHits"],
      "decode generation fast hits",
    ),
    decodeGenerationChecks: nonnegativeBigint(
      profile["decodeGenerationChecks"],
      "decode generation checks",
    ),
    decodeGenerationMismatches: nonnegativeBigint(
      profile["decodeGenerationMismatches"],
      "decode generation mismatches",
    ),
    decodedBytes: nonnegativeBigint(
      profile["decodedBytes"],
      "decoded instruction bytes",
    ),
    tlbHits: nonnegativeBigint(profile["tlbHits"], "TLB hits"),
    tlbMisses: nonnegativeBigint(profile["tlbMisses"], "TLB misses"),
    tlbProbeHits: nonnegativeBigint(
      profile["tlbProbeHits"],
      "TLB probe hits",
    ),
    tlbProbeMisses: nonnegativeBigint(
      profile["tlbProbeMisses"],
      "TLB probe misses",
    ),
    tlbInvlpg:
      schemaVersion >= 18
        ? nonnegativeBigint(profile["tlbInvlpg"], "INVLPG executions")
        : 0n,
    tlbInvpcidIndividual:
      schemaVersion >= 18
        ? nonnegativeBigint(
            profile["tlbInvpcidIndividual"],
            "individual-address INVPCID executions",
          )
        : 0n,
    tlbInvpcidSingleContext:
      schemaVersion >= 18
        ? nonnegativeBigint(
            profile["tlbInvpcidSingleContext"],
            "single-context INVPCID executions",
          )
        : 0n,
    tlbInvpcidAllNonGlobal:
      schemaVersion >= 18
        ? nonnegativeBigint(
            profile["tlbInvpcidAllNonGlobal"],
            "all-non-global INVPCID executions",
          )
        : 0n,
    tlbInvpcidAll:
      schemaVersion >= 18
        ? nonnegativeBigint(
            profile["tlbInvpcidAll"],
            "all-context INVPCID executions",
          )
        : 0n,
    jitChainAttempts:
      schemaVersion >= 14
        ? nonnegativeBigint(profile["jitChainAttempts"], "JIT chain attempts")
        : 0n,
    jitChainHits:
      schemaVersion >= 14
        ? nonnegativeBigint(profile["jitChainHits"], "JIT chain hits")
        : 0n,
    jitChainMissingCoverage:
      schemaVersion >= 14
        ? nonnegativeBigint(
            profile["jitChainMissingCoverage"],
            "JIT chains without coverage",
          )
        : 0n,
    jitChainMissingCache:
      schemaVersion >= 14
        ? nonnegativeBigint(
            profile["jitChainMissingCache"],
            "JIT chains without cache entries",
          )
        : 0n,
    jitChainMissingDispatchSlot:
      schemaVersion >= 14
        ? nonnegativeBigint(
            profile["jitChainMissingDispatchSlot"],
            "JIT chains without dispatch slots",
          )
        : 0n,
    jitChainMissingEntry:
      schemaVersion >= 14
        ? nonnegativeBigint(
            profile["jitChainMissingEntry"],
            "JIT chains without entry indexes",
          )
        : 0n,
    jitChainInvalidCode:
      schemaVersion >= 14
        ? nonnegativeBigint(
            profile["jitChainInvalidCode"],
            "JIT chains with invalid code",
          )
        : 0n,
    jitChainContextFailures:
      schemaVersion >= 14
        ? nonnegativeBigint(
            profile["jitChainContextFailures"],
            "JIT chain context failures",
          )
        : 0n,
    jitCodeWritePages:
      schemaVersion >= 15
        ? nonnegativeBigint(
            profile["jitCodeWritePages"],
            "JIT code-write pages",
          )
        : 0n,
    jitCodeWriteInvalidations:
      schemaVersion >= 15
        ? nonnegativeBigint(
            profile["jitCodeWriteInvalidations"],
            "JIT code-write invalidations",
          )
        : 0n,
    jitCacheReplacements:
      schemaVersion >= 15
        ? nonnegativeBigint(
            profile["jitCacheReplacements"],
            "JIT cache replacements",
          )
        : 0n,
    jitCacheCapacityEvictions:
      schemaVersion >= 15
        ? nonnegativeBigint(
            profile["jitCacheCapacityEvictions"],
            "JIT cache capacity evictions",
          )
        : 0n,
    jitDispatchSlotRebindings:
      schemaVersion >= 15
        ? nonnegativeBigint(
            profile["jitDispatchSlotRebindings"],
            "JIT dispatch-slot rebindings",
          )
        : 0n,
    jitAdmissionChecks:
      schemaVersion >= 15
        ? nonnegativeBigint(
            profile["jitAdmissionChecks"],
            "JIT admission checks",
          )
        : 0n,
    jitAdmissionRejections:
      schemaVersion >= 15
        ? nonnegativeBigint(
            profile["jitAdmissionRejections"],
            "JIT admission rejections",
          )
        : 0n,
    jitCandidatePrepareFailures:
      schemaVersion >= 15
        ? nonnegativeBigint(
            profile["jitCandidatePrepareFailures"],
            "JIT candidate preparation failures",
          )
        : 0n,
    jitCandidateBlocked:
      schemaVersion >= 15
        ? nonnegativeBigint(
            profile["jitCandidateBlocked"],
            "blocked JIT candidates",
          )
        : 0n,
    jitCandidateEmitFailures:
      schemaVersion >= 15
        ? nonnegativeBigint(
            profile["jitCandidateEmitFailures"],
            "JIT candidate emission failures",
          )
        : 0n,
    jitCandidateCompiles:
      schemaVersion >= 15
        ? nonnegativeBigint(
            profile["jitCandidateCompiles"],
            "compiled JIT candidates",
          )
        : 0n,
    jitCacheReuseHits:
      schemaVersion >= 16
        ? nonnegativeBigint(
            profile["jitCacheReuseHits"],
            "JIT cache reuse hits",
          )
        : 0n,
    jitCacheReusedTranslations:
      schemaVersion >= 16
        ? nonnegativeBigint(
            profile["jitCacheReusedTranslations"],
            "reused JIT translations",
          )
        : 0n,
    jitCacheEightHitTranslations:
      schemaVersion >= 16
        ? nonnegativeBigint(
            profile["jitCacheEightHitTranslations"],
            "JIT translations reused at least eight times",
          )
        : 0n,
    jitCacheThirtyTwoHitTranslations:
      schemaVersion >= 16
        ? nonnegativeBigint(
            profile["jitCacheThirtyTwoHitTranslations"],
            "JIT translations reused at least thirty-two times",
          )
        : 0n,
    jitChainCoverageTargets:
      schemaVersion >= 17
        ? nonnegativeBigint(
            profile["jitChainCoverageTargets"],
            "JIT chain missing-coverage targets",
          )
        : 0n,
    jitChainCoverageEightMissTargets:
      schemaVersion >= 17
        ? nonnegativeBigint(
            profile["jitChainCoverageEightMissTargets"],
            "JIT chain targets missed at least eight times",
          )
        : 0n,
    jitChainCoverageThirtyTwoMissTargets:
      schemaVersion >= 17
        ? nonnegativeBigint(
            profile["jitChainCoverageThirtyTwoMissTargets"],
            "JIT chain targets missed at least thirty-two times",
          )
        : 0n,
    jitChainCoverageSixtyFourMissTargets:
      schemaVersion >= 17
        ? nonnegativeBigint(
            profile["jitChainCoverageSixtyFourMissTargets"],
            "JIT chain targets missed at least sixty-four times",
          )
        : 0n,
    jitChainCoverageAdmissionResets:
      schemaVersion >= 17
        ? nonnegativeBigint(
            profile["jitChainCoverageAdmissionResets"],
            "JIT chain admission reset occurrences",
          )
        : 0n,
    jitChainCoverageAdmissionResetTargets:
      schemaVersion >= 17
        ? nonnegativeBigint(
            profile["jitChainCoverageAdmissionResetTargets"],
            "JIT chain targets with admission resets",
          )
        : 0n,
    jitResidentTierLoopCalls:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitResidentTierLoopCalls"],
            "resident JIT tier-loop calls",
          )
        : 0n,
    jitBlockObservations:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitBlockObservations"],
            "exact JIT block observations",
          )
        : 0n,
    jitColdBlockExecutions:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitColdBlockExecutions"],
            "cold JIT block executions",
          )
        : 0n,
    jitHotBlockTransitions:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitHotBlockTransitions"],
            "hot JIT block transitions",
          )
        : 0n,
    jitHotBoundaryStops:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitHotBoundaryStops"],
            "hot JIT boundary stops",
          )
        : 0n,
    jitPartialBudgetFallbacks:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitPartialBudgetFallbacks"],
            "partial-budget JIT fallbacks",
          )
        : 0n,
    jitMemoryReads:
      schemaVersion >= 21
        ? nonnegativeBigint(profile["jitMemoryReads"], "JIT memory reads")
        : 0n,
    jitMemoryPreflightWrites:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitMemoryPreflightWrites"],
            "JIT memory write preflights",
          )
        : 0n,
    jitMemoryStageWrites:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitMemoryStageWrites"],
            "JIT staged memory writes",
          )
        : 0n,
    jitMemoryWrites:
      schemaVersion >= 21
        ? nonnegativeBigint(profile["jitMemoryWrites"], "JIT memory writes")
        : 0n,
    jitMemoryDirectPreflightWrites:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitMemoryDirectPreflightWrites"],
            "JIT direct-write preflights",
          )
        : 0n,
    jitReadCacheMissCrossPage:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitReadCacheMissCrossPage"],
            "cross-page JIT read-cache misses",
          )
        : 0n,
    jitReadCacheMissTag:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitReadCacheMissTag"],
            "JIT read-cache tag misses",
          )
        : 0n,
    jitReadCacheMissEpoch:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitReadCacheMissEpoch"],
            "JIT read-cache epoch misses",
          )
        : 0n,
    jitReadCacheMissUnexplained:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitReadCacheMissUnexplained"],
            "unexplained JIT read-cache misses",
          )
        : 0n,
    jitReadCacheMissPendingWrites: schemaVersion >= 49
      ? nonnegativeBigint(profile["jitReadCacheMissPendingWrites"], "JIT read-cache pending-write misses") : 0n,
    jitWriteCacheMissCrossPage:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitWriteCacheMissCrossPage"],
            "cross-page JIT write-cache misses",
          )
        : 0n,
    jitWriteCacheMissTag:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitWriteCacheMissTag"],
            "JIT write-cache tag misses",
          )
        : 0n,
    jitWriteCacheMissEpoch:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitWriteCacheMissEpoch"],
            "JIT write-cache epoch misses",
          )
        : 0n,
    jitWriteCacheMissPendingWrites:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitWriteCacheMissPendingWrites"],
            "pending-write JIT write-cache misses",
          )
        : 0n,
    jitWriteCacheMissUnexplained:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitWriteCacheMissUnexplained"],
            "unexplained JIT write-cache misses",
          )
        : 0n,
    jitDispatchMissTag:
      schemaVersion >= 21
        ? nonnegativeBigint(profile["jitDispatchMissTag"], "JIT dispatch tag misses")
        : 0n,
    jitDispatchMissEpoch:
      schemaVersion >= 21
        ? nonnegativeBigint(profile["jitDispatchMissEpoch"], "JIT dispatch epoch misses")
        : 0n,
    jitDispatchMissTargetSlot:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitDispatchMissTargetSlot"],
            "JIT dispatch target-slot misses",
          )
        : 0n,
    jitDispatchMissActiveSlot:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitDispatchMissActiveSlot"],
            "JIT dispatch active-slot misses",
          )
        : 0n,
    jitDispatchMissPendingWrites:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitDispatchMissPendingWrites"],
            "JIT dispatch pending-write misses",
          )
        : 0n,
    jitDispatchMissInterruptShadow:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitDispatchMissInterruptShadow"],
            "JIT dispatch interrupt-shadow misses",
          )
        : 0n,
    jitDispatchMissAddressSpace:
      schemaVersion >= 30
        ? nonnegativeBigint(
            profile["jitDispatchMissAddressSpace"],
            "JIT dispatch address-space misses",
          )
        : 0n,
    jitDispatchMissCr3:
      schemaVersion >= 21 && schemaVersion < 30
        ? nonnegativeBigint(profile["jitDispatchMissCr3"], "JIT dispatch CR3 misses")
        : 0n,
    jitDispatchMissCpl:
      schemaVersion >= 21
        ? nonnegativeBigint(profile["jitDispatchMissCpl"], "JIT dispatch CPL misses")
        : 0n,
    jitDispatchMissUnexplained:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitDispatchMissUnexplained"],
            "unexplained JIT dispatch misses",
          )
        : 0n,
    jitDispatchMissEmpty:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitDispatchMissEmpty"],
            "empty JIT dispatch misses",
          )
        : 0n,
    jitDispatchEpochInvalidations:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitDispatchEpochInvalidations"],
            "JIT dispatch epoch invalidations",
          )
        : 0n,
    jitDispatchFullInvalidations:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitDispatchFullInvalidations"],
            "JIT dispatch full invalidations",
          )
        : 0n,
    jitDispatchPageInvalidations:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitDispatchPageInvalidations"],
            "JIT dispatch page invalidations",
          )
        : 0n,
    jitDispatchPageSlotsCleared:
      schemaVersion >= 21
        ? nonnegativeBigint(
            profile["jitDispatchPageSlotsCleared"],
            "JIT dispatch page slots cleared",
          )
        : 0n,
    jitRegionCandidates: v23("jitRegionCandidates", "JIT region candidates"),
    jitRegionDiscoveredPages: v23("jitRegionDiscoveredPages", "discovered JIT region pages"),
    jitRegionDiscoveredBlocks: v23("jitRegionDiscoveredBlocks", "discovered JIT region blocks"),
    jitRegionDiscoveredInstructions: v23("jitRegionDiscoveredInstructions", "discovered JIT region instructions"),
    jitRegionReadyPages: v23("jitRegionReadyPages", "ready JIT region pages"),
    jitRegionReadyBlocks: v23("jitRegionReadyBlocks", "ready JIT region blocks"),
    jitRegionReadyInstructions: v23("jitRegionReadyInstructions", "ready JIT region instructions"),
    jitRegionUncoveredPages: v23("jitRegionUncoveredPages", "uncovered JIT region pages"),
    jitRegionUncoveredBlocks: v23("jitRegionUncoveredBlocks", "uncovered JIT region blocks"),
    jitRegionUncoveredInstructions: v23("jitRegionUncoveredInstructions", "uncovered JIT region instructions"),
    jitRegionStopInstructionLimit: v23("jitRegionStopInstructionLimit", "instruction-limited JIT regions"),
    jitRegionStopBlockLimit: v23("jitRegionStopBlockLimit", "block-limited JIT regions"),
    jitRegionStopPageLimit: v23("jitRegionStopPageLimit", "page-limited JIT regions"),
    jitRegionStopDecodeOrLowering: v23("jitRegionStopDecodeOrLowering", "decode/lowering-limited JIT regions"),
    jitRegionStopSuccessorNotReady: v23("jitRegionStopSuccessorNotReady", "not-ready JIT region successors"),
    jitRegionStopAlreadyCovered: v23("jitRegionStopAlreadyCovered", "already-covered JIT region successors"),
    jitRegionStopIndirectOrHostExit: v23("jitRegionStopIndirectOrHostExit", "indirect/host-exit JIT regions"),
    jitRegionStopArchitecturalEventBoundary: schemaVersion >= 43 ? nonnegativeBigint(profile["jitRegionStopArchitecturalEventBoundary"], "architectural event boundaries") : 0n,
    jitAdmissionEvictedCold: v23("jitAdmissionEvictedCold", "cold admission evictions"),
    jitAdmissionEvictedHot: v23("jitAdmissionEvictedHot", "hot admission evictions"),
    jitAdmissionEvictedBlocked: v23("jitAdmissionEvictedBlocked", "blocked admission evictions"),
    jitAdmissionArbitraryFallbacks: v23("jitAdmissionArbitraryFallbacks", "arbitrary admission evictions"),
    jitAdmissionIdentityChanges: v23("jitAdmissionIdentityChanges", "admission identity changes"),
    jitAdmissionDroppedIdentityObservations: v23("jitAdmissionDroppedIdentityObservations", "dropped admission identity observations"),
    jitReadCacheHits: v24("jitReadCacheHits", "JIT read-cache hits"),
    jitWriteCacheHits: v24("jitWriteCacheHits", "JIT write-cache hits"),
    jitReadVictimHits: v25("jitReadVictimHits", "JIT read-victim hits"),
    jitWriteVictimHits: v25("jitWriteVictimHits", "JIT write-victim hits"),
    jitRmwEligible: v26("jitRmwEligible", "eligible JIT RMW executions"),
    jitRmwReadReuses: v26("jitRmwReadReuses", "JIT RMW read translation reuses"),
    jitRmwWriteReuses: v26("jitRmwWriteReuses", "JIT RMW write translation reuses"),
    jitDispatchSlotClearEntriesScanned: v24(
      "jitDispatchSlotClearEntriesScanned",
      "JIT dispatch slot-clear entries scanned",
    ),
    jitDispatchSlotClearEntriesCleared: v24(
      "jitDispatchSlotClearEntriesCleared",
      "JIT dispatch slot-clear entries cleared",
    ),
    jitTailChainTransitions: v28("jitTailChainTransitions", "JIT tail-chain transitions"),
    jitTier2Eligible: v28("jitTier2Eligible", "Tier-2 eligible roots"),
    jitTier2PromotionAttempts: v28("jitTier2PromotionAttempts", "Tier-2 promotion attempts"),
    jitTier2Compiles: v28("jitTier2Compiles", "Tier-2 compiles"),
    jitTier2Failures: v28("jitTier2Failures", "Tier-2 failures"),
    jitTier2CompiledInstructions: v28(
      "jitTier2CompiledInstructions",
      "Tier-2 compiled instructions",
    ),
    jitTier2ExecutionEntries: v28("jitTier2ExecutionEntries", "Tier-2 execution entries"),
    jitTier2FailureMachineUnavailable: v29(
      "jitTier2FailureMachineUnavailable",
      "machine-unavailable Tier-2 failures",
    ),
    jitTier2FailureWriteTracking: v29(
      "jitTier2FailureWriteTracking",
      "write-tracking Tier-2 failures",
    ),
    jitTier2FailureUnsupportedCpuContext: v29(
      "jitTier2FailureUnsupportedCpuContext",
      "unsupported-context Tier-2 failures",
    ),
    jitTier2FailureDecodeOrTranslationFault: v29(
      "jitTier2FailureDecodeOrTranslationFault",
      "decode/translation Tier-2 failures",
    ),
    jitTier2FailureQuarantinedSemantic: v29(
      "jitTier2FailureQuarantinedSemantic",
      "quarantined-semantic Tier-2 failures",
    ),
    jitTier2FailureUnsupportedSemantic: v29(
      "jitTier2FailureUnsupportedSemantic",
      "unsupported-semantic Tier-2 failures",
    ),
    jitTier2FailureUnsupportedForm: v29(
      "jitTier2FailureUnsupportedForm",
      "unsupported-form Tier-2 failures",
    ),
    jitTier2FailureEmission: v29(
      "jitTier2FailureEmission",
      "emission Tier-2 failures",
    ),
    jitTier2FailureModuleSizeLimit: v29(
      "jitTier2FailureModuleSizeLimit",
      "module-size Tier-2 failures",
    ),
    jitTier2FailureCandidateLimit: v29(
      "jitTier2FailureCandidateLimit",
      "candidate-limit Tier-2 failures",
    ),
    jitTier2FailureStaleProfile: v29(
      "jitTier2FailureStaleProfile",
      "stale-profile Tier-2 failures",
    ),
    jitTier2FailureIneligibleTrace: v29(
      "jitTier2FailureIneligibleTrace",
      "ineligible-trace Tier-2 failures",
    ),
    jitTier2FailureResidentBudget: v29(
      "jitTier2FailureResidentBudget",
      "resident-budget Tier-2 failures",
    ),
    jitTier2FailureNoRegion: v29(
      "jitTier2FailureNoRegion",
      "no-region Tier-2 failures",
    ),
    jitTier2FailureNoEligibleEdges: v29(
      "jitTier2FailureNoEligibleEdges",
      "no-eligible-edge Tier-2 failures",
    ),
    jitTier2FailureInsufficientInternalization: v29(
      "jitTier2FailureInsufficientInternalization",
      "insufficient-internalization Tier-2 failures",
    ),
    jitTier2FailureNoRecurrentComponent: v29(
      "jitTier2FailureNoRecurrentComponent",
      "no-recurrent-component Tier-2 failures",
    ),
    jitTier1Retired: v29("jitTier1Retired", "Tier-1 retired instructions"),
    jitTier2Retired: v29("jitTier2Retired", "Tier-2 retired instructions"),
    jitTier1Ring0Retired: v29(
      "jitTier1Ring0Retired",
      "Ring-0 Tier-1 retired instructions",
    ),
    jitTier1Ring3Retired: v29(
      "jitTier1Ring3Retired",
      "Ring-3 Tier-1 retired instructions",
    ),
    jitTier2Ring0Retired: v29(
      "jitTier2Ring0Retired",
      "Ring-0 Tier-2 retired instructions",
    ),
    jitTier2Ring3Retired: v29(
      "jitTier2Ring3Retired",
      "Ring-3 Tier-2 retired instructions",
    ),
    jitResidentAdapterCompletions: v31(
      "jitResidentAdapterCompletions",
      "resident adapter completions",
    ),
    jitAdapterExitsReturned: v31(
      "jitAdapterExitsReturned",
      "adapter exits returned to the worker",
    ),
    jitResidentTaskSwitches: v31(
      "jitResidentTaskSwitches",
      "resident task switches",
    ),
    jitResidentZeroRetirementExhaustions: v31(
      "jitResidentZeroRetirementExhaustions",
      "resident zero-retirement exhaustions",
    ),
    jitResidentHostWaitExits: v31(
      "jitResidentHostWaitExits",
      "resident host-wait exits",
    ),
    jitDispatchRebindSameModuleCrossAddressSpace: v31(
      "jitDispatchRebindSameModuleCrossAddressSpace",
      "same-module cross-address-space dispatch rebindings",
    ),
    jitDispatchRebindDifferentModule: v31(
      "jitDispatchRebindDifferentModule",
      "different-module dispatch rebindings",
    ),
    jitDispatchRebindSameAddressSpace: v31(
      "jitDispatchRebindSameAddressSpace",
      "same-address-space dispatch rebindings",
    ),
    jitBindingInvalidationsUnregister: v31(
      "jitBindingInvalidationsUnregister",
      "unregistered JIT bindings",
    ),
    jitBindingInvalidationsEviction: v31(
      "jitBindingInvalidationsEviction",
      "evicted JIT bindings",
    ),
    jitBindingInvalidationsReplacement: v31(
      "jitBindingInvalidationsReplacement",
      "replaced JIT bindings",
    ),
    jitActiveBindings: v31("jitActiveBindings", "active JIT bindings"),
    jitActiveArtifacts: v31("jitActiveArtifacts", "active JIT artifacts"),
    jitActiveAddressSpaces: v31(
      "jitActiveAddressSpaces",
      "active JIT address spaces",
    ),
    jitAliasBindings: v31("jitAliasBindings", "active JIT alias bindings"),
    jitAliasReuses: v31("jitAliasReuses", "JIT alias reuses"),
    jitCacheBindingBytes: v32("jitCacheBindingBytes", "JIT cache binding bytes"),
    jitCacheArtifactBytes: v32("jitCacheArtifactBytes", "JIT cache artifact bytes"),
    jitCacheTotalBytes: v32("jitCacheTotalBytes", "total JIT cache bytes"),
    jitAotLookups: v33("jitAotLookups", "AOT lookups"),
    jitAotMatches: v33("jitAotMatches", "AOT matches"),
    jitAotAmbiguous: v33("jitAotAmbiguous", "ambiguous AOT matches"),
    jitAotDeclines: v33("jitAotDeclines", "AOT declines"),
    jitAotRegistrations: v33("jitAotRegistrations", "AOT registrations"),
    jitAotRegistrationRejections: v33("jitAotRegistrationRejections", "AOT registration rejections"),
    jitAotDispatches: v33("jitAotDispatches", "AOT dispatches"),
    jitAotRetired: v33("jitAotRetired", "AOT retired instructions"),
    jitAotDynamicCompilesAvoided: v33("jitAotDynamicCompilesAvoided", "AOT dynamic compiles avoided"),
    syscallCpuClones: schemaVersion >= 37 ? nonnegativeBigint(profile["syscallCpuClones"], "syscallCpuClones") : 0n,
    sysretCpuClones: schemaVersion >= 37 ? nonnegativeBigint(profile["sysretCpuClones"], "sysretCpuClones") : 0n,
    replacementCommitCpuClones: schemaVersion >= 37 ? nonnegativeBigint(profile["replacementCommitCpuClones"], "replacementCommitCpuClones") : 0n,
    jitTraceReadIneligible: v29(
      "jitTraceReadIneligible",
      "trace read translations ineligible for reuse",
    ),
    jitTraceWriteIneligible: v29(
      "jitTraceWriteIneligible",
      "trace write translations ineligible for reuse",
    ),
    jitTraceInternalEdges: v29("jitTraceInternalEdges", "internal trace edges"),
    jitTraceExternalEdges: v29("jitTraceExternalEdges", "external trace edges"),
    jitTraceCurrentStateOps: v29(
      "jitTraceCurrentStateOps",
      "counterfactual current state operations",
    ),
    jitTraceProposedStateOps: v29(
      "jitTraceProposedStateOps",
      "proposed trace state operations",
    ),
    jitTraceCurrentFlagOps: v29(
      "jitTraceCurrentFlagOps",
      "counterfactual current flag operations",
    ),
    jitTraceProposedFlagOps: v29(
      "jitTraceProposedFlagOps",
      "proposed trace flag operations",
    ),
    jitTraceCurrentMaterializations: v29(
      "jitTraceCurrentMaterializations",
      "counterfactual current materializations",
    ),
    jitTraceProposedMaterializations: v29(
      "jitTraceProposedMaterializations",
      "proposed trace materializations",
    ),
    jitTraceAddedGuards: v29("jitTraceAddedGuards", "added trace guards"),
    jitTraceRecordingWindows: v29(
      "jitTraceRecordingWindows",
      "trace-recording windows",
    ),
    jitTraceRecordedEdges: v29("jitTraceRecordedEdges", "recorded trace edges"),
    jitTraceAcceptedEdges: v29("jitTraceAcceptedEdges", "accepted trace edges"),
    jitTraceStaleEdges: v29("jitTraceStaleEdges", "stale trace edges"),
    jitTraceDroppedEdges: v29("jitTraceDroppedEdges", "dropped trace edges"),
    jitTraceRecordedRetired: v29(
      "jitTraceRecordedRetired",
      "recorded trace retired instructions",
    ),
    jitTraceSelectedRoots: v29("jitTraceSelectedRoots", "selected trace roots"),
    jitTraceReadSiteVisits: v29("jitTraceReadSiteVisits", "trace read-site visits"),
    jitTraceReadFirstVisits: v29("jitTraceReadFirstVisits", "trace first read visits"),
    jitTraceReadReuses: v29("jitTraceReadReuses", "trace read translation reuses"),
    jitTraceReadPageChanges: v29("jitTraceReadPageChanges", "trace read page changes"),
    jitTraceReadRefreshes: v29("jitTraceReadRefreshes", "trace read translation refreshes"),
    jitTraceReadUnsafe: v29("jitTraceReadUnsafe", "trace unsafe reads"),
    jitTraceWriteSiteVisits: v29("jitTraceWriteSiteVisits", "trace write-site visits"),
    jitTraceWriteFirstVisits: v29("jitTraceWriteFirstVisits", "trace first write visits"),
    jitTraceWriteReuses: v29("jitTraceWriteReuses", "trace write translation reuses"),
    jitTraceWritePageChanges: v29("jitTraceWritePageChanges", "trace write page changes"),
    jitTraceWriteRefreshes: v29("jitTraceWriteRefreshes", "trace write translation refreshes"),
    jitTraceWriteUnsafe: v29("jitTraceWriteUnsafe", "trace unsafe writes"),
    workload:
      schemaVersion >= 19
        ? decodeCoreWorkloadProfile(
            profile["workload"],
            enabled,
            schemaVersion,
          )
        : emptyCoreWorkloadProfile(),
  };
}

function decodeRuntimeRecordVersion(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): CoreRuntimeProfile["recordVersion"] {
  // Traces before schema 28 accepted any record up to 14 here; the snapshot checks the exact one.
  const maximum = schemaVersion >= 28 ? coreRecordVersionForTrace(schemaVersion) : 14;
  const decoded = integer(value, "core runtime profile record version", 9, maximum);
  if (
    decoded === 9 || decoded === 10 || decoded === 11 || decoded === 12
    || decoded === 13 || decoded === 14 || decoded === 15 || decoded === 16
    || decoded === 17 || decoded === 18 || decoded === 19 || decoded === 20 || decoded === 21
    || decoded === 22 || decoded === 23 || decoded === 24 || decoded === 25 || decoded === 26 || decoded === 27 || decoded === 28 || decoded === 29 || decoded === 30 || decoded === 31
  ) return decoded;
  throw new TypeError("core runtime profile record version is unsupported");
}
