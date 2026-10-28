export interface WorkerBindingRetirement {
  readonly kind: "worker-bindings";
  readonly phase: "worker-binding";
  readonly poolAllocationId: bigint;
  readonly poolAllocationCgroupId: bigint;
  readonly poolsBefore: number;
  readonly bindingsBefore: number;
  readonly metadataPagesBefore: number;
  readonly metadata?: { readonly allocationId: bigint; readonly allocationCgroupId: bigint; readonly references: bigint };
}

export interface WorkerBindingFields {
  readonly poolAllocationId: bigint;
  readonly poolAllocationCgroupId: bigint;
  readonly metadataAllocationId: bigint;
  readonly metadataAllocationCgroupId: bigint;
  readonly poolsBefore: number;
  readonly bindingsBefore: number;
  readonly metadataPagesBefore: number;
  readonly reserved: number;
  readonly metadataReferences: bigint;
}

/** Trace48 and canonical failure8 carry one identical, bounded 48-byte owner record. */
export function readWorkerBindingFields(view: DataView, at: number): WorkerBindingFields {
  return { poolAllocationId: view.getBigUint64(at, true), poolAllocationCgroupId: view.getBigUint64(at + 8, true),
    metadataAllocationId: view.getBigUint64(at + 16, true), metadataAllocationCgroupId: view.getBigUint64(at + 24, true),
    poolsBefore: view.getUint16(at + 32, true), bindingsBefore: view.getUint16(at + 34, true),
    metadataPagesBefore: view.getUint8(at + 36), reserved: view.getUint8(at + 37) + view.getUint16(at + 38, true) * 256,
    metadataReferences: view.getBigUint64(at + 40, true) };
}

export function decodeWorkerBindingRetirement(phase: number, raw: WorkerBindingFields): WorkerBindingRetirement | undefined {
  const { poolAllocationId, poolAllocationCgroupId, poolsBefore, bindingsBefore, metadataPagesBefore } = raw;
  if (phase !== 36 || !identity(poolAllocationId) || !identity(poolAllocationCgroupId) || raw.reserved !== 0
    || !count(poolsBefore, 4096) || !count(bindingsBefore, 4096)) return undefined;
  const pages = Math.ceil((1024 + bindingsBefore * 128) / 4096) - 1;
  if (metadataPagesBefore !== pages) return undefined;
  const base = { kind: "worker-bindings" as const, phase: "worker-binding" as const,
    poolAllocationId, poolAllocationCgroupId, poolsBefore, bindingsBefore, metadataPagesBefore };
  if (Math.ceil((1024 + (bindingsBefore - 1) * 128) / 4096) - 1 === pages) {
    return raw.metadataAllocationId === 0n && raw.metadataAllocationCgroupId === 0n && raw.metadataReferences === 0n ? base : undefined;
  }
  if (!identity(raw.metadataAllocationId) || raw.metadataAllocationId === poolAllocationId
    || !identity(raw.metadataAllocationCgroupId) || !identity(raw.metadataReferences)) return undefined;
  return { ...base, metadata: { allocationId: raw.metadataAllocationId,
    allocationCgroupId: raw.metadataAllocationCgroupId, references: raw.metadataReferences } };
}

function identity(value: bigint): boolean { return value > 0n && value < 0xffff_ffff_ffff_ffffn; }
function count(value: number, maximum: number): boolean { return Number.isSafeInteger(value) && value > 0 && value <= maximum; }
