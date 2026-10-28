import { describe, expect, it } from "vitest";

import { CoreAbiError } from "../core-abi.js";
import { decodeCoreRuntimeProfile } from "./profile.js";

const HEADER_LENGTH = 12;
const CORE_PAYLOAD_LENGTH = 87 * 8;
const WORKLOAD_HEADER_LENGTH = 64;
const CORE_PAYLOAD_LENGTH_V11 = 110 * 8;
const CORE_PAYLOAD_LENGTH_V12 = 114 * 8;
const CORE_PAYLOAD_LENGTH_V13 = 116 * 8;
const CORE_PAYLOAD_LENGTH_V14 = 119 * 8;
const CORE_PAYLOAD_LENGTH_V15 = 126 * 8;
const CORE_PAYLOAD_LENGTH_V16 = 179 * 8;
const CORE_PAYLOAD_LENGTH_V18 = 195 * 8;
const CORE_PAYLOAD_LENGTH_V19 = 198 * 8;
const CORE_PAYLOAD_LENGTH_V20 = 207 * 8;
const WORKLOAD_HEADER_LENGTH_V11 = 80;
const WORKLOAD_HEADER_LENGTH_V12 = 96;
const SITE_RECORD_LENGTH_V9 = 72;
const SITE_RECORD_LENGTH_V10 = 80;
const ADMISSION_RECORD_LENGTH = 56;
const CACHE_CONFLICT_RECORD_LENGTH = 32;
const CACHE_CONFLICT_RECORD_LENGTH_V12 = 88;
const SEMANTIC_COUNT = 2;
describe("CPU copy profile compatibility", () => {
  it("decodes version 21 copy counters and defaults older records to zero", () => {
    const old = profileRecord(20);
    old.fill(0, HEADER_LENGTH + CORE_PAYLOAD_LENGTH_V19, HEADER_LENGTH + CORE_PAYLOAD_LENGTH_V20);
    const offset = HEADER_LENGTH + CORE_PAYLOAD_LENGTH_V20;
    const bytes = new Uint8Array(old.length + 24);
    bytes.set(old.subarray(0, offset));
    bytes.set(old.subarray(offset), offset + 24);
    const view = new DataView(bytes.buffer);
    view.setUint16(4, 21, true);
    view.setUint32(8, bytes.length - HEADER_LENGTH, true);
    [11n, 12n, 23n].forEach((value, index) => view.setBigUint64(offset + index * 8, value, true));
    expect(decodeCoreRuntimeProfile(bytes)).toMatchObject({
      syscallCpuClones: 11n, sysretCpuClones: 12n, replacementCommitCpuClones: 23n,
    });
    expect(decodeCoreRuntimeProfile(old)).toMatchObject({
      syscallCpuClones: 0n, sysretCpuClones: 0n, replacementCommitCpuClones: 0n,
    });
  });
});
function payloadLength(version: 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20): number {
  return (version >= 20 ? CORE_PAYLOAD_LENGTH_V20 : version >= 19 ? CORE_PAYLOAD_LENGTH_V19 : version >= 18 ? CORE_PAYLOAD_LENGTH_V18 : version >= 16 ? CORE_PAYLOAD_LENGTH_V16 : version === 15 ? CORE_PAYLOAD_LENGTH_V15 : version === 14 ? CORE_PAYLOAD_LENGTH_V14 : version === 13 ? CORE_PAYLOAD_LENGTH_V13 : version === 12 ? CORE_PAYLOAD_LENGTH_V12 : version === 11 ? CORE_PAYLOAD_LENGTH_V11 : CORE_PAYLOAD_LENGTH) +
    (version >= 12 ? WORKLOAD_HEADER_LENGTH_V12 : version === 11 ? WORKLOAD_HEADER_LENGTH_V11 : WORKLOAD_HEADER_LENGTH) +
    SEMANTIC_COUNT * 16 +
    (version === 9 ? SITE_RECORD_LENGTH_V9 : SITE_RECORD_LENGTH_V10) +
    ADMISSION_RECORD_LENGTH +
    (version >= 12 ? CACHE_CONFLICT_RECORD_LENGTH_V12 : version === 11 ? CACHE_CONFLICT_RECORD_LENGTH : 0);
}

