import { CORE_JIT_REUSE_KEYS, jitReuseFromValues } from "../protocol/core-jit-reuse.js";
import { CoreAbiError } from "../core-abi.ts";
import { decodeCodeSegmentContext, type CodeSegmentContext } from "../protocol/code-segment-context.ts";
import {
  CORE_JIT_DEFERRAL_KEYS,
  jitDeferralFromValues,
  jitDeferralReconciles,
} from "../protocol/core-jit-deferral.ts";
import {
  CORE_TRANSLATION_COHERENCE_KEYS,
  CORE_TRANSLATION_COHERENCE_RECORD_KEYS,
  translationCoherenceFromValues,
  translationCoherenceReconciles,
} from "../protocol/core-translation-coherence.ts";
import type {
  CoreCacheConflictProfile,
  CoreInstructionSiteProfile,
  CoreJitAdmissionSiteProfile,
  CoreRuntimeProfile,
  CoreWorkloadProfile,
} from "../protocol.js";

const MAGIC = [0x4f, 0x58, 0x50, 0x44] as const;
const HEADER_LENGTH = 12;
const LEGACY_CORE_FIELD_COUNT = 87;
const CORE_FIELD_COUNT_V11 = 110;
const CORE_FIELD_COUNT_V12 = 114;
const CORE_FIELD_COUNT_V13 = 116;
const CORE_FIELD_COUNT_V14 = 119;
const CORE_FIELD_COUNT_V15 = 126;
const CORE_FIELD_COUNT_V16 = 179;
const CORE_FIELD_COUNT_V18 = 195;
const CORE_FIELD_COUNT_V19 = 198;
const CORE_FIELD_COUNT_V20 = 207;
const CORE_FIELD_COUNT_V21 = 210;
const CORE_FIELD_COUNT_V22 = 236;
const CORE_FIELD_COUNT_V23 = 237;
const CORE_FIELD_COUNT_V24 = 238;
const CORE_FIELD_COUNT_V25 = 239;
const CORE_FIELD_COUNT_V28 = 240;
const CORE_FIELD_COUNT_V29 = 258;
const CORE_FIELD_COUNT_V30 = 259;
const CORE_FIELD_COUNT_V31 = 287;
const LEGACY_WORKLOAD_HEADER_LENGTH = 64;
const WORKLOAD_HEADER_LENGTH_V11 = 80;
const WORKLOAD_HEADER_LENGTH_V12 = 96;
const SITE_RECORD_LENGTH_V9 = 72;
const SITE_RECORD_LENGTH_V10 = 80;
const SITE_RECORD_LENGTH_V27 = 96;
const ADMISSION_RECORD_LENGTH = 56;
const ADMISSION_RECORD_LENGTH_V27 = 72;
const CACHE_CONFLICT_RECORD_LENGTH = 32;
const CACHE_CONFLICT_RECORD_LENGTH_V12 = 88;
const MAX_SEMANTICS = 4_096;
const MAX_SITES = 65_536;
const MAX_ADMISSION_SITES = 65_536;
const MAX_CACHE_CONFLICTS = 4_096;

