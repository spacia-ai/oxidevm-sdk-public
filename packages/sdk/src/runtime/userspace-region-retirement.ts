/** One original region reservation, physical page, metadata allocation or empty owner. */
type RegionBase = { readonly kind: "region"; readonly originalPages: number };
type Storage = "user" | "kernel";
type Metadata = { readonly metadataPagesBefore: number };
type Allocation = { readonly allocationId: bigint; readonly allocationCgroupId: bigint };
export type RegionRetirement = RegionBase & (
  | (Metadata & { readonly phase: "region-unaccount"; readonly storage: Storage; readonly uid?: number; readonly lockedPagesBefore: bigint })
  | (Metadata & Allocation & { readonly phase: "region-user-pin"; readonly storage: "user"; readonly pinsBefore: number })
  | (Metadata & Allocation & { readonly phase: "region-kernel-page"; readonly storage: "kernel"; readonly pagesBefore: number; readonly backingId: bigint; readonly offset: bigint })
  | (Metadata & Allocation & { readonly phase: "region-metadata"; readonly storage: Storage })
  | { readonly phase: "region-owner"; readonly storage: Storage }
);

export interface RegionRetirementFields {
  readonly originalPages: number;
  readonly remainingPages: number;
  readonly metadataPagesBefore: number;
  readonly storage: number;
  readonly reserved: number;
  readonly first: bigint;
  readonly second: bigint;
  readonly allocationId: bigint;
  readonly allocationCgroupId: bigint;
}

/** Trace45 and OXFF5 carry the same exact forty-eight-byte payload. */
export function readRegionRetirementFields(view: DataView, at: number): RegionRetirementFields {
  return { originalPages: view.getUint32(at, true), remainingPages: view.getUint32(at + 4, true),
    metadataPagesBefore: view.getUint32(at + 8, true), storage: view.getUint8(at + 12),
    reserved: view.getUint8(at + 13) | view.getUint16(at + 14, true),
    first: view.getBigUint64(at + 16, true), second: view.getBigUint64(at + 24, true),
    allocationId: view.getBigUint64(at + 32, true), allocationCgroupId: view.getBigUint64(at + 40, true) };
}

export function decodeRegionRetirement(phase: number, raw: RegionRetirementFields): RegionRetirement | undefined {
  const { originalPages, remainingPages, metadataPagesBefore, first, second, allocationId, allocationCgroupId } = raw;
  const storage = raw.storage === 1 ? "user" : raw.storage === 2 ? "kernel" : undefined;
  if (storage === undefined || raw.reserved !== 0 || !uint(originalPages, 0x7fff_ffff) || originalPages === 0
    || !uint(remainingPages, originalPages)) return undefined;
  // Mirror registered_region::metadata_pages and its 512 MiB allocation ceiling.
  const metadataBytes = storage === "user" ? 128 + originalPages * 32 : 128;
  if (metadataBytes > 512 * 1024 * 1024) return undefined;
  const originalMetadata = Math.ceil(metadataBytes / 4096);
  if (!uint(metadataPagesBefore, originalMetadata)) return undefined;
  const base = { kind: "region" as const, originalPages };
  if (phase === 18 && remainingPages === originalPages && metadataPagesBefore === originalMetadata
    && first >= 0n && first <= 0xffff_ffffn && second === BigInt(originalPages)
    && allocationId === 0n && allocationCgroupId === 0n) {
    return { ...base, phase: "region-unaccount", storage, metadataPagesBefore,
      lockedPagesBefore: second, ...(first === 0n ? {} : { uid: Number(first - 1n) }) };
  }
  if (phase === 19 && storage === "user" && remainingPages > 0 && metadataPagesBefore === originalMetadata
    && first === 0n && second === 0n && identity(allocationId) && identity(allocationCgroupId)) {
    return { ...base, phase: "region-user-pin", storage, metadataPagesBefore, pinsBefore: remainingPages, allocationId, allocationCgroupId };
  }
  if (phase === 20 && storage === "kernel" && remainingPages > 0 && metadataPagesBefore === 1
    && first >= 1n << 48n && first % 4096n === 0n && first + BigInt(originalPages) * 4096n <= 0xffff_ffff_ffff_ffffn
    && second === BigInt(remainingPages - 1) * 4096n && identity(allocationId) && identity(allocationCgroupId)) {
    return { ...base, phase: "region-kernel-page", storage, metadataPagesBefore, pagesBefore: remainingPages,
      backingId: first, offset: second, allocationId, allocationCgroupId };
  }
  if (remainingPages !== 0 || first !== 0n || second !== 0n) return undefined;
  if (phase === 21 && metadataPagesBefore > 0 && identity(allocationId) && identity(allocationCgroupId)) {
    return { ...base, phase: "region-metadata", storage, metadataPagesBefore, allocationId, allocationCgroupId };
  }
  if (phase === 22 && metadataPagesBefore === 0 && allocationId === 0n && allocationCgroupId === 0n) {
    return { ...base, phase: "region-owner", storage };
  }
  return undefined;
}

function uint(value: number, max: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function identity(value: bigint): boolean { return value > 0n && value <= 0xffff_ffff_ffff_ffffn; }
