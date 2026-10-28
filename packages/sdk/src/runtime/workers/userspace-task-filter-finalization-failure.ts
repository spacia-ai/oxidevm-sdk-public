import { VMError } from "../errors.ts";
import { isResourceExitSyscall } from "../userspace-exited-resource-source.ts";
import { decodeFilterRetirement, filterRetirementDetail, readFilterRetirementFields, type FilterRetirement } from "../userspace-filter-retirement.ts";
import { decodeFinalizationSource, finalizationSourceDetail, type FinalizationSource } from "./userspace-finalization-source.ts";

export type UserspaceTaskFilterFinalizationFailure = {
  readonly kind: "task-filters"; readonly errno: number; readonly guestTicks: bigint;
  readonly identity: { readonly rootBackingId: bigint; readonly ownerPid: number; readonly ownerTid: number;
    readonly cpuCgroupId: bigint; readonly source: Exclude<FinalizationSource, { readonly kind: "worker" }> };
} & (
  | { readonly stage: "selection"; readonly progress?: never }
  | { readonly stage: "admission" | "resource"; readonly progress: FilterRetirement }
  | { readonly stage: "ownership"; readonly progress: Extract<FilterRetirement, { readonly phase: "filter-owner" }> }
);

export function decodeTaskFilterFinalizationFailure(bytes: Uint8Array, view: DataView, guestTicks: bigint, stage: number, errno: number): UserspaceTaskFilterFinalizationFailure {
  const rootBackingId = view.getBigUint64(24, true), ownerTidValue = view.getBigUint64(32, true);
  const ownerPid = view.getUint32(188, true), cpuCgroupId = view.getBigUint64(40, true);
  if (bytes.byteLength !== 320 || guestTicks === 0n || rootBackingId < 1n << 48n || rootBackingId >= 0xffff_ffff_ffff_ffffn
    || rootBackingId % 4096n !== 0n || ownerPid === 0 || ownerPid > 0x7fff_ffff
    || ownerTidValue === 0n || ownerTidValue > 0x7fff_ffffn || cpuCgroupId === 0n || cpuCgroupId === 0xffff_ffff_ffff_ffffn
    || view.getUint8(17) !== 1 || view.getUint8(18) !== 3 || bytes[187] !== 0
    || nonzero(bytes,192,208) || nonzero(bytes,256,320)) throw malformed();
  const source = decodeFinalizationSource(bytes, view, guestTicks);
  if (source.kind === "worker" || source.pid !== ownerPid || source.tid > 0x7fff_ffff
    || source.kind === "syscall" && !isResourceExitSyscall(source.number, source.decision, Number(ownerTidValue), source.tid)) throw malformed();
  const base = { kind: "task-filters" as const, errno, guestTicks,
    identity: { rootBackingId, ownerPid, ownerTid: Number(ownerTidValue), cpuCgroupId, source } };
  if (stage === 8 && !nonzero(bytes,184,187) && !nonzero(bytes,208,256)) return { ...base, stage: "selection" };
  const phase = view.getUint8(185), resource = view.getUint8(186);
  if (view.getUint8(184) !== 9 || resource !== (phase === 34 || phase === 35 ? 0 : 1)) throw malformed();
  const progress = decodeFilterRetirement(phase, readFilterRetirementFields(view, 208));
  if (progress === undefined) throw malformed();
  if (stage === 9 || stage === 10) return { ...base, stage: stage === 9 ? "admission" : "resource", progress };
  if (stage === 11 && progress.phase === "filter-owner") return { ...base, stage: "ownership", progress };
  throw malformed();
}

export function taskFilterFinalizationFailureDetail(failure: UserspaceTaskFilterFinalizationFailure) {
  const owner = failure.identity;
  return { reason: "io-finalization-failure", kind: failure.kind, stage: failure.stage, errno: failure.errno,
    guestTicks: failure.guestTicks.toString(), rootBackingId: owner.rootBackingId.toString(), ownerPid: owner.ownerPid, ownerTid: owner.ownerTid,
    cpuCgroupId: owner.cpuCgroupId.toString(), source: finalizationSourceDetail(owner.source),
    ...(failure.progress === undefined ? {} : { progress: filterRetirementDetail(failure.progress) }) };
}

function nonzero(bytes: Uint8Array, start: number, end: number): boolean { return bytes.subarray(start,end).some(byte => byte !== 0); }
function malformed(): VMError { return new VMError("PROTOCOL_ERROR", "Userspace task-filter finalization failure is malformed"); }