export function decodeCoreRuntimeProfile(
  bytes: Uint8Array,
): CoreRuntimeProfile {
  if (bytes.byteLength < HEADER_LENGTH) {
    throw fault("runtime profile has an invalid length");
  }
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  if (MAGIC.some((byte, index) => view.getUint8(index) !== byte)) {
    throw fault("runtime profile has invalid magic");
  }
  const recordVersion = view.getUint16(4, true);
  if (!isRecordVersion(recordVersion)) {
    throw fault("unsupported runtime profile version");
  }
  if (view.getUint16(6, true) !== 0) {
    throw fault("runtime profile has a nonzero reserved header");
  }
  if (view.getUint32(8, true) !== bytes.byteLength - HEADER_LENGTH) {
    throw fault("runtime profile has an invalid payload length");
  }
  const corePayloadLength = (
    recordVersion >= 31
      ? CORE_FIELD_COUNT_V31
      : recordVersion >= 30
      ? CORE_FIELD_COUNT_V30
      : recordVersion >= 29
      ? CORE_FIELD_COUNT_V29
      : recordVersion >= 28
      ? CORE_FIELD_COUNT_V28
      : recordVersion >= 25
      ? CORE_FIELD_COUNT_V25
      : recordVersion >= 24
      ? CORE_FIELD_COUNT_V24
      : recordVersion >= 23
      ? CORE_FIELD_COUNT_V23
      : recordVersion >= 22
      ? CORE_FIELD_COUNT_V22
      : recordVersion >= 21
      ? CORE_FIELD_COUNT_V21
      : recordVersion >= 20
      ? CORE_FIELD_COUNT_V20
      : recordVersion >= 19
      ? CORE_FIELD_COUNT_V19
      : recordVersion >= 18
      ? CORE_FIELD_COUNT_V18
      : recordVersion >= 16
      ? CORE_FIELD_COUNT_V16
      : recordVersion === 15
      ? CORE_FIELD_COUNT_V15
      : recordVersion === 14
      ? CORE_FIELD_COUNT_V14
      : recordVersion === 13
      ? CORE_FIELD_COUNT_V13
      : recordVersion === 12
      ? CORE_FIELD_COUNT_V12
      : recordVersion === 11
        ? CORE_FIELD_COUNT_V11
        : LEGACY_CORE_FIELD_COUNT
  ) * 8;
  const workloadHeaderLength = recordVersion >= 12
    ? WORKLOAD_HEADER_LENGTH_V12
    : recordVersion === 11
      ? WORKLOAD_HEADER_LENGTH_V11
      : LEGACY_WORKLOAD_HEADER_LENGTH;
  if (
    bytes.byteLength < HEADER_LENGTH + corePayloadLength + workloadHeaderLength
  ) {
    throw fault("runtime profile has an invalid length");
  }
  const field = (index: number) =>
    view.getBigUint64(HEADER_LENGTH + index * 8, true);
  const enabled = field(0);
  if (enabled !== 0n && enabled !== 1n) {
    throw fault("runtime profile has an invalid enabled flag");
  }
  const decoded: CoreRuntimeProfile = {
    ...jitReuseFromValues(recordVersion >= 31 ? CORE_JIT_REUSE_KEYS.map((_, index) => field(CORE_FIELD_COUNT_V30 + index)) : []),
    // Record v22 holds the coherence block at fields 210-235; v23 appends field 236.
    ...translationCoherenceFromValues(
      CORE_TRANSLATION_COHERENCE_RECORD_KEYS.slice(
        0,
        recordVersion >= 25
          ? 28
          : recordVersion >= 23
          ? CORE_TRANSLATION_COHERENCE_KEYS.length + 1
          : recordVersion >= 22
            ? CORE_TRANSLATION_COHERENCE_KEYS.length
            : 0,
      ).map((_, index) => field(CORE_FIELD_COUNT_V21 + index + Number(index >= 27))).concat(recordVersion >= 30 ? [field(CORE_FIELD_COUNT_V29)] : []),
    ),
    // The combined record appends Tier-1 deferral after the ISA fields.
    ...jitDeferralFromValues(
      recordVersion >= 29
        ? CORE_JIT_DEFERRAL_KEYS.map((_, index) => field(CORE_FIELD_COUNT_V28 + index))
        : [],
    ),
    recordVersion,
    enabled: enabled === 1n,
    decodeCacheHits: field(1),
    decodeCacheMisses: field(2),
    decodeCacheEmpty: field(3),
    decodeCacheTagMismatches: field(4),
    decodeMappingFastHits: field(5),
    decodeMappingRevalidations: field(6),
    decodeMappingMismatches: field(7),
    decodeGenerationFastHits: field(8),
    decodeGenerationChecks: field(9),
    decodeGenerationMismatches: field(10),
    decodedBytes: field(11),
    tlbHits: field(12),
    tlbMisses: field(13),
    tlbProbeHits: field(14),
    tlbProbeMisses: field(15),
    jitChainAttempts: field(16),
    jitChainHits: field(17),
    jitChainMissingCoverage: field(18),
    jitChainMissingCache: field(19),
    jitChainMissingDispatchSlot: field(20),
    jitChainMissingEntry: field(21),
    jitChainInvalidCode: field(22),
    jitChainContextFailures: field(23),
    jitCodeWritePages: field(24),
    jitCodeWriteInvalidations: field(25),
    jitCacheReplacements: field(26),
    jitCacheCapacityEvictions: field(27),
    jitDispatchSlotRebindings: field(28),
    jitAdmissionChecks: field(29),
    jitAdmissionRejections: field(30),
    jitCandidatePrepareFailures: field(31),
    jitCandidateBlocked: field(32),
    jitCandidateEmitFailures: field(33),
    jitCandidateCompiles: field(34),
    jitCacheReuseHits: field(35),
    jitCacheReusedTranslations: field(36),
    jitCacheEightHitTranslations: field(37),
    jitCacheThirtyTwoHitTranslations: field(38),
    jitChainCoverageTargets: field(39),
    jitChainCoverageEightMissTargets: field(40),
    jitChainCoverageThirtyTwoMissTargets: field(41),
    jitChainCoverageSixtyFourMissTargets: field(42),
    jitChainCoverageAdmissionResets: field(43),
    jitChainCoverageAdmissionResetTargets: field(44),
    decodeMappingInvalidationChanges: field(45),
    decodeMappingCr3Changes: field(46),
    decodeMappingPolicyChanges: field(47),
    tlbInvlpg: field(48),
    tlbInvpcidIndividual: field(49),
    tlbInvpcidSingleContext: field(50),
    tlbInvpcidAllNonGlobal: field(51),
    tlbInvpcidAll: field(52),
    jitResidentTierLoopCalls: field(53),
    jitBlockObservations: field(54),
    jitColdBlockExecutions: field(55),
    jitHotBlockTransitions: field(56),
    jitHotBoundaryStops: field(57),
    jitPartialBudgetFallbacks: field(58),
    jitMemoryReads: field(59),
    jitMemoryPreflightWrites: field(60),
    jitMemoryStageWrites: field(61),
    jitMemoryWrites: field(62),
    jitMemoryDirectPreflightWrites: field(63),
    jitReadCacheMissCrossPage: field(64),
    jitReadCacheMissTag: field(65),
    jitReadCacheMissEpoch: field(66),
    jitReadCacheMissUnexplained: field(67),
    jitReadCacheMissPendingWrites: recordVersion >= 28 ? field(239) : 0n,
    jitWriteCacheMissCrossPage: field(68),
    jitWriteCacheMissTag: field(69),
    jitWriteCacheMissEpoch: field(70),
    jitWriteCacheMissPendingWrites: field(71),
    jitWriteCacheMissUnexplained: field(72),
    jitDispatchMissTag: field(73),
    jitDispatchMissEpoch: field(74),
    jitDispatchMissTargetSlot: field(75),
    jitDispatchMissActiveSlot: field(76),
    jitDispatchMissPendingWrites: field(77),
    jitDispatchMissInterruptShadow: field(78),
    jitDispatchMissAddressSpace: recordVersion >= 17 ? field(79) : 0n,
    jitDispatchMissCr3: recordVersion <= 16 ? field(79) : 0n,
    jitDispatchMissCpl: field(80),
    jitDispatchMissUnexplained: field(81),
    jitDispatchMissEmpty: field(82),
    jitDispatchEpochInvalidations: field(83),
    jitDispatchFullInvalidations: field(84),
    jitDispatchPageInvalidations: field(85),
    jitDispatchPageSlotsCleared: field(86),
    jitRegionCandidates: recordVersion >= 11 ? field(87) : 0n,
    jitRegionDiscoveredPages: recordVersion >= 11 ? field(88) : 0n,
    jitRegionDiscoveredBlocks: recordVersion >= 11 ? field(89) : 0n,
    jitRegionDiscoveredInstructions: recordVersion >= 11 ? field(90) : 0n,
    jitRegionReadyPages: recordVersion >= 11 ? field(91) : 0n,
    jitRegionReadyBlocks: recordVersion >= 11 ? field(92) : 0n,
    jitRegionReadyInstructions: recordVersion >= 11 ? field(93) : 0n,
    jitRegionUncoveredPages: recordVersion >= 11 ? field(94) : 0n,
    jitRegionUncoveredBlocks: recordVersion >= 11 ? field(95) : 0n,
    jitRegionUncoveredInstructions: recordVersion >= 11 ? field(96) : 0n,
    jitRegionStopInstructionLimit: recordVersion >= 11 ? field(97) : 0n,
    jitRegionStopBlockLimit: recordVersion >= 11 ? field(98) : 0n,
    jitRegionStopPageLimit: recordVersion >= 11 ? field(99) : 0n,
    jitRegionStopDecodeOrLowering: recordVersion >= 11 ? field(100) : 0n,
    jitRegionStopSuccessorNotReady: recordVersion >= 11 ? field(101) : 0n,
    jitRegionStopAlreadyCovered: recordVersion >= 11 ? field(102) : 0n,
    jitRegionStopIndirectOrHostExit: recordVersion >= 11 ? field(103) : 0n,
    jitRegionStopArchitecturalEventBoundary: recordVersion >= 24 ? field(237) : 0n,
    jitAdmissionEvictedCold: recordVersion >= 11 ? field(104) : 0n,
    jitAdmissionEvictedHot: recordVersion >= 11 ? field(105) : 0n,
    jitAdmissionEvictedBlocked: recordVersion >= 11 ? field(106) : 0n,
    jitAdmissionArbitraryFallbacks: recordVersion >= 11 ? field(107) : 0n,
    jitAdmissionIdentityChanges: recordVersion >= 11 ? field(108) : 0n,
    jitAdmissionDroppedIdentityObservations: recordVersion >= 11 ? field(109) : 0n,
    jitReadCacheHits: recordVersion >= 12 ? field(110) : 0n,
    jitWriteCacheHits: recordVersion >= 12 ? field(111) : 0n,
    jitDispatchSlotClearEntriesScanned: recordVersion >= 12 ? field(112) : 0n,
    jitDispatchSlotClearEntriesCleared: recordVersion >= 12 ? field(113) : 0n,
    jitReadVictimHits: recordVersion >= 13 ? field(114) : 0n,
    jitWriteVictimHits: recordVersion >= 13 ? field(115) : 0n,
    jitRmwEligible: recordVersion >= 14 ? field(116) : 0n,
    jitRmwReadReuses: recordVersion >= 14 ? field(117) : 0n,
    jitRmwWriteReuses: recordVersion >= 14 ? field(118) : 0n,
    jitTailChainTransitions: recordVersion >= 15 ? field(119) : 0n,
    jitTier2Eligible: recordVersion >= 15 ? field(120) : 0n,
    jitTier2PromotionAttempts: recordVersion >= 15 ? field(121) : 0n,
    jitTier2Compiles: recordVersion >= 15 ? field(122) : 0n,
    jitTier2Failures: recordVersion >= 15 ? field(123) : 0n,
    jitTier2CompiledInstructions: recordVersion >= 15 ? field(124) : 0n,
    jitTier2ExecutionEntries: recordVersion >= 15 ? field(125) : 0n,
    jitTier2FailureMachineUnavailable: recordVersion >= 16 ? field(126) : 0n,
    jitTier2FailureWriteTracking: recordVersion >= 16 ? field(127) : 0n,
    jitTier2FailureUnsupportedCpuContext: recordVersion >= 16 ? field(128) : 0n,
    jitTier2FailureDecodeOrTranslationFault: recordVersion >= 16 ? field(129) : 0n,
    jitTier2FailureQuarantinedSemantic: recordVersion >= 16 ? field(130) : 0n,
    jitTier2FailureUnsupportedSemantic: recordVersion >= 16 ? field(131) : 0n,
    jitTier2FailureUnsupportedForm: recordVersion >= 16 ? field(132) : 0n,
    jitTier2FailureEmission: recordVersion >= 16 ? field(133) : 0n,
    jitTier2FailureModuleSizeLimit: recordVersion >= 16 ? field(134) : 0n,
    jitTier2FailureCandidateLimit: recordVersion >= 16 ? field(135) : 0n,
    jitTraceReadSiteVisits: recordVersion >= 16 ? field(136) : 0n,
    jitTraceReadFirstVisits: recordVersion >= 16 ? field(137) : 0n,
    jitTraceReadReuses: recordVersion >= 16 ? field(138) : 0n,
    jitTraceReadPageChanges: recordVersion >= 16 ? field(139) : 0n,
    jitTraceReadRefreshes: recordVersion >= 16 ? field(140) : 0n,
    jitTraceReadUnsafe: recordVersion >= 16 ? field(141) : 0n,
    jitTraceWriteSiteVisits: recordVersion >= 16 ? field(142) : 0n,
    jitTraceWriteFirstVisits: recordVersion >= 16 ? field(143) : 0n,
    jitTraceWriteReuses: recordVersion >= 16 ? field(144) : 0n,
    jitTraceWritePageChanges: recordVersion >= 16 ? field(145) : 0n,
    jitTraceWriteRefreshes: recordVersion >= 16 ? field(146) : 0n,
    jitTraceWriteUnsafe: recordVersion >= 16 ? field(147) : 0n,
    jitTier2FailureStaleProfile: recordVersion >= 16 ? field(148) : 0n,
    jitTier2FailureIneligibleTrace: recordVersion >= 16 ? field(149) : 0n,
    jitTier2FailureResidentBudget: recordVersion >= 16 ? field(150) : 0n,
    jitTraceRecordingWindows: recordVersion >= 16 ? field(151) : 0n,
    jitTraceRecordedEdges: recordVersion >= 16 ? field(152) : 0n,
    jitTraceAcceptedEdges: recordVersion >= 16 ? field(153) : 0n,
    jitTraceStaleEdges: recordVersion >= 16 ? field(154) : 0n,
    jitTraceDroppedEdges: recordVersion >= 16 ? field(155) : 0n,
    jitTraceRecordedRetired: recordVersion >= 16 ? field(156) : 0n,
    jitTraceSelectedRoots: recordVersion >= 16 ? field(157) : 0n,
    jitTier2FailureNoRegion: recordVersion >= 16 ? field(158) : 0n,
    jitTier2FailureNoEligibleEdges: recordVersion >= 16 ? field(159) : 0n,
    jitTier2FailureInsufficientInternalization: recordVersion >= 16
      ? field(160)
      : 0n,
    jitTier2FailureNoRecurrentComponent: recordVersion >= 16 ? field(161) : 0n,
    jitTier1Retired: recordVersion >= 16 ? field(162) : 0n,
    jitTier2Retired: recordVersion >= 16 ? field(163) : 0n,
    jitTraceReadIneligible: recordVersion >= 16 ? field(164) : 0n,
    jitTraceWriteIneligible: recordVersion >= 16 ? field(165) : 0n,
    jitTraceInternalEdges: recordVersion >= 16 ? field(166) : 0n,
    jitTraceExternalEdges: recordVersion >= 16 ? field(167) : 0n,
    jitTraceCurrentStateOps: recordVersion >= 16 ? field(168) : 0n,
    jitTraceProposedStateOps: recordVersion >= 16 ? field(169) : 0n,
    jitTraceCurrentFlagOps: recordVersion >= 16 ? field(170) : 0n,
    jitTraceProposedFlagOps: recordVersion >= 16 ? field(171) : 0n,
    jitTraceCurrentMaterializations: recordVersion >= 16 ? field(172) : 0n,
    jitTraceProposedMaterializations: recordVersion >= 16 ? field(173) : 0n,
    jitTraceAddedGuards: recordVersion >= 16 ? field(174) : 0n,
    jitTier1Ring0Retired: recordVersion >= 16 ? field(175) : 0n,
    jitTier1Ring3Retired: recordVersion >= 16 ? field(176) : 0n,
    jitTier2Ring0Retired: recordVersion >= 16 ? field(177) : 0n,
    jitTier2Ring3Retired: recordVersion >= 16 ? field(178) : 0n,
    jitResidentAdapterCompletions: recordVersion >= 18 ? field(179) : 0n,
    jitAdapterExitsReturned: recordVersion >= 18 ? field(180) : 0n,
    jitResidentTaskSwitches: recordVersion >= 18 ? field(181) : 0n,
    jitResidentZeroRetirementExhaustions: recordVersion >= 18 ? field(182) : 0n,
    jitResidentHostWaitExits: recordVersion >= 18 ? field(183) : 0n,
    jitDispatchRebindSameModuleCrossAddressSpace: recordVersion >= 18 ? field(184) : 0n,
    jitDispatchRebindDifferentModule: recordVersion >= 18 ? field(185) : 0n,
    jitDispatchRebindSameAddressSpace: recordVersion >= 18 ? field(186) : 0n,
    jitBindingInvalidationsUnregister: recordVersion >= 18 ? field(187) : 0n,
    jitBindingInvalidationsEviction: recordVersion >= 18 ? field(188) : 0n,
    jitBindingInvalidationsReplacement: recordVersion >= 18 ? field(189) : 0n,
    jitActiveBindings: recordVersion >= 18 ? field(190) : 0n,
    jitActiveArtifacts: recordVersion >= 18 ? field(191) : 0n,
    jitActiveAddressSpaces: recordVersion >= 18 ? field(192) : 0n,
    jitAliasBindings: recordVersion >= 18 ? field(193) : 0n,
    jitAliasReuses: recordVersion >= 18 ? field(194) : 0n,
    jitCacheBindingBytes: recordVersion >= 19 ? field(195) : 0n,
    jitCacheArtifactBytes: recordVersion >= 19 ? field(196) : 0n,
    jitCacheTotalBytes: recordVersion >= 19 ? field(197) : 0n,
    jitAotLookups: recordVersion >= 20 ? field(198) : 0n,
    jitAotMatches: recordVersion >= 20 ? field(199) : 0n,
    jitAotAmbiguous: recordVersion >= 20 ? field(200) : 0n,
    jitAotDeclines: recordVersion >= 20 ? field(201) : 0n,
    jitAotRegistrations: recordVersion >= 20 ? field(202) : 0n,
    jitAotRegistrationRejections: recordVersion >= 20 ? field(203) : 0n,
    jitAotDispatches: recordVersion >= 20 ? field(204) : 0n,
    jitAotRetired: recordVersion >= 20 ? field(205) : 0n,
    jitAotDynamicCompilesAvoided: recordVersion >= 20 ? field(206) : 0n,
    syscallCpuClones: recordVersion >= 21 ? field(207) : 0n,
    sysretCpuClones: recordVersion >= 21 ? field(208) : 0n,
    replacementCommitCpuClones: recordVersion >= 21 ? field(209) : 0n,
    workload: decodeWorkloadProfile(
      view,
      enabled === 1n,
      recordVersion,
      corePayloadLength,
    ),
  };
  if (recordVersion >= 22 && !translationCoherenceReconciles(decoded)) {
    throw fault("runtime translation coherence counters do not reconcile");
  }
  if (recordVersion >= 29 && !jitDeferralReconciles(decoded)) {
    throw fault("runtime JIT deferral counters do not reconcile");
  }
  if (
    recordVersion >= 16 &&
    (decoded.jitTier1Retired !==
      decoded.jitTier1Ring0Retired + decoded.jitTier1Ring3Retired ||
      decoded.jitTier2Retired !==
        decoded.jitTier2Ring0Retired + decoded.jitTier2Ring3Retired)
  ) {
    throw fault("runtime Tier-retirement privilege counters do not reconcile");
  }
  if (
    recordVersion >= 16 &&
    decoded.jitTier2Failures !==
      decoded.jitTier2FailureMachineUnavailable +
        decoded.jitTier2FailureWriteTracking +
        decoded.jitTier2FailureUnsupportedCpuContext +
        decoded.jitTier2FailureDecodeOrTranslationFault +
        decoded.jitTier2FailureQuarantinedSemantic +
        decoded.jitTier2FailureUnsupportedSemantic +
        decoded.jitTier2FailureUnsupportedForm +
        decoded.jitTier2FailureEmission +
        decoded.jitTier2FailureModuleSizeLimit +
        decoded.jitTier2FailureCandidateLimit +
        decoded.jitTier2FailureStaleProfile +
        decoded.jitTier2FailureIneligibleTrace +
        decoded.jitTier2FailureResidentBudget +
        decoded.jitTier2FailureNoRegion +
        decoded.jitTier2FailureNoEligibleEdges +
        decoded.jitTier2FailureInsufficientInternalization +
        decoded.jitTier2FailureNoRecurrentComponent
  ) {
    throw fault("runtime Tier-2 failure counters do not agree");
  }
  if (
    recordVersion >= 16 &&
    decoded.jitTraceRecordedEdges !==
      decoded.jitTraceAcceptedEdges +
        decoded.jitTraceStaleEdges +
        decoded.jitTraceDroppedEdges
  ) {
    throw fault("runtime trace-recording edge counters do not agree");
  }
  if (
    recordVersion >= 16 &&
    (decoded.jitTraceReadSiteVisits !==
        decoded.jitTraceReadReuses +
          decoded.jitTraceReadRefreshes +
          decoded.jitTraceReadIneligible ||
      decoded.jitTraceWriteSiteVisits !==
        decoded.jitTraceWriteReuses +
          decoded.jitTraceWriteRefreshes +
          decoded.jitTraceWriteIneligible ||
      decoded.jitTraceReadFirstVisits >
        decoded.jitTraceReadRefreshes + decoded.jitTraceReadIneligible ||
      decoded.jitTraceReadPageChanges >
        decoded.jitTraceReadRefreshes + decoded.jitTraceReadIneligible ||
      decoded.jitTraceReadUnsafe > decoded.jitTraceReadRefreshes ||
      decoded.jitTraceWriteFirstVisits >
        decoded.jitTraceWriteRefreshes + decoded.jitTraceWriteIneligible ||
      decoded.jitTraceWritePageChanges >
        decoded.jitTraceWriteRefreshes + decoded.jitTraceWriteIneligible ||
      decoded.jitTraceWriteUnsafe > decoded.jitTraceWriteRefreshes)
  ) {
    throw fault("runtime Tier-2 trace-memory counters do not agree");
  }
  if (
    recordVersion >= 18 &&
    (decoded.jitDispatchSlotRebindings !==
        decoded.jitDispatchRebindSameModuleCrossAddressSpace +
          decoded.jitDispatchRebindDifferentModule +
          decoded.jitDispatchRebindSameAddressSpace ||
      decoded.jitAliasBindings > decoded.jitActiveBindings ||
      decoded.jitActiveArtifacts > decoded.jitActiveBindings ||
      decoded.jitActiveAddressSpaces > decoded.jitActiveBindings ||
      decoded.jitResidentHostWaitExits > decoded.jitResidentAdapterCompletions)
  ) {
    throw fault("runtime resident/JIT binding counters do not agree");
  }
  if (
    recordVersion >= 19 &&
    decoded.jitCacheBindingBytes + decoded.jitCacheArtifactBytes !==
      decoded.jitCacheTotalBytes
  ) {
    throw fault("runtime JIT cache byte counters do not agree");
  }
  if (
    recordVersion >= 20 &&
    (decoded.jitAotMatches + decoded.jitAotAmbiguous > decoded.jitAotLookups
      || decoded.jitAotRegistrations + decoded.jitAotDeclines > decoded.jitAotMatches
      || decoded.jitAotDynamicCompilesAvoided !== decoded.jitAotRegistrations
      || decoded.jitAotDispatches === 0n && decoded.jitAotRetired !== 0n
      || decoded.jitAotDispatches !== 0n && decoded.jitAotRetired < decoded.jitAotDispatches)
  ) {
    throw fault("runtime AOT counters do not agree");
  }
  return decoded;
}

