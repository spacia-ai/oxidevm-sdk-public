import { VMError } from "../errors.ts";
import { nonnegativeBigint } from "./decoders.ts";

/**
 * Direct-page flushes and owner journal activity of the core's translation caches: core
 * runtime profile record v22 fields 210-235 and system trace schema 40, then the fields record
 * v23 (field 236) and system trace schema 41 append, in record order.
 */
export interface CoreTranslationCoherenceProfile {
  readonly jitDirectPageFlushesCpuStateLoaded: bigint;
  readonly jitDirectPageFlushesEventRun: bigint;
  readonly jitDirectPageFlushesSystemInterpreterBoundary: bigint;
  readonly jitDirectPageFlushesLegacyOwnerBoundary: bigint;
  readonly jitDirectPageFlushesDispatchCodePageAdded: bigint;
  readonly jitDirectPageFlushesDecodePageAdded: bigint;
  readonly jitDirectPageFlushesOwnerLargeRange: bigint;
  readonly jitDirectPageFlushesOwnerJournalReset: bigint;
  readonly jitDirectPageFlushesOwnerAddressSpaceSwitch: bigint;
  readonly jitDirectPageReadGenerationAdvances: bigint;
  readonly jitDirectPageWriteGenerationAdvances: bigint;
  readonly jitDirectPageReadZeroFills: bigint;
  readonly jitDirectPageWriteZeroFills: bigint;
  readonly jitDirectPageReadGenerationWraps: bigint;
  readonly jitDirectPageWriteGenerationWraps: bigint;
  readonly jitDirectPageEmptyContextFlushes: bigint;
  readonly jitDirectPageWriteOnlyFlushes: bigint;
  readonly jitOwnerInvalidationsMaterialized: bigint;
  readonly jitOwnerInvalidationsUnmapped: bigint;
  readonly jitOwnerInvalidationsRemapped: bigint;
  readonly jitOwnerInvalidationsDiscarded: bigint;
  readonly jitOwnerInvalidationsProtectionChanged: bigint;
  readonly jitOwnerInvalidationsCodeWritten: bigint;
  readonly jitOwnerTranslationEvictions: bigint;
  readonly jitOwnerJournalResets: bigint;
  readonly jitResidentCachedReentries: bigint;
  readonly jitDirectPageFlushesRamDirtyTrackingReset: bigint;
  readonly jitDirectPageFlushesArchitecturalTlbInvalidation: bigint;
  readonly jitDirectPageFlushesOwnerCheckpoint: bigint;
}

/** The record v22 and system trace schema 40 fields, in core record order. */
export const CORE_TRANSLATION_COHERENCE_KEYS = [
  "jitDirectPageFlushesCpuStateLoaded",
  "jitDirectPageFlushesEventRun",
  "jitDirectPageFlushesSystemInterpreterBoundary",
  "jitDirectPageFlushesLegacyOwnerBoundary",
  "jitDirectPageFlushesDispatchCodePageAdded",
  "jitDirectPageFlushesDecodePageAdded",
  "jitDirectPageFlushesOwnerLargeRange",
  "jitDirectPageFlushesOwnerJournalReset",
  "jitDirectPageFlushesOwnerAddressSpaceSwitch",
  "jitDirectPageReadGenerationAdvances",
  "jitDirectPageWriteGenerationAdvances",
  "jitDirectPageReadZeroFills",
  "jitDirectPageWriteZeroFills",
  "jitDirectPageReadGenerationWraps",
  "jitDirectPageWriteGenerationWraps",
  "jitDirectPageEmptyContextFlushes",
  "jitDirectPageWriteOnlyFlushes",
  "jitOwnerInvalidationsMaterialized",
  "jitOwnerInvalidationsUnmapped",
  "jitOwnerInvalidationsRemapped",
  "jitOwnerInvalidationsDiscarded",
  "jitOwnerInvalidationsProtectionChanged",
  "jitOwnerInvalidationsCodeWritten",
  "jitOwnerTranslationEvictions",
  "jitOwnerJournalResets",
  "jitResidentCachedReentries",
] as const satisfies readonly (keyof CoreTranslationCoherenceProfile)[];

