/** One existing NAPI ID, original page allocation or empty retirement owner. */
export type NapiRetirement =
  | { readonly kind: "napi"; readonly phase: "napi-id"; readonly originalEntries: number;
      readonly idsBefore: number; readonly metadataPagesBefore: number; readonly napiId: number;
      readonly expiryJiffies: bigint }
  | { readonly kind: "napi"; readonly phase: "napi-metadata"; readonly originalEntries: number;
      readonly metadataPagesBefore: number; readonly metadataAllocationId: bigint;
      readonly allocationCgroupId: bigint }
  | { readonly kind: "napi"; readonly phase: "napi-owner"; readonly originalEntries: number };

export interface NapiRetirementFields {
  readonly originalEntries: number;
  readonly idsBefore: number;
  readonly metadataPagesBefore: number;
  readonly napiId: number;
  readonly expiryJiffies: bigint;
  readonly metadataAllocationId: bigint;
  readonly allocationCgroupId: bigint;
}

/** Both transports reserve the same exact forty-byte field payload. */
export function readNapiRetirementFields(view: DataView, at: number): NapiRetirementFields {
  return { originalEntries: view.getUint32(at, true), idsBefore: view.getUint32(at + 4, true),
    metadataPagesBefore: view.getUint32(at + 8, true), napiId: view.getUint32(at + 12, true),
    expiryJiffies: view.getBigUint64(at + 16, true), metadataAllocationId: view.getBigUint64(at + 24, true),
    allocationCgroupId: view.getBigUint64(at + 32, true) };
}

export function decodeNapiRetirement(phase: number, raw: NapiRetirementFields): NapiRetirement | undefined {
  const { originalEntries, idsBefore, metadataPagesBefore, napiId, expiryJiffies,
    metadataAllocationId, allocationCgroupId } = raw;
  if (!uint(originalEntries, 0xffff_fffe) || !uint(idsBefore, originalEntries)
    || !uint(metadataPagesBefore, Math.ceil(originalEntries / 64)) || !uint(napiId, 0xffff_ffff)) return undefined;
  if (phase === 15 && idsBefore > 0 && metadataPagesBefore === Math.ceil(originalEntries / 64)
    && napiId >= 2 && expiryJiffies >= 6000n && expiryJiffies <= 0xffff_ffff_ffff_ffffn / 10_000_000n + 6000n
    && metadataAllocationId === 0n && allocationCgroupId === 0n) {
    return { kind: "napi", phase: "napi-id", originalEntries, idsBefore,
      metadataPagesBefore, napiId, expiryJiffies };
  }
  if (idsBefore !== 0 || napiId !== 0 || expiryJiffies !== 0n) return undefined;
  if (phase === 16 && metadataPagesBefore > 0 && identity(metadataAllocationId) && identity(allocationCgroupId)) {
    return { kind: "napi", phase: "napi-metadata", originalEntries, metadataPagesBefore,
      metadataAllocationId, allocationCgroupId };
  }
  if (phase === 17 && metadataPagesBefore === 0 && metadataAllocationId === 0n && allocationCgroupId === 0n) {
    return { kind: "napi", phase: "napi-owner", originalEntries };
  }
  return undefined;
}

function uint(value: number, max: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function identity(value: bigint): boolean { return value > 0n && value <= 0xffff_ffff_ffff_ffffn; }
