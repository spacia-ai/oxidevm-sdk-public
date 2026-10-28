import { VMError } from "../errors.ts";
import { decodeIoUringSyscallIdentity, type IoUringSyscallIdentity } from "../userspace-io-uring-source.ts";
import { decodeSeccompTrace, type UserspaceSeccompTrace } from "../userspace-seccomp-trace.ts";

type Actor = { readonly pid: number; readonly tid: number; readonly guestTicks: bigint };
export type FinalizationSource = Actor & (
  | ({ readonly kind: "syscall"; readonly decision?: UserspaceSeccompTrace } & IoUringSyscallIdentity<bigint>)
  | { readonly kind: "signal"; readonly signal: number; readonly instructionRip: bigint; readonly addressSpace: bigint }
  | { readonly kind: "worker"; readonly creatorTid: number; readonly poolId: bigint; readonly sequence: bigint;
      readonly submission: IoUringSyscallIdentity<426n>; readonly decision?: Extract<UserspaceSeccompTrace, { readonly kind: "filter" }> }
);
export function decodeFinalizationSource(bytes: Uint8Array, view: DataView, failedAt: bigint): FinalizationSource {
  const kind = view.getUint8(48), signal = view.getUint8(49), pid = view.getUint32(52, true), tid = view.getUint32(56, true);
  const guestTicks = view.getBigUint64(64, true), creatorTid = view.getUint32(60, true);
  const poolId = view.getBigUint64(72, true), sequence = view.getBigUint64(80, true);
  if (pid === 0 || tid === 0 || guestTicks > failedAt || view.getUint16(50, true) !== 0) throw malformed();
  const actor = { pid, tid, guestTicks };
  if (kind === 2 && signal > 0 && signal <= 64 && creatorTid === 0 && poolId === 0n && sequence === 0n
    && !nonzero(bytes, 96, 160) && !nonzero(bytes, 168, 184) && view.getBigUint64(160, true) !== 0n) {
    return { ...actor, kind: "signal", signal, instructionRip: view.getBigUint64(88, true), addressSpace: view.getBigUint64(160, true) };
  }
  if (signal !== 0) throw malformed();
  const syscall = decodeIoUringSyscallIdentity(bytes.subarray(88, 168)), decision = decodeSeccompTrace(bytes, view, 168);
  if (kind === 1 && creatorTid === 0 && poolId === 0n && sequence === 0n) {
    return { ...actor, kind: "syscall", ...syscall, ...(decision === undefined ? {} : { decision }) };
  }
  if (kind === 3 && creatorTid !== 0 && creatorTid !== tid && identity(poolId) && identity(sequence) && syscall.number === 426n
    && (decision === undefined || decision.kind === "filter" && [0x7fff, 0x7ffc].includes(decision.value >>> 16))) {
    return { ...actor, kind: "worker", creatorTid, poolId, sequence, submission: { ...syscall, number: 426n },
      ...(decision?.kind === "filter" ? { decision } : {}) };
  }
  throw malformed();
}


export function finalizationSourceDetail(source: FinalizationSource) {
  const actor = { kind: source.kind, pid: source.pid, tid: source.tid, guestTicks: source.guestTicks.toString() };
  if (source.kind === "signal") return { ...actor, signal: source.signal, instructionRip: source.instructionRip.toString(), addressSpace: source.addressSpace.toString() };
  const syscall = source.kind === "worker" ? source.submission : source;
  const decision = source.decision?.kind === "filter" ? { ...source.decision, programId: source.decision.programId.toString() } : source.decision;
  return { ...actor, number: syscall.number.toString(), arguments: syscall.arguments.map(value => value.toString()),
    instructionRip: syscall.instructionRip.toString(), nextRip: syscall.nextRip.toString(), addressSpace: syscall.addressSpace.toString(),
    ...(decision === undefined ? {} : { decision }),
    ...(source.kind === "worker" ? { creatorTid: source.creatorTid, poolId: source.poolId.toString(), workSequence: source.sequence.toString() } : {}) };
}


function malformed(): VMError { return new VMError("PROTOCOL_ERROR", "Userspace finalization failure source is malformed"); }
function identity(value: bigint): boolean { return value > 0n && value < 0xffff_ffff_ffff_ffffn; }
function nonzero(bytes: Uint8Array, start: number, end: number): boolean { return bytes.subarray(start, end).some(byte => byte !== 0); }