/** The fields record v23 and system trace schema 41 append, in core record order. */
export const CORE_TRANSLATION_COHERENCE_KEYS_V41 = [
  "jitDirectPageFlushesRamDirtyTrackingReset",
] as const satisfies readonly (keyof CoreTranslationCoherenceProfile)[];

/** Record v25 appends this reason after the record v24 event-boundary field. */
export const CORE_TRANSLATION_COHERENCE_KEYS_V44 = [
  "jitDirectPageFlushesArchitecturalTlbInvalidation",
] as const satisfies readonly (keyof CoreTranslationCoherenceProfile)[];

/** Record v30 / trace schema52 appends capture lease retirement after the deferral block. */
export const CORE_TRANSLATION_COHERENCE_KEYS_V52 = [
  "jitDirectPageFlushesOwnerCheckpoint",
] as const satisfies readonly (keyof CoreTranslationCoherenceProfile)[];

/** Every coherence field in core record order, excluding intervening non-coherence fields. */
export const CORE_TRANSLATION_COHERENCE_RECORD_KEYS = [
  ...CORE_TRANSLATION_COHERENCE_KEYS,
  ...CORE_TRANSLATION_COHERENCE_KEYS_V41,
  ...CORE_TRANSLATION_COHERENCE_KEYS_V44,
  ...CORE_TRANSLATION_COHERENCE_KEYS_V52,
] as const;

/** One flush count per `JitMemoryFlushReason`, in reason order. */
const DIRECT_PAGE_FLUSH_KEYS = [
  "jitDirectPageFlushesCpuStateLoaded",
  "jitDirectPageFlushesEventRun",
  "jitDirectPageFlushesSystemInterpreterBoundary",
  "jitDirectPageFlushesLegacyOwnerBoundary",
  "jitDirectPageFlushesDispatchCodePageAdded",
  "jitDirectPageFlushesDecodePageAdded",
  "jitDirectPageFlushesOwnerLargeRange",
  "jitDirectPageFlushesOwnerJournalReset",
  "jitDirectPageFlushesOwnerAddressSpaceSwitch",
  "jitDirectPageFlushesRamDirtyTrackingReset",
  "jitDirectPageFlushesArchitecturalTlbInvalidation",
  "jitDirectPageFlushesOwnerCheckpoint",
] as const satisfies readonly (keyof CoreTranslationCoherenceProfile)[];

/**
 * Builds the profile from values in `CORE_TRANSLATION_COHERENCE_RECORD_KEYS` order; a missing
 * value reads as zero.
 */
export function translationCoherenceFromValues(
  values: readonly bigint[],
): CoreTranslationCoherenceProfile {
  const at = (index: number): bigint => values[index] ?? 0n;
  return {
    jitDirectPageFlushesCpuStateLoaded: at(0),
    jitDirectPageFlushesEventRun: at(1),
    jitDirectPageFlushesSystemInterpreterBoundary: at(2),
    jitDirectPageFlushesLegacyOwnerBoundary: at(3),
    jitDirectPageFlushesDispatchCodePageAdded: at(4),
    jitDirectPageFlushesDecodePageAdded: at(5),
    jitDirectPageFlushesOwnerLargeRange: at(6),
    jitDirectPageFlushesOwnerJournalReset: at(7),
    jitDirectPageFlushesOwnerAddressSpaceSwitch: at(8),
    jitDirectPageReadGenerationAdvances: at(9),
    jitDirectPageWriteGenerationAdvances: at(10),
    jitDirectPageReadZeroFills: at(11),
    jitDirectPageWriteZeroFills: at(12),
    jitDirectPageReadGenerationWraps: at(13),
    jitDirectPageWriteGenerationWraps: at(14),
    jitDirectPageEmptyContextFlushes: at(15),
    jitDirectPageWriteOnlyFlushes: at(16),
    jitOwnerInvalidationsMaterialized: at(17),
    jitOwnerInvalidationsUnmapped: at(18),
    jitOwnerInvalidationsRemapped: at(19),
    jitOwnerInvalidationsDiscarded: at(20),
    jitOwnerInvalidationsProtectionChanged: at(21),
    jitOwnerInvalidationsCodeWritten: at(22),
    jitOwnerTranslationEvictions: at(23),
    jitOwnerJournalResets: at(24),
    jitResidentCachedReentries: at(25),
    jitDirectPageFlushesRamDirtyTrackingReset: at(26),
    jitDirectPageFlushesArchitecturalTlbInvalidation: at(27),
    jitDirectPageFlushesOwnerCheckpoint: at(28),
  };
}