function profileRecord(version: 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 = 9): Uint8Array {
  const payload = payloadLength(version);
  const bytes = new Uint8Array(HEADER_LENGTH + payload);
  bytes.set([0x4f, 0x58, 0x50, 0x44]);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, version, true);
  view.setUint32(8, payload, true);
  view.setBigUint64(12, 1n, true);
  view.setBigUint64(20, 2n, true);
  view.setBigUint64(132, 15n, true);
  view.setBigUint64(140, 16n, true);
  view.setBigUint64(196, 23n, true);
  view.setBigUint64(236, 28n, true);
  view.setBigUint64(284, 34n, true);
  view.setBigUint64(292, 35n, true);
  view.setBigUint64(300, 36n, true);
  view.setBigUint64(308, 37n, true);
  view.setBigUint64(316, 38n, true);
  view.setBigUint64(324, 39n, true);
  view.setBigUint64(332, 40n, true);
  view.setBigUint64(340, 41n, true);
  view.setBigUint64(348, 42n, true);
  view.setBigUint64(356, 43n, true);
  view.setBigUint64(364, 44n, true);
  view.setBigUint64(372, 45n, true);
  view.setBigUint64(380, 46n, true);
  view.setBigUint64(388, 47n, true);
  view.setBigUint64(396, 48n, true);
  view.setBigUint64(404, 49n, true);
  view.setBigUint64(412, 50n, true);
  view.setBigUint64(420, 51n, true);
  view.setBigUint64(428, 52n, true);
  view.setBigUint64(436, 53n, true);
  view.setBigUint64(444, 54n, true);
  view.setBigUint64(452, 55n, true);
  view.setBigUint64(460, 56n, true);
  view.setBigUint64(468, 57n, true);
  view.setBigUint64(476, 58n, true);
  view.setBigUint64(484, 59n, true);
  view.setBigUint64(492, 60n, true);
  view.setBigUint64(500, 61n, true);
  view.setBigUint64(508, 62n, true);
  view.setBigUint64(516, 63n, true);
  view.setBigUint64(524, 64n, true);
  view.setBigUint64(532, 65n, true);
  view.setBigUint64(540, 66n, true);
  view.setBigUint64(548, 67n, true);
  view.setBigUint64(556, 68n, true);
  view.setBigUint64(564, 69n, true);
  view.setBigUint64(572, 70n, true);
  view.setBigUint64(580, 71n, true);
  view.setBigUint64(588, 72n, true);
  view.setBigUint64(596, 73n, true);
  view.setBigUint64(604, 74n, true);
  view.setBigUint64(612, 75n, true);
  view.setBigUint64(620, 76n, true);
  view.setBigUint64(628, 77n, true);
  view.setBigUint64(636, 78n, true);
  view.setBigUint64(644, 79n, true);
  view.setBigUint64(652, 80n, true);
  view.setBigUint64(660, 81n, true);
  view.setBigUint64(668, 82n, true);
  view.setBigUint64(676, 83n, true);
  view.setBigUint64(684, 84n, true);
  view.setBigUint64(692, 85n, true);
  view.setBigUint64(700, 86n, true);
  if (version >= 11) {
    for (let index = 87; index < (version >= 20 ? 207 : version >= 19 ? 198 : version >= 18 ? 195 : version >= 16 ? 179 : version === 15 ? 126 : version === 14 ? 119 : version === 13 ? 116 : version === 12 ? 114 : 110); index += 1) {
      view.setBigUint64(HEADER_LENGTH + index * 8, BigInt(index), true);
    }
    if (version >= 16) {
      [10n, 11n, 12n, 13n, 14n, 15n, 16n, 17n, 8n, 7n].forEach(
        (value, index) => view.setBigUint64(HEADER_LENGTH + (126 + index) * 8, value, true),
      );
      [100n, 1n, 90n, 2n, 10n, 1n, 50n, 1n, 40n, 2n, 10n, 1n].forEach(
        (value, index) => view.setBigUint64(HEADER_LENGTH + (136 + index) * 8, value, true),
      );
      [6n, 0n, 4n].forEach(
        (value, index) => view.setBigUint64(HEADER_LENGTH + (148 + index) * 8, value, true),
      );
      [1n, 10n, 8n, 1n, 1n, 100n, 1n].forEach(
        (value, index) => view.setBigUint64(HEADER_LENGTH + (151 + index) * 8, value, true),
      );
      [1n, 1n, 1n, 2n].forEach(
        (value, index) => view.setBigUint64(HEADER_LENGTH + (158 + index) * 8, value, true),
      );
      view.setBigUint64(HEADER_LENGTH + 162 * 8, 600n, true);
      view.setBigUint64(HEADER_LENGTH + 163 * 8, 300n, true);
      [0n, 0n, 80n, 20n, 300n, 100n, 200n, 50n, 100n, 20n, 150n].forEach(
        (value, index) => view.setBigUint64(HEADER_LENGTH + (164 + index) * 8, value, true),
      );
      [100n, 500n, 0n, 300n].forEach(
        (value, index) => view.setBigUint64(HEADER_LENGTH + (175 + index) * 8, value, true),
      );
      view.setBigUint64(HEADER_LENGTH + 123 * 8, 138n, true);
    }
    if (version >= 18) {
      [100n, 2n, 3n, 1n, 4n, 10n, 9n, 9n, 4n, 5n, 6n, 20n, 15n, 2n, 5n, 7n].forEach(
        (value, index) => view.setBigUint64(HEADER_LENGTH + (179 + index) * 8, value, true),
      );
    }
    if (version >= 19) {
      [300n, 200n, 500n].forEach(
        (value, index) => view.setBigUint64(HEADER_LENGTH + (195 + index) * 8, value, true),
      );
    }
  }
  const workload = HEADER_LENGTH +
    (version >= 20 ? CORE_PAYLOAD_LENGTH_V20 : version >= 19 ? CORE_PAYLOAD_LENGTH_V19 : version >= 18 ? CORE_PAYLOAD_LENGTH_V18 : version >= 16 ? CORE_PAYLOAD_LENGTH_V16 : version === 15 ? CORE_PAYLOAD_LENGTH_V15 : version === 14 ? CORE_PAYLOAD_LENGTH_V14 : version === 13 ? CORE_PAYLOAD_LENGTH_V13 : version === 12 ? CORE_PAYLOAD_LENGTH_V12 : version === 11 ? CORE_PAYLOAD_LENGTH_V11 : CORE_PAYLOAD_LENGTH);
  view.setUint32(workload, SEMANTIC_COUNT, true);
  view.setUint32(workload + 4, 1, true);
  view.setUint32(workload + 8, 1, true);
  view.setUint32(workload + 12, 65_536, true);
  view.setBigUint64(workload + 16, 4_096n, true);
  view.setBigUint64(workload + 24, 10n, true);
  view.setBigUint64(workload + 32, 8n, true);
  view.setBigUint64(workload + 40, 3n, true);
  view.setBigUint64(workload + 48, 1n, true);
  view.setBigUint64(workload + 56, 2n, true);
  if (version >= 11) {
    view.setUint32(workload + 64, 1, true);
    view.setUint32(workload + 68, 4_096, true);
    view.setBigUint64(workload + 72, 2n, true);
    if (version >= 12) {
      view.setBigUint64(workload + 80, 64n, true);
      view.setBigUint64(workload + 88, 9n, true);
    }
  }
  const semantics = workload +
    (version >= 12 ? WORKLOAD_HEADER_LENGTH_V12 : version === 11 ? WORKLOAD_HEADER_LENGTH_V11 : WORKLOAD_HEADER_LENGTH);
  view.setBigUint64(semantics, 7n, true);
  view.setBigUint64(semantics + 8, 3n, true);
  view.setBigUint64(semantics + 16, 6n, true);
  view.setBigUint64(semantics + 24, 2n, true);
  const site = semantics + SEMANTIC_COUNT * 16;
  view.setBigUint64(site, 0x4_000n, true);
  view.setBigUint64(site + 8, 0x12_000n, true);
  view.setBigUint64(site + 16, 9n, true);
  view.setBigUint64(site + 24, 4_096n, true);
  view.setBigUint64(site + 32, 8_192n, true);
  view.setBigUint64(site + 40, 2n, true);
  view.setBigUint64(site + 48, 1n, true);
  view.setUint16(site + 56, 0x34, true);
  view.setUint16(site + 58, 0x209b, true);
  view.setUint32(site + 60, 1, true);
  if (version >= 10) {
    view.setUint16(site + 64, 17, true);
    view.setUint8(site + 66, 3);
    view.setUint8(site + 67, 3);
    view.setUint8(site + 68, 2);
    view.setBigUint64(site + 69, 0x10_000n, true);
  } else {
    view.setUint8(site + 64, 3);
    view.setUint8(site + 65, 3);
    view.setUint8(site + 66, 2);
  }
  const admission = site + (version === 9 ? SITE_RECORD_LENGTH_V9 : SITE_RECORD_LENGTH_V10);
  view.setBigUint64(admission, 0x5_000n, true);
  view.setBigUint64(admission + 8, 0x13_000n, true);
  view.setBigUint64(admission + 16, 10n, true);
  view.setBigUint64(admission + 24, 11n, true);
  view.setBigUint64(admission + 32, 19n, true);
  view.setUint16(admission + 40, 0x45, true);
  view.setUint16(admission + 42, 0, true);
  view.setUint16(admission + 44, 256, true);
  view.setUint16(admission + 46, 0x209b, true);
  view.setUint8(admission + 48, 3);
  view.setUint8(admission + 49, 3);
  view.setUint8(admission + 50, 2);
  view.setUint8(admission + 51, 0b110);
  if (version >= 11) {
    const conflict = admission + ADMISSION_RECORD_LENGTH;
    view.setUint8(conflict, 1);
    if (version >= 12) {
      view.setUint32(conflict + 4, 19, true);
      view.setBigUint64(conflict + 8, 0x6_000n, true);
      view.setBigUint64(conflict + 16, 0x7_000n, true);
      view.setBigUint64(conflict + 24, 0x20_000n, true);
      view.setBigUint64(conflict + 32, 7n, true);
      view.setBigUint64(conflict + 40, 3n, true);
      for (let index = 0; index < 5; index += 1) {
        view.setBigUint64(conflict + 48 + index * 8, index === 4 ? 2n : 1n, true);
      }
    } else {
      view.setBigUint64(conflict + 8, 0x6_000n, true);
      view.setBigUint64(conflict + 16, 0x20_000n, true);
      view.setBigUint64(conflict + 24, 7n, true);
    }
  }
  return bytes;
}

