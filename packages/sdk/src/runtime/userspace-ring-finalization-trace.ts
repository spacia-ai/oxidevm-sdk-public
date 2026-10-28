import { VMError } from "./errors.ts";
import { decodeSeccompTrace, type UserspaceSeccompTrace } from "./userspace-seccomp-trace.ts";
import type { IoUringCallSource } from "./userspace-io-uring-source.ts";
import { decodeIoUringSyscallIdentity } from "./userspace-io-uring-source.ts";
import { decodeRingFinalizationProgress, type RingFinalizationProgress } from "./userspace-ring-finalization-progress.ts";
import { readNapiRetirementFields } from "./userspace-napi-retirement.ts";
import { readRegionRetirementFields } from "./userspace-region-retirement.ts";
import { readPersonalityRetirementFields } from "./userspace-personality-retirement.ts";
import { readFilterRetirementFields } from "./userspace-filter-retirement.ts";
import { readWorkerBindingFields } from "./userspace-worker-binding-retirement.ts";

export type UserspaceRingFinalizationTrace = {
  readonly ringObjectId: bigint;
  readonly ringOpenFileId: bigint;
  readonly guestTicks: bigint;
  readonly cpuCgroupId: bigint;
  readonly source: { readonly kind: "syscall"; readonly admittedGuestTicks: bigint }
    | { readonly kind: "signal"; readonly admittedGuestTicks: bigint; readonly signal: number; readonly instructionRip: bigint }
    | { readonly kind: "worker"; readonly guestTicks: bigint; readonly creatorTid: number;
        readonly work: { readonly poolId: bigint; readonly sequence: bigint };
        readonly submission: Pick<IoUringCallSource<426n>, "number" | "arguments" | "instructionRip" | "nextRip" | "addressSpace">;
        readonly decision?: Extract<UserspaceSeccompTrace, { readonly kind: "filter" }> };
} & (
  | { readonly done: false; readonly progress: Exclude<RingFinalizationProgress, { readonly kind: "owner" }> }
  | { readonly done: true; readonly progress: { readonly kind: "owner" } }
);

