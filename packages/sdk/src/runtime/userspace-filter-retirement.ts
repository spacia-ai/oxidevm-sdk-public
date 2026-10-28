type Identity = { readonly backingId: bigint; readonly parentBackingId: bigint; readonly instructions: number; readonly opcode: number };
type Base = { readonly kind: "filters" };
export type FilterRetirement = Base & (
  | (Identity & { readonly phase: "filter-reference"; readonly references: bigint })
  | (Identity & { readonly phase: "filter-program-reference"; readonly references: bigint })
  | (Identity & { readonly phase: "filter-node" })
  | (Identity & { readonly phase: "filter-program-owner" })
  | (Identity & { readonly phase: "filter-program-page"; readonly pagesBefore: number; readonly offset: bigint;
      readonly allocationId: bigint; readonly allocationCgroupId: bigint })
  | { readonly phase: "filter-owner" }
);

export interface FilterRetirementFields extends Identity {
  readonly allocationOrReferences: bigint;
  readonly allocationCgroupId: bigint;
  readonly pagesBefore: number;
  readonly reserved: number;
  readonly offset: bigint;
}

/** Trace47 and OXFF7 share one 48-byte payload, including full 64-bit page offsets. */
export function readFilterRetirementFields(view: DataView, at: number): FilterRetirementFields {
  return { backingId: view.getBigUint64(at, true), parentBackingId: view.getBigUint64(at + 8, true),
    allocationOrReferences: view.getBigUint64(at + 16, true), allocationCgroupId: view.getBigUint64(at + 24, true),
    instructions: view.getUint16(at + 32, true), opcode: view.getUint8(at + 34), pagesBefore: view.getUint8(at + 35),
    reserved: view.getUint32(at + 36, true), offset: view.getBigUint64(at + 40, true) };
}

export function decodeFilterRetirement(phase: number, raw: FilterRetirementFields): FilterRetirement | undefined {
  const { backingId, parentBackingId, instructions, opcode, allocationOrReferences, allocationCgroupId, pagesBefore, reserved, offset } = raw;
  if (reserved !== 0 || !uint(instructions, 4096) || !uint(opcode, 64) || !uint(pagesBefore, 9)) return undefined;
  const base = { kind: "filters" as const };
  if (phase === 35 && backingId === 0n && parentBackingId === 0n && instructions === 0 && opcode === 0
    && allocationOrReferences === 0n && allocationCgroupId === 0n && pagesBefore === 0 && offset === 0n) {
    return { ...base, phase: "filter-owner" };
  }
  if (!backing(backingId) || parentBackingId !== 0n && !backing(parentBackingId) || parentBackingId === backingId || instructions === 0) return undefined;
  const identity = { backingId, parentBackingId, instructions, opcode };
  if ((phase === 30 || phase === 32) && allocationOrReferences > 1n && identityValue(allocationOrReferences)
    && allocationCgroupId === 0n && pagesBefore === 0 && offset === 0n) {
    return { ...base, ...identity, phase: phase === 30 ? "filter-reference" : "filter-program-reference", references: allocationOrReferences };
  }
  if ((phase === 31 || phase === 34) && allocationOrReferences === 0n && allocationCgroupId === 0n && pagesBefore === 0 && offset === 0n) {
    return { ...base, ...identity, phase: phase === 31 ? "filter-node" : "filter-program-owner" };
  }
  if (phase === 33 && identityValue(allocationOrReferences) && identityValue(allocationCgroupId)
    && pagesBefore > 0 && pagesBefore <= Math.ceil((64 + instructions * 8) / 4096) && offset === BigInt(pagesBefore - 1) * 4096n) {
    return { ...base, ...identity, phase: "filter-program-page", pagesBefore, offset,
      allocationId: allocationOrReferences, allocationCgroupId };
  }
  return undefined;
}

export function filterRetirementDetail(progress: FilterRetirement) {
  if (progress.phase === "filter-owner") return progress;
  const base = { kind: progress.kind, phase: progress.phase, backingId: progress.backingId.toString(),
    parentBackingId: progress.parentBackingId.toString(), instructions: progress.instructions, opcode: progress.opcode };
  if (progress.phase === "filter-program-page") return { ...base, pagesBefore: progress.pagesBefore, offset: progress.offset.toString(),
    allocationId: progress.allocationId.toString(), allocationCgroupId: progress.allocationCgroupId.toString() };
  if (progress.phase === "filter-reference" || progress.phase === "filter-program-reference") return { ...base, references: progress.references.toString() };
  return base;
}

function uint(value: number, maximum: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function identityValue(value: bigint): boolean { return value > 0n && value < 0xffff_ffff_ffff_ffffn; }
function backing(value: bigint): boolean { return value >= 1n << 48n && value < 0xffff_ffff_ffff_ffffn && value % 4096n === 0n; }
