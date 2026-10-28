import { VMError } from "./errors.ts";
import { decodeExitedResourceTraceSource, type ExitedResourceSource } from "./userspace-exited-resource-source.ts";
import { decodeFilterRetirement, readFilterRetirementFields, type FilterRetirement } from "./userspace-filter-retirement.ts";

export type UserspaceTaskFilterFinalizationTrace = {
  readonly rootBackingId: bigint; readonly ownerPid: number; readonly ownerTid: number;
  readonly guestTicks: bigint; readonly cpuCgroupId: bigint; readonly source: ExitedResourceSource;
} & (
  | { readonly done: false; readonly progress: Exclude<FilterRetirement, { readonly phase: "filter-owner" }> }
  | { readonly done: true; readonly progress: Extract<FilterRetirement, { readonly phase: "filter-owner" }> }
);
const RESERVED = [[128, 152], [238, 240], [252, 272], [288, 512], [560, 992]] as const;

/** Tag7 identifies the original immutable policy root without a pool, ring or submission. */
export function decodeTaskFilterFinalizationTrace(bytes: Uint8Array, view: DataView, at: number, version: number): UserspaceTaskFilterFinalizationTrace {
  if (version < 50 || !Number.isSafeInteger(at) || at < 0 || view.byteLength - at < 992 || bytes.byteLength - at < 992) throw malformed();
  const rootBackingId = view.getBigUint64(at + 192, true), ownerTidValue = view.getBigUint64(at + 200, true);
  const ownerPid = view.getUint32(at + 248, true), guestTicks = view.getBigUint64(at + 208, true);
  const admittedGuestTicks = view.getBigUint64(at + 216, true), cpuCgroupId = view.getBigUint64(at + 224, true);
  const done = view.getUint8(at + 235), phase = view.getUint8(at + 233), resource = view.getUint8(at + 234);
  if (rootBackingId < 1n << 48n || rootBackingId >= 0xffff_ffff_ffff_ffffn || rootBackingId % 4096n !== 0n
    || cpuCgroupId === 0n || cpuCgroupId === 0xffff_ffff_ffff_ffffn || ownerPid === 0 || ownerPid > 0x7fff_ffff
    || ownerPid !== view.getUint32(at + 24, true) || ownerTidValue === 0n || ownerTidValue > 0x7fff_ffffn
    || view.getUint32(at + 28, true) > 0x7fff_ffff || guestTicks === 0n || admittedGuestTicks > guestTicks || done > 1
    || view.getBigUint64(at + 112, true) !== 0n || view.getUint8(at + 122) !== 0
    || view.getUint8(at + 120) !== (done === 1 ? 4 : 2) || view.getUint8(at + 232) !== 9
    || resource !== (phase === 34 || phase === 35 ? 0 : 1) || RESERVED.some(([start,end]) => bytes.subarray(at + start, at + end).some(byte => byte !== 0))) throw malformed();
  const progress = decodeFilterRetirement(phase, readFilterRetirementFields(view, at + 512));
  if (progress === undefined) throw malformed();
  const source = decodeExitedResourceTraceSource(bytes, view, at, admittedGuestTicks);
  const base = { rootBackingId, ownerPid, ownerTid: Number(ownerTidValue), guestTicks, cpuCgroupId, source };
  if (done === 1 && progress.phase === "filter-owner") return { ...base, done: true, progress };
  if (done === 0 && progress.phase !== "filter-owner") return { ...base, done: false, progress };
  throw malformed();
}

function malformed(): VMError { return new VMError("PROTOCOL_ERROR", "Userspace task-filter finalization trace is malformed"); }
