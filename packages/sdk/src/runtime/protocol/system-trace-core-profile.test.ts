import { describe, expect, it } from "vitest";

import { VMError } from "../errors.js";
import {
  coreRecordVersionForTrace,
  decodeCoreRuntimeProfile,
  EMPTY_CORE_RUNTIME_PROFILE,
} from "./system-trace-core-profile.js";

const TIER_TWO_FAILURES = {
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
} as const;
const TRACE_MEMORY = {
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
} as const;
const TRACE_PROOF = {
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
} as const;
const TRACE_RECORDING = {
  jitTraceRecordingWindows: 1n,
  jitTraceRecordedEdges: 10n,
  jitTraceAcceptedEdges: 8n,
  jitTraceStaleEdges: 1n,
  jitTraceDroppedEdges: 1n,
  jitTraceRecordedRetired: 100n,
  jitTraceSelectedRoots: 1n,
} as const;

describe("system trace core profile", () => {
  it("keeps pending-write read misses exact across current and historical traces", () => {
    expect(coreRecordVersionForTrace(49)).toBe(28);
    expect(coreRecordVersionForTrace(48)).toBe(27);
    expect(decodeCoreRuntimeProfile({
      ...EMPTY_CORE_RUNTIME_PROFILE, recordVersion: 28, jitReadCacheMissPendingWrites: 7n,
    }, 49).jitReadCacheMissPendingWrites).toBe(7n);
    const historical = { ...EMPTY_CORE_RUNTIME_PROFILE, recordVersion: 27 };
    expect(decodeCoreRuntimeProfile(historical, 48).jitReadCacheMissPendingWrites).toBe(0n);
    expect(() => decodeCoreRuntimeProfile({
      ...historical, jitReadCacheMissPendingWrites: 7n,
    }, 48)).toThrow(VMError);
    const { jitReadCacheMissPendingWrites, ...missing } = EMPTY_CORE_RUNTIME_PROFILE;
    expect(jitReadCacheMissPendingWrites).toBe(0n);
    expect(decodeCoreRuntimeProfile({ ...missing, recordVersion: 27 }, 48).jitReadCacheMissPendingWrites).toBe(0n);
    expect(() => decodeCoreRuntimeProfile(missing, 49)).toThrow(VMError);
  });

  it("decodes exact runtime-v16 Tier-2 failure buckets in schema v29", () => {
    const profile = decodeCoreRuntimeProfile({
      ...EMPTY_CORE_RUNTIME_PROFILE,
      recordVersion: 16,
      jitTier2Eligible: 123n,
      jitTier2PromotionAttempts: 123n,
      jitTier2Failures: 138n,
      ...TIER_TWO_FAILURES,
      ...TRACE_RECORDING,
      ...TRACE_MEMORY,
      ...TRACE_PROOF,
    }, 29);

    expect(profile).toMatchObject({
      recordVersion: 16,
      jitTier2Failures: 138n,
      ...TIER_TWO_FAILURES,
      ...TRACE_RECORDING,
      ...TRACE_MEMORY,
      ...TRACE_PROOF,
    });
  });

  it("decodes address-space attribution in runtime v17 and trace schema v30", () => {
    expect(decodeCoreRuntimeProfile({
      ...EMPTY_CORE_RUNTIME_PROFILE,
      recordVersion: 17,
      jitDispatchMissAddressSpace: 7n,
      jitDispatchMissCr3: 0n,
    }, 30)).toMatchObject({
      recordVersion: 17,
      jitDispatchMissAddressSpace: 7n,
      jitDispatchMissCr3: 0n,
    });
  });

  it("decodes resident and binding attribution in runtime v19 and trace schema v32", () => {
    expect(decodeCoreRuntimeProfile({
      ...EMPTY_CORE_RUNTIME_PROFILE,
      recordVersion: 19,
      jitResidentAdapterCompletions: 2n,
      jitResidentHostWaitExits: 1n,
      jitDispatchSlotRebindings: 3n,
      jitDispatchRebindSameModuleCrossAddressSpace: 1n,
      jitDispatchRebindDifferentModule: 1n,
      jitDispatchRebindSameAddressSpace: 1n,
    }, 32)).toMatchObject({
      recordVersion: 19,
      jitResidentAdapterCompletions: 2n,
      jitResidentHostWaitExits: 1n,
      jitDispatchRebindSameModuleCrossAddressSpace: 1n,
    });
  });

  it("rejects a Tier-2 failure bucket from a legacy trace schema", () => {
    expect(() => decodeCoreRuntimeProfile({
      ...EMPTY_CORE_RUNTIME_PROFILE,
      recordVersion: 15,
      jitTier2FailureEmission: 1n,
    }, 28)).toThrow(VMError);
  });
});

