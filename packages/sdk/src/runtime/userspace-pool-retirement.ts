import { decodeWorkerBindingRetirement, readWorkerBindingFields, type WorkerBindingRetirement } from "./userspace-worker-binding-retirement.ts";

export type PoolCpuAuthority = { readonly kind: "exiting-task" }
  | { readonly kind: "last-request"; readonly work: { readonly poolId: bigint; readonly sequence: bigint } };

export type PoolRetirementProgress =
  | { readonly kind: "registered-ring"; readonly slot: number; readonly ringObjectId: bigint; readonly ringOpenFileId: bigint }
  | { readonly kind: "worker-binding"; readonly ringObjectId: bigint; readonly binding: WorkerBindingRetirement }
  | { readonly kind: "owner"; readonly allocationId: bigint; readonly allocationCgroupId: bigint; readonly references: bigint };

/** Trace49 and failure9 share this bounded 80-byte original pool-resource payload. */
export function decodePoolRetirementProgress(view: DataView, at: number, poolAllocationId: bigint): PoolRetirementProgress | undefined {
  if (!Number.isSafeInteger(at) || at < 0 || view.byteLength - at < 80 || !identity(poolAllocationId)) return undefined;
  const kind = view.getUint8(at), slot = view.getUint8(at + 1);
  const ringObjectId = view.getBigUint64(at + 8, true), ringOpenFileId = view.getBigUint64(at + 16, true);
  if (!zero(view, at + 2, at + 8) || !zero(view, at + 72, at + 80)) return undefined;
  if (kind === 1 && slot < 16 && identity(ringObjectId) && identity(ringOpenFileId) && zero(view, at + 24, at + 72)) {
    return { kind: "registered-ring", slot, ringObjectId, ringOpenFileId };
  }
  if (kind === 2 && slot === 0 && identity(ringObjectId) && ringOpenFileId === 0n) {
    const binding = decodeWorkerBindingRetirement(36, readWorkerBindingFields(view, at + 24));
    return binding?.poolAllocationId === poolAllocationId ? { kind: "worker-binding", ringObjectId, binding } : undefined;
  }
  const allocationId = view.getBigUint64(at + 24, true), allocationCgroupId = view.getBigUint64(at + 32, true), references = view.getBigUint64(at + 40, true);
  if (kind === 3 && slot === 0 && ringObjectId === 0n && ringOpenFileId === 0n && allocationId === poolAllocationId
    && identity(allocationCgroupId) && identity(references) && zero(view, at + 48, at + 72)) {
    return { kind: "owner", allocationId, allocationCgroupId, references };
  }
  return undefined;
}

export function decodePoolCpuAuthority(kind: number, poolId: bigint, sequence: bigint, ownerPoolId: bigint): PoolCpuAuthority | undefined {
  if (!identity(ownerPoolId)) return undefined;
  if (kind === 1 && poolId === 0n && sequence === 0n) return { kind: "exiting-task" };
  if (kind === 2 && poolId === ownerPoolId && identity(sequence)) return { kind: "last-request", work: { poolId, sequence } };
  return undefined;
}

export function poolRetirementProgressDetail(progress: PoolRetirementProgress) {
  if (progress.kind === "registered-ring") return { ...progress, ringObjectId: progress.ringObjectId.toString(), ringOpenFileId: progress.ringOpenFileId.toString() };
  if (progress.kind === "owner") return { ...progress, allocationId: progress.allocationId.toString(), allocationCgroupId: progress.allocationCgroupId.toString(), references: progress.references.toString() };
  const { metadata, ...binding } = progress.binding;
  return { ...progress, ringObjectId: progress.ringObjectId.toString(), binding: { ...binding,
    poolAllocationId: binding.poolAllocationId.toString(), poolAllocationCgroupId: binding.poolAllocationCgroupId.toString(),
    ...(metadata === undefined ? {} : { metadata: { allocationId: metadata.allocationId.toString(), allocationCgroupId: metadata.allocationCgroupId.toString(), references: metadata.references.toString() } }),
  } };
}

export function poolCpuAuthorityDetail(authority: PoolCpuAuthority) {
  return authority.kind === "exiting-task" ? authority : { kind: authority.kind,
    work: { poolId: authority.work.poolId.toString(), sequence: authority.work.sequence.toString() } };
}

function identity(value: bigint): boolean { return value > 0n && value < 0xffff_ffff_ffff_ffffn; }
function zero(view: DataView, start: number, end: number): boolean {
  for (let at = start; at < end; at++) if (view.getUint8(at) !== 0) return false;
  return true;
}