function profileRecordWithAdmissions(count: number): Uint8Array {
  const record = profileRecord();
  const bytes = new Uint8Array(
    record.byteLength + (count - 1) * ADMISSION_RECORD_LENGTH,
  );
  bytes.set(record);
  const view = new DataView(bytes.buffer);
  const workload = HEADER_LENGTH + CORE_PAYLOAD_LENGTH;
  const admission =
    workload +
    WORKLOAD_HEADER_LENGTH +
    SEMANTIC_COUNT * 16 +
    SITE_RECORD_LENGTH_V9;
  view.setUint32(8, bytes.byteLength - HEADER_LENGTH, true);
  view.setUint32(workload + 8, count, true);
  for (let index = 1; index < count; index += 1) {
    bytes.set(
      record.subarray(admission, admission + ADMISSION_RECORD_LENGTH),
      admission + index * ADMISSION_RECORD_LENGTH,
    );
  }
  return bytes;
}

describe("runtime profile codec", () => {
  it("decodes the complete fixed record", () => {
    expect(decodeCoreRuntimeProfile(profileRecord())).toMatchObject({
      enabled: true,
      decodeCacheHits: 2n,
      tlbProbeMisses: 15n,
      jitChainAttempts: 16n,
      jitChainContextFailures: 23n,
      jitDispatchSlotRebindings: 28n,
      jitCandidateCompiles: 34n,
      jitCacheReuseHits: 35n,
      jitCacheReusedTranslations: 36n,
      jitCacheEightHitTranslations: 37n,
      jitCacheThirtyTwoHitTranslations: 38n,
      jitChainCoverageTargets: 39n,
      jitChainCoverageEightMissTargets: 40n,
      jitChainCoverageThirtyTwoMissTargets: 41n,
      jitChainCoverageSixtyFourMissTargets: 42n,
      jitChainCoverageAdmissionResets: 43n,
      jitChainCoverageAdmissionResetTargets: 44n,
      decodeMappingInvalidationChanges: 45n,
      decodeMappingCr3Changes: 46n,
      decodeMappingPolicyChanges: 47n,
      tlbInvlpg: 48n,
      tlbInvpcidIndividual: 49n,
      tlbInvpcidSingleContext: 50n,
      tlbInvpcidAllNonGlobal: 51n,
      tlbInvpcidAll: 52n,
      jitResidentTierLoopCalls: 53n,
      jitBlockObservations: 54n,
      jitColdBlockExecutions: 55n,
      jitHotBlockTransitions: 56n,
      jitHotBoundaryStops: 57n,
      jitPartialBudgetFallbacks: 58n,
      jitMemoryReads: 59n,
      jitMemoryPreflightWrites: 60n,
      jitMemoryStageWrites: 61n,
      jitMemoryWrites: 62n,
      jitMemoryDirectPreflightWrites: 63n,
      jitReadCacheMissCrossPage: 64n,
      jitReadCacheMissTag: 65n,
      jitReadCacheMissEpoch: 66n,
      jitReadCacheMissUnexplained: 67n,
      jitReadCacheMissPendingWrites: 0n,
      jitWriteCacheMissCrossPage: 68n,
      jitWriteCacheMissTag: 69n,
      jitWriteCacheMissEpoch: 70n,
      jitWriteCacheMissPendingWrites: 71n,
      jitWriteCacheMissUnexplained: 72n,
      jitDispatchMissTag: 73n,
      jitDispatchMissEpoch: 74n,
      jitDispatchMissTargetSlot: 75n,
      jitDispatchMissActiveSlot: 76n,
      jitDispatchMissPendingWrites: 77n,
      jitDispatchMissInterruptShadow: 78n,
      jitDispatchMissAddressSpace: 0n,
      jitDispatchMissCr3: 79n,
      jitDispatchMissCpl: 80n,
      jitDispatchMissUnexplained: 81n,
      jitDispatchMissEmpty: 82n,
      jitDispatchEpochInvalidations: 83n,
      jitDispatchFullInvalidations: 84n,
      jitDispatchPageInvalidations: 85n,
      jitDispatchPageSlotsCleared: 86n,
      workload: {
        samplePeriod: 4096,
        instructionAttempts: 10n,
        instructionCommits: 8n,
        siteSamples: 3n,
        droppedSiteSamples: 1n,
        unmappedAdmissionSites: 2n,
        semanticAttempts: [7n, 3n],
        semanticCommits: [6n, 2n],
        sites: [
          {
            rip: 0x4_000n,
            physicalFrame: 0x12_000n,
            generation: 9n,
            firstAttempt: 4_096n,
            lastAttempt: 8_192n,
            samples: 2n,
            committedSamples: 1n,
            entryOffset: 0x34,
            codeAttributes: 0x209b,
            semantic: 1,
            mode: 3,
            cpl: 3,
            profile: 2,
          },
        ],
        admissionSites: [
          {
            rip: 0x5_000n,
            physicalFrame: 0x13_000n,
            generation: 10n,
            firstObservation: 11n,
            lastObservation: 19n,
            entryOffset: 0x45,
            visits: 0,
            requiredVisits: 256,
            codeAttributes: 0x209b,
            mode: 3,
            cpl: 3,
            profile: 2,
            blocked: false,
            blockedReason: null,
            admitted: true,
            cached: true,
          },
        ],
      },
    });
  });

  it("decodes form identity in runtime profile v10", () => {
    expect(decodeCoreRuntimeProfile(profileRecord(10))).toMatchObject({
      recordVersion: 10,
      workload: { sites: [{ instructionId: 17, addressSpace: 0x10_000n, identityAvailability: "measured" }] },
    });
  });

  it("decodes region, admission, and cache-conflict evidence in runtime profile v11", () => {
    expect(decodeCoreRuntimeProfile(profileRecord(11))).toMatchObject({
      recordVersion: 11,
      jitRegionCandidates: 87n,
      jitRegionStopSuccessorNotReady: 101n,
      jitAdmissionEvictedCold: 104n,
      jitAdmissionIdentityChanges: 108n,
      workload: {
        cacheConflictCapacity: 4096,
        cacheConflictSamplePeriod: 1,
        cacheConflictSamples: 9n,
        droppedCacheConflicts: 2n,
        cacheConflicts: [
          {
            kind: "dispatch",
            index: null,
            incomingTag: 0x6_000n,
            displacedTag: null,
            addressSpace: 0x20_000n,
            sampledConflicts: 7n,
            pairAvailability: "unavailable:legacy-record",
          },
        ],
      },
    });
  });

  it("decodes exact hits, slot clearing, and sampled collision pairs in runtime profile v12", () => {
    expect(decodeCoreRuntimeProfile(profileRecord(12))).toMatchObject({
      recordVersion: 12,
      jitReadCacheHits: 110n,
      jitWriteCacheHits: 111n,
      jitDispatchSlotClearEntriesScanned: 112n,
      jitDispatchSlotClearEntriesCleared: 113n,
      workload: {
        cacheConflictSamplePeriod: 64,
        cacheConflictSamples: 9n,
        droppedCacheConflicts: 2n,
        cacheConflicts: [{
          kind: "dispatch",
          index: 19,
          incomingTag: 0x6_000n,
          displacedTag: 0x7_000n,
          addressSpace: 0x20_000n,
          sampledConflicts: 7n,
          alternations: 3n,
          reuseDistance: {
            "0-15": 1n,
            "16-63": 1n,
            "64-255": 1n,
            "256-1023": 1n,
            "1024+": 2n,
          },
          pairAvailability: "measured",
        }],
      },
    });
  });

  it("decodes victim rescues in runtime profile v13", () => {
    expect(decodeCoreRuntimeProfile(profileRecord(13))).toMatchObject({
      recordVersion: 13,
      jitReadVictimHits: 114n,
      jitWriteVictimHits: 115n,
    });
  });

  it("decodes RMW translation reuse in runtime profile v14", () => {
    expect(decodeCoreRuntimeProfile(profileRecord(14))).toMatchObject({
      recordVersion: 14,
      jitRmwEligible: 116n,
      jitRmwReadReuses: 117n,
      jitRmwWriteReuses: 118n,
    });
  });

  it("decodes tail-chain and Tier-2 counters in runtime profile v15", () => {
    expect(decodeCoreRuntimeProfile(profileRecord(15))).toMatchObject({
      recordVersion: 15,
      jitTailChainTransitions: 119n,
      jitTier2Eligible: 120n,
      jitTier2PromotionAttempts: 121n,
      jitTier2Compiles: 122n,
      jitTier2Failures: 123n,
      jitTier2CompiledInstructions: 124n,
      jitTier2ExecutionEntries: 125n,
    });
  });

  it("decodes and reconciles exact Tier-2 failure buckets in runtime profile v16", () => {
    expect(decodeCoreRuntimeProfile(profileRecord(16))).toMatchObject({
      recordVersion: 16,
      jitTier2Failures: 138n,
      jitTier2FailureMachineUnavailable: 10n,
      jitTier2FailureWriteTracking: 11n,
      jitTier2FailureUnsupportedCpuContext: 12n,
      jitTier2FailureDecodeOrTranslationFault: 13n,
      jitTier2FailureQuarantinedSemantic: 14n,
      jitTier2FailureUnsupportedSemantic: 15n,
      jitTier2FailureUnsupportedForm: 16n,
      jitTier2FailureEmission: 17n,
      jitTier2FailureModuleSizeLimit: 8n,
      jitTier2FailureCandidateLimit: 7n,
      jitTier2FailureStaleProfile: 6n,
      jitTier2FailureIneligibleTrace: 0n,
      jitTier2FailureResidentBudget: 4n,
      jitTier2FailureNoRegion: 1n,
      jitTier2FailureNoEligibleEdges: 1n,
      jitTier2FailureInsufficientInternalization: 1n,
      jitTier2FailureNoRecurrentComponent: 2n,
      jitTier1Retired: 600n,
      jitTier2Retired: 300n,
      jitTier1Ring0Retired: 100n,
      jitTier1Ring3Retired: 500n,
      jitTier2Ring0Retired: 0n,
      jitTier2Ring3Retired: 300n,
      jitTraceRecordingWindows: 1n,
      jitTraceRecordedEdges: 10n,
      jitTraceAcceptedEdges: 8n,
      jitTraceStaleEdges: 1n,
      jitTraceDroppedEdges: 1n,
      jitTraceRecordedRetired: 100n,
      jitTraceSelectedRoots: 1n,
      jitTraceReadSiteVisits: 100n,
      jitTraceReadFirstVisits: 1n,
      jitTraceReadReuses: 90n,
      jitTraceReadPageChanges: 2n,
      jitTraceReadRefreshes: 10n,
      jitTraceReadUnsafe: 1n,
      jitTraceWriteSiteVisits: 50n,
      jitTraceWriteFirstVisits: 1n,
      jitTraceWriteReuses: 40n,
      jitTraceWritePageChanges: 2n,
      jitTraceWriteRefreshes: 10n,
      jitTraceWriteUnsafe: 1n,
      jitTraceReadIneligible: 0n,
      jitTraceWriteIneligible: 0n,
      jitTraceInternalEdges: 80n,
      jitTraceExternalEdges: 20n,
      jitTraceCurrentStateOps: 300n,
      jitTraceProposedStateOps: 100n,
      jitTraceCurrentFlagOps: 200n,
      jitTraceProposedFlagOps: 50n,
      jitTraceCurrentMaterializations: 100n,
      jitTraceProposedMaterializations: 20n,
      jitTraceAddedGuards: 150n,
    });
  });

  it("rejects unreconciled Tier-2 failure buckets in runtime profile v16", () => {
    const bytes = profileRecord(16);
    new DataView(bytes.buffer).setBigUint64(HEADER_LENGTH + 126 * 8, 9n, true);

    expect(() => decodeCoreRuntimeProfile(bytes)).toThrowError(
      "runtime Tier-2 failure counters do not agree",
    );
  });

  it("rejects unreconciled privilege retirement in runtime profile v16", () => {
    const bytes = profileRecord(16);
    new DataView(bytes.buffer).setBigUint64(HEADER_LENGTH + 175 * 8, 99n, true);

    expect(() => decodeCoreRuntimeProfile(bytes)).toThrowError(
      "runtime Tier-retirement privilege counters do not reconcile",
    );
  });

  it("decodes address-space dispatch misses without relabeling legacy CR3 data", () => {
    expect(decodeCoreRuntimeProfile(profileRecord(15))).toMatchObject({
      jitDispatchMissAddressSpace: 0n,
      jitDispatchMissCr3: 79n,
    });
    expect(decodeCoreRuntimeProfile(profileRecord(17))).toMatchObject({
      recordVersion: 17,
      jitDispatchMissAddressSpace: 79n,
      jitDispatchMissCr3: 0n,
    });
  });

  it("decodes reconciled resident and JIT binding counters in runtime profile v19", () => {
    expect(decodeCoreRuntimeProfile(profileRecord(19))).toMatchObject({
      recordVersion: 19,
      jitResidentAdapterCompletions: 100n,
      jitAdapterExitsReturned: 2n,
      jitResidentTaskSwitches: 3n,
      jitResidentZeroRetirementExhaustions: 1n,
      jitResidentHostWaitExits: 4n,
      jitDispatchRebindSameModuleCrossAddressSpace: 10n,
      jitDispatchRebindDifferentModule: 9n,
      jitDispatchRebindSameAddressSpace: 9n,
      jitBindingInvalidationsUnregister: 4n,
      jitBindingInvalidationsEviction: 5n,
      jitBindingInvalidationsReplacement: 6n,
      jitActiveBindings: 20n,
      jitActiveArtifacts: 15n,
      jitActiveAddressSpaces: 2n,
      jitAliasBindings: 5n,
      jitAliasReuses: 7n,
      jitCacheBindingBytes: 300n,
      jitCacheArtifactBytes: 200n,
      jitCacheTotalBytes: 500n,
    });
  });

  it("decodes AOT lookup, registration, dispatch, and retirement counters in v20", () => {
    const bytes = profileRecord(20);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const counters = [3n, 2n, 1n, 1n, 1n, 0n, 2n, 4n, 1n];
    counters.forEach((value, index) => {
      view.setBigUint64(HEADER_LENGTH + (198 + index) * 8, value, true);
    });
    expect(decodeCoreRuntimeProfile(bytes)).toMatchObject({
      recordVersion: 20,
      jitAotLookups: 3n,
      jitAotMatches: 2n,
      jitAotAmbiguous: 1n,
      jitAotDeclines: 1n,
      jitAotRegistrations: 1n,
      jitAotRegistrationRejections: 0n,
      jitAotDispatches: 2n,
      jitAotRetired: 4n,
      jitAotDynamicCompilesAvoided: 1n,
    });
  });
  it.each([2, 3])(
    "accepts expanded direct-cache index 65,535 for kind %s",
    (kind) => {
      const bytes = profileRecord(14);
      const conflict = HEADER_LENGTH + CORE_PAYLOAD_LENGTH_V14 +
        WORKLOAD_HEADER_LENGTH_V12 + SEMANTIC_COUNT * 16 +
        SITE_RECORD_LENGTH_V10 + ADMISSION_RECORD_LENGTH;
      const view = new DataView(bytes.buffer);
      view.setUint8(conflict, kind);
      view.setUint32(conflict + 4, 65_535, true);

      expect(decodeCoreRuntimeProfile(bytes).workload.cacheConflicts[0])
        .toMatchObject({
          kind: kind === 2 ? "read" : "write",
          index: 65_535,
        });
    },
  );

  it("rejects incomplete collision-pair reuse accounting", () => {
    const bytes = profileRecord(12);
    const conflict = HEADER_LENGTH + CORE_PAYLOAD_LENGTH_V12 +
      WORKLOAD_HEADER_LENGTH_V12 + SEMANTIC_COUNT * 16 +
      SITE_RECORD_LENGTH_V10 + ADMISSION_RECORD_LENGTH;
    new DataView(bytes.buffer).setBigUint64(conflict + 80, 1n, true);

    expect(() => decodeCoreRuntimeProfile(bytes)).toThrow(CoreAbiError);
  });

  it("accepts the runtime admission capacity", () => {
    expect(
      decodeCoreRuntimeProfile(profileRecordWithAdmissions(65_536)).workload
        .admissionSites,
    ).toHaveLength(65_536);
  });

  it("decodes a closed blocked-block reason", () => {
    const bytes = profileRecord();
    const admission =
      HEADER_LENGTH +
      CORE_PAYLOAD_LENGTH +
      WORKLOAD_HEADER_LENGTH +
      SEMANTIC_COUNT * 16 +
      SITE_RECORD_LENGTH_V9;
    const view = new DataView(bytes.buffer);
    view.setUint8(admission + 51, 0b001);
    view.setUint8(admission + 52, 4);

    expect(
      decodeCoreRuntimeProfile(bytes).workload.admissionSites[0],
    ).toMatchObject({
      blocked: true,
      blockedReason: "translation-fault",
      admitted: false,
      cached: false,
    });
  });

  it.each([
    ["magic", (bytes: Uint8Array) => { bytes[0] = 0; }],
    [
      "version",
      (bytes: Uint8Array) => {
        new DataView(bytes.buffer).setUint16(4, 7, true);
      },
    ],
    [
      "reserved header",
      (bytes: Uint8Array) => {
        new DataView(bytes.buffer).setUint16(6, 1, true);
      },
    ],
    [
      "payload length",
      (bytes: Uint8Array) => {
        new DataView(bytes.buffer).setUint32(8, 0, true);
      },
    ],
    [
      "enabled flag",
      (bytes: Uint8Array) => {
        new DataView(bytes.buffer).setBigUint64(12, 2n, true);
      },
    ],
  ] as const)("rejects an invalid %s", (_name, mutate) => {
    const bytes = profileRecord();
    mutate(bytes);
    expect(() => decodeCoreRuntimeProfile(bytes)).toThrow(CoreAbiError);
  });

  it("rejects truncation and trailing data", () => {
    const record = profileRecord();
    expect(() => decodeCoreRuntimeProfile(record.subarray(1))).toThrow(
      CoreAbiError,
    );
    expect(() =>
      decodeCoreRuntimeProfile(new Uint8Array(record.byteLength + 1)),
    ).toThrow(CoreAbiError);
  });
});