function isRecordVersion(value: number): value is CoreRuntimeProfile["recordVersion"] {
  return value >= 9 && value <= 31;
}

function decodeCodeSegment(view: DataView, offset: number, version: number, mode: number): CodeSegmentContext {
  if (version < 27) return { codeSegmentBase: null, codeSegmentLimit: null };
  if (view.getUint32(offset + 12, true) !== 0) throw fault("code-segment identity has nonzero reserved bytes");
  try {
    return decodeCodeSegmentContext(view.getBigUint64(offset, true), view.getUint32(offset + 8, true), mode === 3, true);
  } catch {
    throw fault("runtime workload code-segment identity is invalid");
  }
}

function decodeWorkloadProfile(
  view: DataView,
  enabled: boolean,
  recordVersion: CoreRuntimeProfile["recordVersion"],
  corePayloadLength: number,
): CoreWorkloadProfile {
  const start = HEADER_LENGTH + corePayloadLength;
  const semanticCount = view.getUint32(start, true);
  const siteCount = view.getUint32(start + 4, true);
  const admissionCount = view.getUint32(start + 8, true);
  const siteCapacity = view.getUint32(start + 12, true);
  const cacheConflictCount = recordVersion >= 11
    ? view.getUint32(start + 64, true)
    : 0;
  const cacheConflictCapacity = recordVersion >= 11
    ? view.getUint32(start + 68, true)
    : 0;
  const droppedCacheConflicts = recordVersion >= 11
    ? view.getBigUint64(start + 72, true)
    : 0n;
  const cacheConflictSamplePeriod = recordVersion >= 12
    ? safeInteger(
        view.getBigUint64(start + 80, true),
        "runtime cache-conflict sample period",
      )
    : recordVersion === 11
      ? 1
      : 0;
  const declaredCacheConflictSamples = recordVersion >= 12
    ? view.getBigUint64(start + 88, true)
    : null;
  if (
    semanticCount > MAX_SEMANTICS ||
    siteCount > MAX_SITES ||
    admissionCount > MAX_ADMISSION_SITES ||
    siteCapacity > MAX_SITES ||
    siteCount > siteCapacity ||
    cacheConflictCount > MAX_CACHE_CONFLICTS ||
    cacheConflictCapacity > MAX_CACHE_CONFLICTS ||
    cacheConflictCount > cacheConflictCapacity
  ) {
    throw fault("runtime workload profile exceeds its bounds");
  }
  const expectedLength =
    HEADER_LENGTH +
    corePayloadLength +
    (recordVersion >= 12
      ? WORKLOAD_HEADER_LENGTH_V12
      : recordVersion === 11
        ? WORKLOAD_HEADER_LENGTH_V11
        : LEGACY_WORKLOAD_HEADER_LENGTH) +
    semanticCount * 16 +
    siteCount * (recordVersion >= 27 ? SITE_RECORD_LENGTH_V27 : recordVersion === 9 ? SITE_RECORD_LENGTH_V9 : SITE_RECORD_LENGTH_V10) +
    admissionCount * (recordVersion >= 27 ? ADMISSION_RECORD_LENGTH_V27 : ADMISSION_RECORD_LENGTH) +
    cacheConflictCount * (recordVersion >= 12
      ? CACHE_CONFLICT_RECORD_LENGTH_V12
      : CACHE_CONFLICT_RECORD_LENGTH);
  if (view.byteLength !== expectedLength) {
    throw fault("runtime workload profile has an invalid length");
  }
  const samplePeriod = safeInteger(
    view.getBigUint64(start + 16, true),
    "runtime workload sample period",
  );
  const instructionAttempts = view.getBigUint64(start + 24, true);
  const instructionCommits = view.getBigUint64(start + 32, true);
  const siteSamples = view.getBigUint64(start + 40, true);
  const droppedSiteSamples = view.getBigUint64(start + 48, true);
  const unmappedAdmissionSites = view.getBigUint64(start + 56, true);
  if (instructionCommits > instructionAttempts) {
    throw fault("runtime workload commit counters do not agree");
  }
  if (
    !enabled &&
    (semanticCount !== 0 ||
      siteCount !== 0 ||
      admissionCount !== 0 ||
      samplePeriod !== 0 ||
      instructionAttempts !== 0n ||
      instructionCommits !== 0n ||
      siteSamples !== 0n ||
      droppedSiteSamples !== 0n ||
      unmappedAdmissionSites !== 0n)
  ) {
    throw fault("disabled runtime workload profile is not empty");
  }
  if (enabled && (semanticCount === 0 || samplePeriod === 0)) {
    throw fault("enabled runtime workload profile is incomplete");
  }

  if (
    !enabled &&
    (cacheConflictCount !== 0 ||
      cacheConflictSamplePeriod !== 0 ||
      declaredCacheConflictSamples !== null && declaredCacheConflictSamples !== 0n ||
      droppedCacheConflicts !== 0n)
  ) {
    throw fault("disabled runtime cache-conflict profile is not empty");
  }
  if (enabled && recordVersion >= 12 && cacheConflictSamplePeriod === 0) {
    throw fault("enabled runtime cache-conflict profile is incomplete");
  }

  let offset = start + (recordVersion >= 12
    ? WORKLOAD_HEADER_LENGTH_V12
    : recordVersion === 11
      ? WORKLOAD_HEADER_LENGTH_V11
      : LEGACY_WORKLOAD_HEADER_LENGTH);
  const semanticAttempts = Array.from({ length: semanticCount }, () => {
    const value = view.getBigUint64(offset, true);
    offset += 8;
    return value;
  });
  const semanticCommits = Array.from({ length: semanticCount }, () => {
    const value = view.getBigUint64(offset, true);
    offset += 8;
    return value;
  });
  let totalAttempts = 0n;
  let totalCommits = 0n;
  for (let index = 0; index < semanticCount; index += 1) {
    const attempts = semanticAttempts[index] ?? 0n;
    const commits = semanticCommits[index] ?? 0n;
    if (commits > attempts) {
      throw fault("runtime workload semantic counters do not agree");
    }
    totalAttempts += attempts;
    totalCommits += commits;
  }
  if (
    totalAttempts !== instructionAttempts ||
    totalCommits !== instructionCommits
  ) {
    throw fault("runtime workload totals do not agree");
  }

  const sites: CoreInstructionSiteProfile[] = [];
  let retainedSiteSamples = 0n;
  for (let index = 0; index < siteCount; index += 1) {
    const site = decodeInstructionSite(view, offset, semanticCount, recordVersion);
    sites.push(site);
    retainedSiteSamples += site.samples;
    offset += recordVersion >= 27 ? SITE_RECORD_LENGTH_V27 : recordVersion === 9 ? SITE_RECORD_LENGTH_V9 : SITE_RECORD_LENGTH_V10;
  }
  if (retainedSiteSamples + droppedSiteSamples !== siteSamples) {
    throw fault("runtime workload site counters do not agree");
  }

  const admissionSites: CoreJitAdmissionSiteProfile[] = [];
  for (let index = 0; index < admissionCount; index += 1) {
    admissionSites.push(decodeAdmissionSite(view, offset, recordVersion));
    offset += recordVersion >= 27 ? ADMISSION_RECORD_LENGTH_V27 : ADMISSION_RECORD_LENGTH;
  }
  const cacheConflicts: CoreCacheConflictProfile[] = [];
  let retainedCacheConflictSamples = 0n;
  for (let index = 0; index < cacheConflictCount; index += 1) {
    const conflict = decodeCacheConflict(view, offset, recordVersion);
    cacheConflicts.push(conflict);
    retainedCacheConflictSamples += conflict.sampledConflicts;
    offset += recordVersion >= 12
      ? CACHE_CONFLICT_RECORD_LENGTH_V12
      : CACHE_CONFLICT_RECORD_LENGTH;
  }
  const cacheConflictSamples = declaredCacheConflictSamples ??
    retainedCacheConflictSamples + droppedCacheConflicts;
  if (retainedCacheConflictSamples + droppedCacheConflicts !== cacheConflictSamples) {
    throw fault(
      `runtime cache-conflict counters do not agree: retained=${retainedCacheConflictSamples.toString()}, dropped=${droppedCacheConflicts.toString()}, declared=${cacheConflictSamples.toString()}`,
    );
  }
  return {
    samplePeriod,
    instructionAttempts,
    instructionCommits,
    siteSamples,
    droppedSiteSamples,
    unmappedAdmissionSites,
    semanticAttempts,
    semanticCommits,
    sites,
    admissionSites,
    cacheConflictCapacity,
    cacheConflictSamplePeriod,
    cacheConflictSamples,
    droppedCacheConflicts,
    cacheConflicts,
  };
}