/** Tag4 owns these fields exclusively. Historical encoders never emitted a finalizer. */
export function decodeRingFinalizationTrace(bytes: Uint8Array, view: DataView, at: number, version: number): UserspaceRingFinalizationTrace {
  const ringObjectId = view.getBigUint64(at + 192, true), ringOpenFileId = view.getBigUint64(at + 200, true);
  const guestTicks = view.getBigUint64(at + 208, true), admittedGuestTicks = view.getBigUint64(at + 216, true);
  const cpuCgroupId = view.getBigUint64(at + 224, true), phase = view.getUint8(at + 232), done = view.getUint8(at + 235);
  if (version < 41 || version < 42 && phase === 4 || version < 43 && phase === 5 || version < 44 && phase === 6 || version < 45 && phase === 7 || version < 46 && phase === 8 || version < 47 && phase === 9 || version < 48 && phase === 10 || !identity(ringObjectId) || !identity(ringOpenFileId) || !identity(cpuCgroupId)
    || guestTicks === 0n || admittedGuestTicks > guestTicks || done > 1
    || view.getBigUint64(at + 112, true) !== 0n || view.getUint8(at + 122) !== 0
    || view.getUint8(at + 120) !== (done === 1 ? 4 : 2)
    || nonzero(bytes, at, 128, 152) || nonzero(bytes, at, 238, 240)
    || nonzero(bytes, at, 248, 256) || nonzero(bytes, at, phase === 4 ? 268 : 266, 272)
    || (phase === 7 || phase === 9 || phase === 10 ? nonzero(bytes, at, 440, 512) || nonzero(bytes, at, 560, 992)
      : phase === 6 || phase === 8 ? nonzero(bytes, at, 440, 512) || nonzero(bytes, at, 552, 992)
      : phase === 5 ? nonzero(bytes, at, 440, 512) || nonzero(bytes, at, 560, version >= 43 ? 992 : 960)
      : nonzero(bytes, at, 440, version >= 43 ? 992 : 960))) throw malformed();
  const sourceTag = view.getUint8(at + 236), signal = view.getUint8(at + 237), instructionRip = view.getBigUint64(at + 240, true);
  const span = BigInt.asUintN(64, view.getBigUint64(at + 48, true) - view.getBigUint64(at + 40, true));
  const source = sourceTag === 3 && signal === 0 && instructionRip === 0n
    ? decodeWorker(bytes, view, at, admittedGuestTicks)
    : sourceTag === 1 && signal === 0 && instructionRip === 0n && span >= 1n && span <= 15n
    ? { kind: "syscall" as const, admittedGuestTicks }
    : sourceTag === 2 && signal >= 1 && signal <= 64 && view.getBigUint64(at + 56, true) === 0xffff_ffff_ffff_ffffn
      && !nonzero(bytes, at, 40, 56) && !nonzero(bytes, at, 64, 112) && !nonzero(bytes, at, 272, 288)
      && view.getUint8(at + 121) === 0
      ? { kind: "signal" as const, admittedGuestTicks, signal, instructionRip } : undefined;
  if (source === undefined) throw malformed();
  if (sourceTag !== 3 && nonzero(bytes, at, 324, 440)) throw malformed();
  const base = { ringObjectId, ringOpenFileId, guestTicks, cpuCgroupId, source };
  const payload = view.getBigUint64(at + 304, true);
  const progress = decodeRingFinalizationProgress({ kind: phase, phase: view.getUint8(at + 233), resource: view.getUint8(at + 234),
    origin: view.getBigUint64(at + 256, true), index: phase === 4 ? view.getUint32(at + 264, true) : view.getUint16(at + 264, true),
    pinsBefore: view.getBigUint64(at + 288, true), metadataReferencesBefore: view.getBigUint64(at + 296, true),
    tag: phase === 1 ? payload : 0n, lockedPagesBefore: phase === 1 ? 0n : payload,
    ringsPages: view.getUint32(at + 312, true), sqePages: view.getUint32(at + 316, true), metadataPages: view.getUint32(at + 320, true),
    ...(phase === 5 ? { provided: {
      groupId: view.getUint16(at + 512, true), firstId: view.getUint16(at + 514, true),
      length: view.getUint32(at + 516, true), count: view.getUint32(at + 520, true),
      runsBefore: view.getUint32(at + 524, true), buffersBefore: view.getUint32(at + 528, true),
      groupsBefore: view.getUint32(at + 532, true), address: view.getBigUint64(at + 536, true),
      metadataAllocationId: view.getBigUint64(at + 544, true), allocationCgroupId: view.getBigUint64(at + 552, true),
    } } : {}),
    ...(phase === 6 ? { napi: readNapiRetirementFields(view, at + 512) } : {}),
    ...(phase === 7 ? { region: readRegionRetirementFields(view, at + 512) } : {}),
    ...(phase === 8 ? { personality: readPersonalityRetirementFields(view, at + 512) } : {}),
    ...(phase === 9 ? { filter: readFilterRetirementFields(view, at + 512) } : {}),
    ...(phase === 10 ? { workerBindings: readWorkerBindingFields(view, at + 512) } : {}),
  });
  if (progress.kind === "owner" && done === 1) return { ...base, done: true, progress };
  if (progress.kind !== "owner" && done === 0) return { ...base, done: false, progress };
  throw malformed();
}

function decodeWorker(bytes: Uint8Array, view: DataView, at: number, guestTicks: bigint): Extract<UserspaceRingFinalizationTrace["source"], { readonly kind: "worker" }> {
  const creatorTid = view.getUint32(at + 324, true), poolId = view.getBigUint64(at + 328, true), sequence = view.getBigUint64(at + 336, true);
  const submission = decodeIoUringSyscallIdentity(bytes.subarray(at + 344, at + 424));
  const decision = decodeSeccompTrace(bytes, view, at + 424);
  if (creatorTid === 0 || creatorTid === view.getUint32(at + 28, true) || !identity(poolId) || !identity(sequence)
    || submission.number !== 426n || submission.addressSpace !== view.getBigUint64(at + 32, true)
    || view.getBigUint64(at + 56, true) !== 0xffff_ffff_ffff_ffffn
    || nonzero(bytes, at, 40, 56) || nonzero(bytes, at, 64, 112) || nonzero(bytes, at, 272, 288)
    || view.getUint8(at + 121) !== 0 || decision !== undefined
      && (decision.kind !== "filter" || ![0x7fff, 0x7ffc].includes(decision.value >>> 16))) throw malformed();
  return { kind: "worker", guestTicks, creatorTid, work: { poolId, sequence }, submission: {
    ...submission, number: 426n,
  }, ...(decision?.kind === "filter" ? { decision } : {}) };
}

function identity(value: bigint): boolean { return value > 0n && value < 0xffff_ffff_ffff_ffffn; }
function nonzero(bytes: Uint8Array, at: number, start: number, end: number): boolean {
  return bytes.subarray(at + start, at + end).some(byte => byte !== 0);
}
function malformed(): VMError { return new VMError("PROTOCOL_ERROR", "Userspace ring finalization trace is malformed"); }