export const EMPTY_CORE_TRANSLATION_COHERENCE = translationCoherenceFromValues([]);

/** The coherence fields a system trace schema carries, in core record order. */
export function translationCoherenceKeysForSchema(
  schemaVersion: number,
): readonly (keyof CoreTranslationCoherenceProfile)[] {
  return schemaVersion >= 52
    ? CORE_TRANSLATION_COHERENCE_RECORD_KEYS
    : schemaVersion >= 44
    ? CORE_TRANSLATION_COHERENCE_RECORD_KEYS.slice(0, 28)
    : schemaVersion >= 41
    ? [...CORE_TRANSLATION_COHERENCE_KEYS, ...CORE_TRANSLATION_COHERENCE_KEYS_V41]
    : schemaVersion >= 40
      ? CORE_TRANSLATION_COHERENCE_KEYS
      : [];
}

/**
 * Decodes the fields of a system trace core profile: all are absent before schema 40, and the
 * RAM dirty-tracking reset flushes before schema 41. A field the schema lacks must be zero.
 */
export function decodeTranslationCoherence(
  profile: Readonly<Record<string, unknown>>,
  schemaVersion: number,
): CoreTranslationCoherenceProfile {
  const keys = translationCoherenceKeysForSchema(schemaVersion);
  if (
    CORE_TRANSLATION_COHERENCE_RECORD_KEYS.slice(keys.length).some(
      (key) => profile[key] !== undefined && nonnegativeBigint(profile[key], key) !== 0n,
    )
  ) {
    throw new VMError("PROTOCOL_ERROR", "legacy translation coherence profile is not empty");
  }
  if (keys.length === 0) return EMPTY_CORE_TRANSLATION_COHERENCE;
  const decoded = translationCoherenceFromValues(
    keys.map((key) => nonnegativeBigint(profile[key], key)),
  );
  if (!translationCoherenceReconciles(decoded)) {
    throw new VMError("PROTOCOL_ERROR", "translation coherence counters do not reconcile");
  }
  return decoded;
}

/**
 * Every flush is one reason count, and every flush of a live context is one outcome per cache
 * in its scope: write outcomes are all flushes less the empty-context ones, and read outcomes
 * also exclude the write-only ones. Every owner journal reset is its own reset flush.
 */
export function translationCoherenceReconciles(
  profile: CoreTranslationCoherenceProfile,
): boolean {
  const flushes = DIRECT_PAGE_FLUSH_KEYS.reduce((total, key) => total + profile[key], 0n);
  const live = flushes - profile.jitDirectPageEmptyContextFlushes;
  return live >= 0n
    && profile.jitDirectPageWriteGenerationAdvances + profile.jitDirectPageWriteZeroFills === live
    && profile.jitDirectPageReadGenerationAdvances + profile.jitDirectPageReadZeroFills
      === live - profile.jitDirectPageWriteOnlyFlushes
    && profile.jitDirectPageReadGenerationWraps <= profile.jitDirectPageReadGenerationAdvances
    && profile.jitDirectPageWriteGenerationWraps <= profile.jitDirectPageWriteGenerationAdvances
    && profile.jitOwnerJournalResets === profile.jitDirectPageFlushesOwnerJournalReset;
}