function decodeInstructionSite(
  view: DataView,
  offset: number,
  semanticCount: number,
  recordVersion: CoreRuntimeProfile["recordVersion"],
): CoreInstructionSiteProfile {
  const samples = view.getBigUint64(offset + 40, true);
  const committedSamples = view.getBigUint64(offset + 48, true);
  const entryOffset = view.getUint16(offset + 56, true);
  const semantic = view.getUint32(offset + 60, true);
  const firstAttempt = view.getBigUint64(offset + 24, true);
  const lastAttempt = view.getBigUint64(offset + 32, true);
  if (
    samples === 0n ||
    committedSamples > samples ||
    firstAttempt === 0n ||
    firstAttempt > lastAttempt ||
    entryOffset >= 0x1_000 ||
    semantic >= semanticCount ||
    (recordVersion >= 10
      ? view.getUint8(offset + 77) > (recordVersion >= 26 ? 1 : 0) || view.getUint8(offset + 78) !== 0 || view.getUint8(offset + 79) !== 0
      : view.getUint8(offset + 67) !== 0 || view.getUint32(offset + 68, true) !== 0)
  ) {
    throw fault("runtime workload instruction site is invalid");
  }
  const physicalFrame = view.getBigUint64(offset + 8, true);
  if ((physicalFrame & 0xfffn) !== 0n) {
    throw fault("runtime workload instruction frame is unaligned");
  }
  return {
    rip: view.getBigUint64(offset, true),
    physicalFrame,
    generation: view.getBigUint64(offset + 16, true),
    firstAttempt,
    lastAttempt,
    samples,
    committedSamples,
    entryOffset,
    codeAttributes: view.getUint16(offset + 58, true),
    ...decodeCodeSegment(view, offset + 80, recordVersion, view.getUint8(offset + (recordVersion >= 10 ? 66 : 64))),
    capabilityRevision: recordVersion >= 26 && view.getUint8(offset + 77) === 1 ? 1 : 0,
    semantic,
    instructionId: recordVersion >= 10 ? view.getUint16(offset + 64, true) : null,
    addressSpace: recordVersion >= 10 ? view.getBigUint64(offset + 69, true) : null,
    identityAvailability: recordVersion >= 10 ? "measured" : "unavailable:legacy-record",
    mode: mode(view.getUint8(offset + (recordVersion >= 10 ? 66 : 64))),
    cpl: cpl(view.getUint8(offset + (recordVersion >= 10 ? 67 : 65))),
    profile: cpuProfile(view.getUint8(offset + (recordVersion >= 10 ? 68 : 66))),
  };
}