describe("translation coherence profile", () => {
  const CORE_PAYLOAD_LENGTH_V21 = 210 * 8;
  const COHERENCE = [
    1n, 2n, 0n, 0n, 1n, 0n, 0n, 1n, 0n, 2n, 3n, 1n, 1n, 0n, 0n, 1n, 1n, 1n, 2n, 0n, 0n, 0n, 1n,
    1n, 1n, 9n,
  ];

  function coherenceRecord(version: 22 | 23 | 24 | 25 | 26 | 29 | 30, values: readonly bigint[]): Uint8Array {
    const old = profileRecord(20);
    old.fill(0, HEADER_LENGTH + CORE_PAYLOAD_LENGTH_V19, HEADER_LENGTH + CORE_PAYLOAD_LENGTH_V20);
    const offset = HEADER_LENGTH + CORE_PAYLOAD_LENGTH_V20;
    const added = CORE_PAYLOAD_LENGTH_V21 - CORE_PAYLOAD_LENGTH_V20 + values.length * 8;
    const bytes = new Uint8Array(old.length + added);
    bytes.set(old.subarray(0, offset));
    bytes.set(old.subarray(offset), offset + added);
    const view = new DataView(bytes.buffer);
    view.setUint16(4, version, true);
    view.setUint32(8, bytes.length - HEADER_LENGTH, true);
    values.forEach((value, index) => {
      view.setBigUint64(HEADER_LENGTH + CORE_PAYLOAD_LENGTH_V21 + index * 8, value, true);
    });
    if (version >= 27) {
      const site = HEADER_LENGTH + CORE_PAYLOAD_LENGTH_V21 + values.length * 8 + WORKLOAD_HEADER_LENGTH_V12 + SEMANTIC_COUNT * 16;
      const oldAdmission = site + 80;
      const expanded = new Uint8Array(bytes.length + 32);
      expanded.set(bytes.subarray(0, oldAdmission));
      expanded.set(bytes.subarray(oldAdmission, oldAdmission + 56), oldAdmission + 16);
      expanded.set(bytes.subarray(oldAdmission + 56), oldAdmission + 88);
      const expandedView = new DataView(expanded.buffer);
      expandedView.setUint32(8, expanded.length - HEADER_LENGTH, true);
      expandedView.setUint32(site + 88, 0xffff_ffff, true);
      expandedView.setUint32(oldAdmission + 80, 0xffff_ffff, true);
      return expanded;
    }
    return bytes;
  }

  it("decodes version 22 flush, outcome, and owner journal counters in record order", () => {
    expect(decodeCoreRuntimeProfile(coherenceRecord(22, COHERENCE))).toMatchObject({
      recordVersion: 22,
      jitDirectPageFlushesCpuStateLoaded: 1n,
      jitDirectPageFlushesEventRun: 2n,
      jitDirectPageFlushesDispatchCodePageAdded: 1n,
      jitDirectPageFlushesOwnerJournalReset: 1n,
      jitDirectPageReadGenerationAdvances: 2n,
      jitDirectPageWriteGenerationAdvances: 3n,
      jitDirectPageEmptyContextFlushes: 1n,
      jitDirectPageWriteOnlyFlushes: 1n,
      jitOwnerInvalidationsUnmapped: 2n,
      jitOwnerInvalidationsCodeWritten: 1n,
      jitOwnerJournalResets: 1n,
      jitResidentCachedReentries: 9n,
    });
    const old = profileRecord(20);
    old.fill(0, HEADER_LENGTH + CORE_PAYLOAD_LENGTH_V19, HEADER_LENGTH + CORE_PAYLOAD_LENGTH_V20);
    expect(decodeCoreRuntimeProfile(old)).toMatchObject({
      jitDirectPageFlushesEventRun: 0n,
      jitResidentCachedReentries: 0n,
    });
  });

  it("rejects counters whose outcomes or resets do not reconcile with their flushes", () => {
    const extraOutcome = [...COHERENCE];
    extraOutcome[9] = 3n;
    const unmatchedReset = [...COHERENCE];
    unmatchedReset[24] = 2n;
    for (const values of [extraOutcome, unmatchedReset]) {
      expect(() => decodeCoreRuntimeProfile(coherenceRecord(22, values))).toThrow(CoreAbiError);
    }
  });

  it("decodes the RAM dirty-tracking reset flushes version 23 appends", () => {
    // One reset flush of a live context adds one write outcome and one write-only flush.
    const values = [...COHERENCE, 1n];
    values[10] = 4n;
    values[16] = 2n;
    expect(decodeCoreRuntimeProfile(coherenceRecord(23, values))).toMatchObject({
      recordVersion: 23,
      jitDirectPageFlushesRamDirtyTrackingReset: 1n,
      jitDirectPageWriteGenerationAdvances: 4n,
      jitDirectPageWriteOnlyFlushes: 2n,
      jitResidentCachedReentries: 9n,
    });
    expect(decodeCoreRuntimeProfile(coherenceRecord(22, COHERENCE))).toMatchObject({
      jitDirectPageFlushesRamDirtyTrackingReset: 0n,
    });
  });

  it("keeps architectural event boundaries separate from indirect and host exits", () => {
    expect(decodeCoreRuntimeProfile(coherenceRecord(24, [...COHERENCE, 0n, 7n]))).toMatchObject({
      recordVersion: 24,
      jitRegionStopArchitecturalEventBoundary: 7n,
    });
    expect(decodeCoreRuntimeProfile(coherenceRecord(23, [...COHERENCE, 0n]))).toMatchObject({
      jitRegionStopArchitecturalEventBoundary: 0n,
    });
  });

  it("decodes capability revisions in version 26 sites and preserves historical records", () => {
    const bytes = coherenceRecord(26, [...COHERENCE, 0n, 7n, 0n]);
    const site = HEADER_LENGTH + 239 * 8 + WORKLOAD_HEADER_LENGTH_V12 + SEMANTIC_COUNT * 16;
    const admission = site + SITE_RECORD_LENGTH_V10;
    bytes[site + 77] = 1;
    bytes[admission + 53] = 1;
    const decoded = decodeCoreRuntimeProfile(bytes);
    expect(decoded.workload.sites[0]?.capabilityRevision).toBe(1);
    expect(decoded.workload.admissionSites[0]?.capabilityRevision).toBe(1);
    for (const offset of [site + 77, admission + 53]) {
      for (const value of [2, 255]) {
        const malformed = bytes.slice();
        malformed[offset] = value;
        expect(() => decodeCoreRuntimeProfile(malformed)).toThrow(CoreAbiError);
      }
    }
    const historical = coherenceRecord(25, [...COHERENCE, 0n, 7n, 0n]);
    expect(decodeCoreRuntimeProfile(historical).workload.sites[0]?.capabilityRevision).toBe(0);
    historical[site + 77] = 1;
    expect(() => decodeCoreRuntimeProfile(historical)).toThrow(CoreAbiError);
  });

  it("decodes code-segment dependencies in version 27 without inventing historical values", () => {
    const old = coherenceRecord(26, [...COHERENCE, 0n, 7n, 0n]);
    const site = HEADER_LENGTH + 239 * 8 + WORKLOAD_HEADER_LENGTH_V12 + SEMANTIC_COUNT * 16;
    const oldAdmission = site + 80;
    const admission = site + 96;
    const bytes = new Uint8Array(old.length + 32);
    bytes.set(old.subarray(0, oldAdmission));
    bytes.set(old.subarray(oldAdmission, oldAdmission + 56), admission);
    bytes.set(old.subarray(oldAdmission + 56), admission + 72);
    const view = new DataView(bytes.buffer);
    view.setUint16(4, 27, true);
    view.setUint32(8, bytes.length - HEADER_LENGTH, true);
    bytes[site + 66] = 1;
    bytes[admission + 48] = 1;
    view.setBigUint64(site + 80, 0x1000n, true);
    view.setUint32(site + 88, 0x1234, true);
    view.setBigUint64(admission + 56, 0x2000n, true);
    view.setUint32(admission + 64, 0x5678, true);
    const decoded = decodeCoreRuntimeProfile(bytes);
    expect(decoded.workload.sites[0]).toMatchObject({ codeSegmentBase: 0x1000n, codeSegmentLimit: 0x1234 });
    expect(decoded.workload.admissionSites[0]).toMatchObject({ codeSegmentBase: 0x2000n, codeSegmentLimit: 0x5678 });
    expect(decodeCoreRuntimeProfile(old).workload.sites[0]).toMatchObject({ codeSegmentBase: null, codeSegmentLimit: null });
    for (const offset of [site + 92, admission + 68]) {
      const malformed = bytes.slice();
      malformed[offset] = 1;
      expect(() => decodeCoreRuntimeProfile(malformed)).toThrow(CoreAbiError);
    }
  });

  it("distinguishes pending-write read misses and preserves historical counters", () => {
    const bytes = new Uint8Array(HEADER_LENGTH + 240 * 8 + WORKLOAD_HEADER_LENGTH_V12);
    bytes.set([0x4f, 0x58, 0x50, 0x44]);
    const view = new DataView(bytes.buffer);
    view.setUint16(4, 28, true);
    view.setUint32(8, bytes.length - HEADER_LENGTH, true);
    view.setBigUint64(HEADER_LENGTH + 239 * 8, 7n, true);
    expect(decodeCoreRuntimeProfile(bytes)).toMatchObject({
      recordVersion: 28, jitReadCacheMissPendingWrites: 7n, jitReadCacheMissUnexplained: 0n,
    });
    const historical = new Uint8Array(bytes.length - 8);
    historical.set(bytes.subarray(0, HEADER_LENGTH + 239 * 8));
    historical.set(bytes.subarray(HEADER_LENGTH + 240 * 8), HEADER_LENGTH + 239 * 8);
    const old = new DataView(historical.buffer);
    old.setUint16(4, 27, true);
    old.setUint32(8, historical.length - HEADER_LENGTH, true);
    expect(decodeCoreRuntimeProfile(historical)).toMatchObject({
      recordVersion: 27, jitReadCacheMissPendingWrites: 0n,
    });
  });

  it("decodes version 25 TLB flushes after the retained version 24 layout", () => {
    const values = [...COHERENCE, 0n, 7n, 1n];
    values[9] = 3n;
    values[10] = 4n;
    expect(decodeCoreRuntimeProfile(coherenceRecord(25, values))).toMatchObject({
      recordVersion: 25,
      jitRegionStopArchitecturalEventBoundary: 7n,
      jitDirectPageFlushesArchitecturalTlbInvalidation: 1n,
    });
    expect(decodeCoreRuntimeProfile(coherenceRecord(24, [...COHERENCE, 0n, 7n]))).toMatchObject({
      jitDirectPageFlushesArchitecturalTlbInvalidation: 0n,
    });
    values[10] = 3n;
    expect(() => decodeCoreRuntimeProfile(coherenceRecord(25, values))).toThrow(CoreAbiError);
  });

  it("rejects a version 23 reset flush without its write outcome", () => {
    expect(() => decodeCoreRuntimeProfile(coherenceRecord(23, [...COHERENCE, 1n])))
      .toThrow(CoreAbiError);
  });

  // Deferred, joins, refusals by reason, settles (compiled, failed, abandoned, not in flight),
  // outstanding artifacts and bytes, compile-pending interprets, passes, evictions, chain misses.
  const DEFERRAL = [
    5n, 1n, 0n, 1n, 0n, 0n, 2n, 0n, 3n, 1n, 0n, 4n, 1n, 640n, 7n, 9n, 1n, 2n,
  ];

  it("decodes the Tier-1 deferral counters version 29 appends after the ISA fields", () => {
    expect(decodeCoreRuntimeProfile(coherenceRecord(29, [...COHERENCE, 0n, 0n, 0n, 0n, ...DEFERRAL])))
      .toMatchObject({
        recordVersion: 29,
        jitResidentCachedReentries: 9n,
        jitDeferrals: 5n,
        jitDeferralJoins: 1n,
        jitDeferralRefusedTierTwo: 1n,
        jitDeferralRefusedNotCached: 2n,
        jitDeferralSettledCompiled: 3n,
        jitDeferralSettledFailed: 1n,
        jitDeferralSettledNotInFlight: 4n,
        jitDeferralOutstanding: 1n,
        jitDeferralOutstandingBytes: 640n,
        jitCompilePendingInterprets: 7n,
        jitCompilePendingInterpreterPasses: 9n,
        jitCompilePendingEvictions: 1n,
        jitChainMissingCompilePending: 2n,
      });
    expect(decodeCoreRuntimeProfile(coherenceRecord(23, [...COHERENCE, 0n])))
      .toMatchObject({ jitDeferrals: 0n, jitCompilePendingInterprets: 0n });
  });

  it("decodes checkpoint lease retirement appended by record 30 and preserves record 29", () => {
    const values = [...COHERENCE, 0n, 0n, 0n, 0n, ...DEFERRAL, 1n];
    values[9] = (values[9] ?? 0n) + 1n;
    values[10] = (values[10] ?? 0n) + 1n;
    expect(decodeCoreRuntimeProfile(coherenceRecord(30, values))).toMatchObject({
      recordVersion: 30, jitDirectPageFlushesOwnerCheckpoint: 1n,
      jitDeferrals: 5n, jitChainMissingCompilePending: 2n,
    });
    expect(decodeCoreRuntimeProfile(coherenceRecord(29, [...COHERENCE, 0n, 0n, 0n, 0n, ...DEFERRAL])))
      .toMatchObject({ jitDirectPageFlushesOwnerCheckpoint: 0n });
    expect(() => decodeCoreRuntimeProfile(coherenceRecord(30, [...COHERENCE, 0n, 0n, 0n, 0n, ...DEFERRAL, 1n])))
      .toThrow("translation coherence counters do not reconcile");
  });

  it("rejects deferral counters that do not reconcile with their settles", () => {
    const unsettled = [...DEFERRAL];
    unsettled[0] = 6n;
    const bytesWithoutArtifacts = [...DEFERRAL];
    bytesWithoutArtifacts[0] = 4n;
    bytesWithoutArtifacts[12] = 0n;
    for (const values of [unsettled, bytesWithoutArtifacts]) {
      expect(() => decodeCoreRuntimeProfile(coherenceRecord(29, [...COHERENCE, 0n, 0n, 0n, 0n, ...values])))
        .toThrow(CoreAbiError);
    }
  });
});
