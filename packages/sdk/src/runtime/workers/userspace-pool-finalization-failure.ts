import { VMError } from "../errors.ts";
import { decodePoolCpuAuthority, decodePoolRetirementProgress, poolCpuAuthorityDetail, poolRetirementProgressDetail, type PoolCpuAuthority, type PoolRetirementProgress } from "../userspace-pool-retirement.ts";
import { decodeFinalizationSource, finalizationSourceDetail, type FinalizationSource } from "./userspace-finalization-source.ts";
import { isResourceExitSyscall } from "../userspace-exited-resource-source.ts";

type Account = { readonly cpuCgroupId: bigint; readonly authority: PoolCpuAuthority };
export type UserspacePoolFinalizationFailure = {
  readonly kind: "pool"; readonly errno: number; readonly guestTicks: bigint;
  readonly identity: { readonly poolAllocationId: bigint; readonly ownerPid: number; readonly ownerTid: number;
    readonly source: Exclude<FinalizationSource, { readonly kind: "worker" }> };
} & (
  | { readonly stage: "selection"; readonly account?: Account; readonly progress?: never }
  | { readonly stage: "admission" | "resource"; readonly account: Account; readonly progress: PoolRetirementProgress }
  | { readonly stage: "ownership"; readonly account: Account; readonly progress: Extract<PoolRetirementProgress, { readonly kind: "owner" }> }
);

export function decodePoolFinalizationFailure(bytes: Uint8Array, view: DataView, guestTicks: bigint, stage: number, errno: number): UserspacePoolFinalizationFailure {
  const poolAllocationId = view.getBigUint64(24, true), ownerTidValue = view.getBigUint64(32, true), ownerPid = view.getUint32(188, true);
  const cpuCgroupId = view.getBigUint64(40, true), authorityKind = view.getUint8(184);
  const poolId = view.getBigUint64(272, true), sequence = view.getBigUint64(280, true);
  if (bytes.byteLength !== 320 || guestTicks === 0n || !identity(poolAllocationId) || ownerPid === 0 || ownerPid > 0x7fff_ffff
    || ownerTidValue === 0n || ownerTidValue > 0x7fff_ffffn || view.getUint8(17) !== 1 || view.getUint8(18) !== 2
    || nonzero(bytes, 185, 188) || nonzero(bytes, 288, 320)) throw malformed();
  const source = decodeFinalizationSource(bytes, view, guestTicks);
  if (source.kind === "worker" || source.pid !== ownerPid || source.tid > 0x7fff_ffff
    || source.kind === "syscall" && !isResourceExitSyscall(source.number, source.decision, Number(ownerTidValue), source.tid)) throw malformed();
  let account: Account | undefined;
  if (cpuCgroupId === 0n && authorityKind === 0 && poolId === 0n && sequence === 0n) account = undefined;
  else {
    const authority = decodePoolCpuAuthority(authorityKind, poolId, sequence, poolAllocationId);
    if (!identity(cpuCgroupId) || authority === undefined) throw malformed();
    account = { cpuCgroupId, authority };
  }
  const progress = view.getUint8(192) === 0 ? undefined : decodePoolRetirementProgress(view, 192, poolAllocationId);
  if (progress === undefined && nonzero(bytes, 192, 272)) throw malformed();
  const base = { kind: "pool" as const, errno, guestTicks,
    identity: { poolAllocationId, ownerPid, ownerTid: Number(ownerTidValue), source } };
  if (stage === 4 && progress === undefined) return { ...base, stage: "selection", ...(account === undefined ? {} : { account }) };
  if (account === undefined || progress === undefined) throw malformed();
  if (stage === 5 || stage === 6) return { ...base, stage: stage === 5 ? "admission" : "resource", account, progress };
  if (stage === 7 && progress.kind === "owner") return { ...base, stage: "ownership", account, progress };
  throw malformed();
}

export function poolFinalizationFailureDetail(failure: UserspacePoolFinalizationFailure) {
  const { identity: owner } = failure;
  return { reason: "io-finalization-failure", kind: failure.kind, stage: failure.stage, errno: failure.errno,
    guestTicks: failure.guestTicks.toString(), poolAllocationId: owner.poolAllocationId.toString(), ownerPid: owner.ownerPid, ownerTid: owner.ownerTid,
    source: finalizationSourceDetail(owner.source),
    ...(failure.account === undefined ? {} : { cpuCgroupId: failure.account.cpuCgroupId.toString(), authority: poolCpuAuthorityDetail(failure.account.authority) }),
    ...(failure.progress === undefined ? {} : { progress: poolRetirementProgressDetail(failure.progress) }),
  };
}

function identity(value: bigint): boolean { return value > 0n && value < 0xffff_ffff_ffff_ffffn; }
function nonzero(bytes: Uint8Array, start: number, end: number): boolean { return bytes.subarray(start, end).some(byte => byte !== 0); }
function malformed(): VMError { return new VMError("PROTOCOL_ERROR", "Userspace task-pool finalization failure is malformed"); }