function decodeCacheConflict(
  view: DataView,
  offset: number,
  recordVersion: CoreRuntimeProfile["recordVersion"],
): CoreCacheConflictProfile {
  const kind = view.getUint8(offset);
  if (![1, 2, 3].includes(kind)) {
    throw fault("runtime cache-conflict bucket is invalid");
  }
  const decodedKind = kind === 1 ? "dispatch" : kind === 2 ? "read" : "write";
  if (recordVersion < 12) {
    const identity = view.getBigUint64(offset + 8, true);
    const sampledConflicts = view.getBigUint64(offset + 24, true);
    if (
      Array.from({ length: 7 }, (_, index) => view.getUint8(offset + 1 + index))
        .some((value) => value !== 0) ||
      sampledConflicts === 0n
    ) {
      throw fault("runtime cache-conflict bucket is invalid");
    }
    return {
      kind: decodedKind,
      index: null,
      incomingTag: decodedKind === "dispatch" ? identity : identity >> 12n,
      displacedTag: null,
      addressSpace: view.getBigUint64(offset + 16, true),
      sampledConflicts,
      alternations: 0n,
      reuseDistance: emptyConflictDistanceBuckets(),
      pairAvailability: "unavailable:legacy-record",
    };
  }
  const index = view.getUint32(offset + 4, true);
  const sampledConflicts = view.getBigUint64(offset + 32, true);
  const alternations = view.getBigUint64(offset + 40, true);
  const reuseDistance = {
    "0-15": view.getBigUint64(offset + 48, true),
    "16-63": view.getBigUint64(offset + 56, true),
    "64-255": view.getBigUint64(offset + 64, true),
    "256-1023": view.getBigUint64(offset + 72, true),
    "1024+": view.getBigUint64(offset + 80, true),
  };
  const retainedReuseSamples = Object.values(reuseDistance).reduce(
    (total, count) => total + count,
    0n,
  );
  const capacity = 65_536;
  if (
    Array.from({ length: 3 }, (_, padding) => view.getUint8(offset + 1 + padding))
      .some((value) => value !== 0) ||
    index >= capacity ||
    sampledConflicts === 0n ||
    alternations > sampledConflicts ||
    retainedReuseSamples + 1n !== sampledConflicts
  ) {
    throw fault("runtime cache-conflict bucket is invalid");
  }
  return {
    kind: decodedKind,
    index,
    incomingTag: view.getBigUint64(offset + 8, true),
    displacedTag: view.getBigUint64(offset + 16, true),
    addressSpace: view.getBigUint64(offset + 24, true),
    sampledConflicts,
    alternations,
    reuseDistance,
    pairAvailability: "measured",
  };
}