describe("translation coherence in the system trace core profile", () => {
  const COHERENCE = {
    jitDirectPageFlushesCpuStateLoaded: 1n,
    jitDirectPageFlushesEventRun: 2n,
    jitDirectPageFlushesDispatchCodePageAdded: 1n,
    jitDirectPageFlushesOwnerJournalReset: 1n,
    jitDirectPageReadGenerationAdvances: 2n,
    jitDirectPageWriteGenerationAdvances: 3n,
    jitDirectPageReadZeroFills: 1n,
    jitDirectPageWriteZeroFills: 1n,
    jitDirectPageEmptyContextFlushes: 1n,
    jitDirectPageWriteOnlyFlushes: 1n,
    jitOwnerInvalidationsUnmapped: 2n,
    jitOwnerTranslationEvictions: 1n,
    jitOwnerJournalResets: 1n,
    jitResidentCachedReentries: 9n,
  } as const;

  it("decodes reconciled counters in schema 40", () => {
    const profile = decodeCoreRuntimeProfile(
      { ...EMPTY_CORE_RUNTIME_PROFILE, recordVersion: 22, ...COHERENCE },
      40,
    );
    expect(profile).toMatchObject({ recordVersion: 22, ...COHERENCE });
  });

  it("names the core profile record each system trace schema carries", () => {
    expect([23, 24, 25, 26, 28, 33, 37, 39, 40, 41, 42, 43].map(coreRecordVersionForTrace))
      .toEqual([11, 12, 13, 14, 15, 20, 21, 21, 22, 23, 23, 24]);
  });

  it("decodes the RAM dirty-tracking reset flush in schema 41 and only a zero one before", () => {
    // One reset flush of a live context adds one write outcome and one write-only flush.
    const reset = {
      ...COHERENCE,
      jitDirectPageFlushesRamDirtyTrackingReset: 1n,
      jitDirectPageWriteGenerationAdvances: 4n,
      jitDirectPageWriteOnlyFlushes: 2n,
    } as const;
    expect(decodeCoreRuntimeProfile({ ...EMPTY_CORE_RUNTIME_PROFILE, recordVersion: 23, ...reset }, 41))
      .toMatchObject({ recordVersion: 23, ...reset });
    expect(() => decodeCoreRuntimeProfile(
      { ...EMPTY_CORE_RUNTIME_PROFILE, ...COHERENCE, jitDirectPageFlushesRamDirtyTrackingReset: 1n },
      41,
    )).toThrow(VMError);
    expect(() => decodeCoreRuntimeProfile(
      { ...EMPTY_CORE_RUNTIME_PROFILE, recordVersion: 22, ...reset },
      40,
    )).toThrow(VMError);
    const withoutReset: Record<string, unknown> = { ...EMPTY_CORE_RUNTIME_PROFILE, ...COHERENCE };
    Reflect.deleteProperty(withoutReset, "jitDirectPageFlushesRamDirtyTrackingReset");
    expect(() => decodeCoreRuntimeProfile(withoutReset, 41)).toThrow(VMError);
  });

  it("decodes reconciled Tier-1 deferral in schema 50 and only zero deferral before", () => {
    const deferral = {
      jitDeferrals: 2n,
      jitDeferralSettledCompiled: 1n,
      jitDeferralOutstanding: 1n,
      jitDeferralOutstandingBytes: 512n,
      jitCompilePendingInterprets: 3n,
    } as const;
    expect(decodeCoreRuntimeProfile({ ...EMPTY_CORE_RUNTIME_PROFILE, recordVersion: 29, ...deferral }, 50))
      .toMatchObject({ recordVersion: 29, ...deferral });
    expect(() => decodeCoreRuntimeProfile(
      { ...EMPTY_CORE_RUNTIME_PROFILE, ...deferral, jitDeferralOutstanding: 0n },
      50,
    )).toThrow(VMError);
    expect(() => decodeCoreRuntimeProfile(
      { ...EMPTY_CORE_RUNTIME_PROFILE, recordVersion: 23, ...deferral },
      43,
    )).toThrow(VMError);
    expect(decodeCoreRuntimeProfile({ ...EMPTY_CORE_RUNTIME_PROFILE, recordVersion: 23 }, 43))
      .toMatchObject({ recordVersion: 23, jitDeferrals: 0n });
  });

  it("requires exact architectural event boundary evidence in schema 43", () => {
    const profile = { ...EMPTY_CORE_RUNTIME_PROFILE, recordVersion: 24, jitRegionStopArchitecturalEventBoundary: 7n };
    expect(decodeCoreRuntimeProfile(profile, 43)).toMatchObject({ recordVersion: 24, jitRegionStopArchitecturalEventBoundary: 7n });
    expect(() => decodeCoreRuntimeProfile({ ...profile, recordVersion: 23 }, 42)).toThrow(VMError);
    const missing: Record<string, unknown> = { ...profile };
    Reflect.deleteProperty(missing, "jitRegionStopArchitecturalEventBoundary");
    expect(() => decodeCoreRuntimeProfile(missing, 43)).toThrow(VMError);
  });

  it("requires the TLB flush reason and matching outcomes in schema 44", () => {
    const profile = { ...EMPTY_CORE_RUNTIME_PROFILE, recordVersion: 25,
      jitDirectPageFlushesArchitecturalTlbInvalidation: 1n,
      jitDirectPageReadGenerationAdvances: 1n, jitDirectPageWriteGenerationAdvances: 1n };
    expect(decodeCoreRuntimeProfile(profile, 44)).toMatchObject(profile);
    const missing: Record<string, unknown> = { ...profile };
    Reflect.deleteProperty(missing, "jitDirectPageFlushesArchitecturalTlbInvalidation");
    expect(() => decodeCoreRuntimeProfile(missing, 44)).toThrow(VMError);
    expect(() => decodeCoreRuntimeProfile({ ...profile, recordVersion: 24 }, 43)).toThrow(VMError);
    expect(() => decodeCoreRuntimeProfile({ ...profile, jitDirectPageWriteGenerationAdvances: 0n }, 44)).toThrow(VMError);
  });

  it("requires checkpoint flush evidence and reconciled outcomes in schema52", () => {
    const profile = { ...EMPTY_CORE_RUNTIME_PROFILE, recordVersion: 30, jitDirectPageFlushesOwnerCheckpoint: 1n,
      jitDirectPageReadGenerationAdvances: 1n, jitDirectPageWriteGenerationAdvances: 1n };
    expect(decodeCoreRuntimeProfile(profile, 52)).toMatchObject(profile);
    expect(() => decodeCoreRuntimeProfile({ ...profile, recordVersion: 29 }, 51)).toThrow(VMError);
    const missing: Record<string, unknown> = { ...profile };
    Reflect.deleteProperty(missing, "jitDirectPageFlushesOwnerCheckpoint");
    expect(() => decodeCoreRuntimeProfile(missing, 52)).toThrow(VMError);
    expect(() => decodeCoreRuntimeProfile({ ...profile, jitDirectPageWriteGenerationAdvances: 0n }, 52)).toThrow(VMError);
  });

  it("rejects counters that do not reconcile and coherence data before schema 40", () => {
    const decode = (value: object, schema: 39 | 40) =>
      () => decodeCoreRuntimeProfile({ ...EMPTY_CORE_RUNTIME_PROFILE, ...value }, schema);
    expect(decode({ ...COHERENCE, jitDirectPageWriteZeroFills: 2n }, 40)).toThrow(VMError);
    expect(decode({ ...COHERENCE, jitOwnerJournalResets: 0n }, 40)).toThrow(VMError);
    expect(decode({ ...COHERENCE, recordVersion: 21 }, 39)).toThrow(VMError);
    expect(decode({ recordVersion: 21 }, 39)()).toMatchObject({ jitResidentCachedReentries: 0n });
  });
});

it("decodes the current record31 in trace53 without weakening historical versions", () => {
  const current = { ...EMPTY_CORE_RUNTIME_PROFILE, recordVersion: 31 };
  expect(decodeCoreRuntimeProfile(current, 53).recordVersion).toBe(31);
  expect(() => decodeCoreRuntimeProfile({ ...current, recordVersion: 32 }, 53)).toThrow();
});
