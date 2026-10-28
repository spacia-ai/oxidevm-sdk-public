/** The exact original credential, index entry or allocation selected before cleanup. */
type Base = { readonly kind: "personalities" };
type Credential = { readonly credentialId: bigint; readonly groups: number };
type Allocation = { readonly allocationId: bigint; readonly allocationCgroupId: bigint };
export type PersonalityRetirement = Base & (
  | { readonly phase: "personality-id"; readonly id: number; readonly credentialId: bigint; readonly idsBefore: number; readonly referencesBefore: number }
  | (Credential & { readonly phase: "personality-snapshot"; readonly snapshotsBefore: number; readonly metadataPages: number })
  | (Credential & Allocation & { readonly phase: "personality-snapshot-metadata"; readonly pagesBefore: number })
  | (Credential & { readonly phase: "personality-snapshot-owner" })
  | { readonly phase: "personality-free-range"; readonly start: number; readonly end: number; readonly rangesBefore: number }
  | (Allocation & { readonly phase: "personality-metadata"; readonly originalPages: number; readonly pagesBefore: number })
  | { readonly phase: "personality-owner" }
);

export interface PersonalityRetirementFields {
  readonly credentialId: bigint;
  readonly count: number;
  readonly second: number;
  readonly id: number;
  readonly end: number;
  readonly pages: number;
  readonly allocationId: bigint;
  readonly allocationCgroupId: bigint;
}

/** Trace46 and OXFF6 share this forty-byte payload and its single semantic decoder. */
export function readPersonalityRetirementFields(view: DataView, at: number): PersonalityRetirementFields {
  return { credentialId: view.getBigUint64(at, true), count: view.getUint32(at + 8, true), second: view.getUint32(at + 12, true),
    id: view.getUint16(at + 16, true), end: view.getUint16(at + 18, true), pages: view.getUint32(at + 20, true),
    allocationId: view.getBigUint64(at + 24, true), allocationCgroupId: view.getBigUint64(at + 32, true) };
}

export function decodePersonalityRetirement(phase: number, raw: PersonalityRetirementFields): PersonalityRetirement | undefined {
  const { credentialId, count, second, id, end, pages, allocationId, allocationCgroupId } = raw;
  if (!uint(count, 65535) || !uint(second, 65536) || !uint(id, 65535) || !uint(end, 65535) || !uint(pages, 65)) return undefined;
  const base = { kind: "personalities" as const };
  const noIndex = id === 0 && end === 0, noAllocation = allocationId === 0n && allocationCgroupId === 0n;
  const credential = identity(credentialId) && credentialId !== 0xffff_ffff_ffff_ffffn;
  if (phase === 23 && credential && count > 0 && second > 0 && second <= count
    && id > 0 && end === 0 && pages === 0 && noAllocation) {
    return { ...base, phase: "personality-id", id, credentialId, idsBefore: count, referencesBefore: second };
  }
  if (phase === 24 && credential && count > 0 && noIndex && noAllocation && pages === snapshotPages(second)) {
    return { ...base, phase: "personality-snapshot", credentialId, groups: second, snapshotsBefore: count, metadataPages: pages };
  }
  if (phase === 25 && credential && count > 0 && count <= snapshotPages(second) && noIndex
    && pages === 0 && identity(allocationId) && identity(allocationCgroupId)) {
    return { ...base, phase: "personality-snapshot-metadata", credentialId, groups: second, pagesBefore: count, allocationId, allocationCgroupId };
  }
  if (phase === 26 && credential && count === 0 && noIndex && pages === 0 && noAllocation) {
    return { ...base, phase: "personality-snapshot-owner", credentialId, groups: second };
  }
  if (credentialId !== 0n) return undefined;
  if (phase === 27 && count > 0 && count <= 32768 && second === 0 && id > 0 && end >= id && pages === 0 && noAllocation) {
    return { ...base, phase: "personality-free-range", start: id, end, rangesBefore: count };
  }
  if (phase === 28 && count > 0 && count <= second && second <= 1024 && noIndex && pages === 0
    && identity(allocationId) && identity(allocationCgroupId)) {
    return { ...base, phase: "personality-metadata", originalPages: second, pagesBefore: count, allocationId, allocationCgroupId };
  }
  if (phase === 29 && count === 0 && second === 0 && noIndex && pages === 0 && noAllocation) {
    return { ...base, phase: "personality-owner" };
  }
  return undefined;
}

function snapshotPages(groups: number): number { return Math.ceil((256 + groups * 4) / 4096); }
function uint(value: number, max: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function identity(value: bigint): boolean { return value > 0n && value <= 0xffff_ffff_ffff_ffffn; }