function emptyConflictDistanceBuckets(): CoreCacheConflictProfile["reuseDistance"] {
  return { "0-15": 0n, "16-63": 0n, "64-255": 0n, "256-1023": 0n, "1024+": 0n };
}

function decodeAdmissionSite(
  view: DataView,
  offset: number,
  recordVersion: CoreRuntimeProfile["recordVersion"],
): CoreJitAdmissionSiteProfile {
  const firstObservation = view.getBigUint64(offset + 24, true);
  const lastObservation = view.getBigUint64(offset + 32, true);
  const entryOffset = view.getUint16(offset + 40, true);
  const visits = view.getUint16(offset + 42, true);
  const requiredVisits = view.getUint16(offset + 44, true);
  const flags = view.getUint8(offset + 51);
  const blocked = (flags & 1) !== 0;
  const admitted = (flags & 2) !== 0;
  const cached = (flags & 4) !== 0;
  const blockedReason = jitBlockReason(view.getUint8(offset + 52));
  if (
    firstObservation === 0n ||
    firstObservation > lastObservation ||
    entryOffset >= 0x1_000 ||
    requiredVisits === 0 ||
    flags > 7 ||
    admitted !== (!blocked && (cached || visits >= requiredVisits)) ||
    (cached && !admitted) ||
    blocked !== (blockedReason !== null) ||
    view.getUint8(offset + 53) > (recordVersion >= 26 ? 1 : 0) ||
    view.getUint16(offset + 54, true) !== 0
  ) {
    throw fault("runtime workload admission site is invalid");
  }
  const physicalFrame = view.getBigUint64(offset + 8, true);
  if ((physicalFrame & 0xfffn) !== 0n) {
    throw fault("runtime workload admission frame is unaligned");
  }
  return {
    rip: view.getBigUint64(offset, true),
    physicalFrame,
    generation: view.getBigUint64(offset + 16, true),
    firstObservation,
    lastObservation,
    entryOffset,
    visits,
    requiredVisits,
    codeAttributes: view.getUint16(offset + 46, true),
    ...decodeCodeSegment(view, offset + 56, recordVersion, view.getUint8(offset + 48)),
    capabilityRevision: recordVersion >= 26 && view.getUint8(offset + 53) === 1 ? 1 : 0,
    mode: mode(view.getUint8(offset + 48)),
    cpl: cpl(view.getUint8(offset + 49)),
    profile: cpuProfile(view.getUint8(offset + 50)),
    blocked,
    blockedReason,
    admitted,
    cached,
  };
}

