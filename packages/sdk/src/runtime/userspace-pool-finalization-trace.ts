import { VMError } from "./errors.ts";
import { decodePoolCpuAuthority, decodePoolRetirementProgress, type PoolCpuAuthority, type PoolRetirementProgress } from "./userspace-pool-retirement.ts";
import { decodeExitedResourceTraceSource, type ExitedResourceSource as Source } from "./userspace-exited-resource-source.ts";

const RESERVED = [[128, 152], [232, 235], [238, 240], [252, 272], [288, 512], [513, 520], [536, 544], [624, 992]] as const;
export type UserspacePoolFinalizationTrace = {
  readonly poolAllocationId: bigint;
  readonly ownerPid: number;
  readonly ownerTid: number;
  readonly guestTicks: bigint;
  readonly cpuCgroupId: bigint;
  readonly authority: PoolCpuAuthority;
  readonly source: Source;
} & (
  | { readonly done: false; readonly progress: Exclude<PoolRetirementProgress, { readonly kind: "owner" }> }
  | { readonly done: true; readonly progress: Extract<PoolRetirementProgress, { readonly kind: "owner" }> }
);

/** Tag6 identifies original task resources separately from rings and submitted requests. */
export function decodePoolFinalizationTrace(bytes: Uint8Array, view: DataView, at: number, version: number): UserspacePoolFinalizationTrace {
  if (version < 49 || !Number.isSafeInteger(at) || at < 0 || view.byteLength - at < 992 || bytes.byteLength - at < 992) throw malformed();
  const poolAllocationId = view.getBigUint64(at + 192, true), ownerTidValue = view.getBigUint64(at + 200, true);
  const ownerPid = view.getUint32(at + 248, true), guestTicks = view.getBigUint64(at + 208, true);
  const admittedGuestTicks = view.getBigUint64(at + 216, true), cpuCgroupId = view.getBigUint64(at + 224, true);
  const done = view.getUint8(at + 235);
  if (!identity(poolAllocationId) || !identity(cpuCgroupId) || ownerPid === 0 || ownerPid > 0x7fff_ffff
    || ownerPid !== view.getUint32(at + 24, true) || ownerTidValue === 0n || ownerTidValue > 0x7fff_ffffn
    || view.getUint32(at + 28, true) > 0x7fff_ffff
    || guestTicks === 0n || admittedGuestTicks > guestTicks || done > 1
    || view.getBigUint64(at + 112, true) !== 0n || view.getUint8(at + 122) !== 0
    || view.getUint8(at + 120) !== (done === 1 ? 4 : 2)
    || RESERVED.some(([start, end]) => nonzero(bytes, at, start, end))) throw malformed();
  const authority = decodePoolCpuAuthority(view.getUint8(at + 512), view.getBigUint64(at + 520, true), view.getBigUint64(at + 528, true), poolAllocationId);
  const progress = decodePoolRetirementProgress(view, at + 544, poolAllocationId);
  const source = decodeExitedResourceTraceSource(bytes, view, at, admittedGuestTicks);
  if (authority === undefined || progress === undefined) throw malformed();
  const base = { poolAllocationId, ownerPid, ownerTid: Number(ownerTidValue), guestTicks, cpuCgroupId, authority, source };
  if (done === 1 && progress.kind === "owner") return { ...base, done: true, progress };
  if (done === 0 && progress.kind !== "owner") return { ...base, done: false, progress };
  throw malformed();
}


function identity(value: bigint): boolean { return value > 0n && value < 0xffff_ffff_ffff_ffffn; }
function nonzero(bytes: Uint8Array, at: number, start: number, end: number): boolean { return bytes.subarray(at + start, at + end).some(byte => byte !== 0); }
function malformed(): VMError { return new VMError("PROTOCOL_ERROR", "Userspace task-pool finalization trace is malformed"); }