function jitBlockReason(
  value: number,
): CoreJitAdmissionSiteProfile["blockedReason"] {
  switch (value) {
    case 0:
      return null;
    case 1:
      return "unsupported-semantic";
    case 2:
      return "quarantined-semantic";
    case 3:
      return "unsupported-cpu-context";
    case 4:
      return "translation-fault";
    case 5:
      return "candidate-limit";
    case 6:
      return "module-size-limit";
    case 7:
      return "decode-or-translation-fault";
    case 8:
      return "lowering-failure";
    case 9:
      return "emission-failure";
    default:
      throw fault("runtime workload JIT block reason is invalid");
  }
}

function safeInteger(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw fault(`${label} is too large`);
  return Number(value);
}

function mode(value: number): 0 | 1 | 2 | 3 {
  switch (value) {
    case 0:
    case 1:
    case 2:
    case 3:
      return value;
    default:
      throw fault("runtime workload CPU mode is invalid");
  }
}

function cpl(value: number): 0 | 1 | 2 | 3 {
  switch (value) {
    case 0:
    case 1:
    case 2:
    case 3:
      return value;
    default:
      throw fault("runtime workload CPL is invalid");
  }
}

function cpuProfile(value: number): 0 | 1 | 2 {
  switch (value) {
    case 0:
    case 1:
    case 2:
      return value;
    default:
      throw fault("runtime workload CPU profile is invalid");
  }
}

function fault(message: string): CoreAbiError {
  return new CoreAbiError("VM_FAULT", message);
}
