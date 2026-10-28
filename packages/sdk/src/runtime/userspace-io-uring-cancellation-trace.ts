import { VMError } from "./errors.ts";
import type { IoUringCallSource } from "./userspace-io-uring-source.ts";

/** The original copied control, shared by every target selected by that cancellation. */
export type UserspaceIoUringCancellationTrace = {
  readonly credentialId: bigint;
  readonly openFileId?: bigint;
} & ({
  readonly kind: "submission";
  readonly source: IoUringCallSource<426n>;
  readonly execution: { readonly kind: "inline" }
    | { readonly kind: "worker"; readonly poolId: bigint; readonly sequence: bigint };
  readonly sqSequence: number;
  readonly sqeIndex: number;
  readonly sqe: readonly number[];
} | {
  readonly kind: "registration";
  readonly source: IoUringCallSource<427n>;
  readonly header: readonly number[];
  readonly execution?: never;
  readonly sqSequence?: never;
  readonly sqeIndex?: never;
  readonly sqe?: never;
});

export function decodeIoUringCancellationTrace(
  bytes: Uint8Array, view: DataView, offset: number, version: number,
): UserspaceIoUringCancellationTrace | undefined {
  const tag = view.getUint8(offset + 288);
  if (tag === 0) {
    if (bytes.subarray(offset + 289, offset + 512).some((byte) => byte !== 0)) throw malformed();
    return undefined;
  }
  if (tag !== 1 || bytes.subarray(offset + 289, offset + 296).some((byte) => byte !== 0)
    || bytes.subarray(offset + 496, offset + 512).some((byte) => byte !== 0)) throw malformed();
  const pid = view.getUint32(offset + 296, true), tid = view.getUint32(offset + 300, true);
  const guestTicks = view.getBigUint64(offset + 304, true), number = view.getBigUint64(offset + 312, true);
  const instructionRip = view.getBigUint64(offset + 368, true), nextRip = view.getBigUint64(offset + 376, true);
  const addressSpace = view.getBigUint64(offset + 384, true);
  const span = BigInt.asUintN(64, nextRip - instructionRip);
  const poolId = view.getBigUint64(offset + 392, true), sequence = view.getBigUint64(offset + 400, true);
  const sqeIndex = view.getUint32(offset + 412, true), credentialId = view.getBigUint64(offset + 416, true);
  const description = view.getBigUint64(offset + 424, true);
  const sqe = bytes.subarray(offset + 432, offset + 496);
  if (number === 427n) {
    const flags = view.getUint32(offset + 444, true);
    if (version < 33 || pid === 0 || tid === 0 || addressSpace === 0n || span === 0n || span > 15n
      || credentialId === 0n || credentialId === 0xffff_ffff_ffff_ffffn
      || bytes.subarray(offset + 392, offset + 416).some(byte => byte !== 0)
      || (view.getBigUint64(offset + 328, true) & 0x7fff_ffffn) !== 24n
      || (view.getBigUint64(offset + 320, true) & 0xffff_ffffn) === 0xffff_ffffn
      || view.getBigUint64(offset + 336, true) === 0n
      || (view.getBigUint64(offset + 344, true) & 0xffff_ffffn) !== 1n
      || (flags & ~63) !== 0 || bytes.subarray(offset + 465, offset + 496).some(byte => byte !== 0)
      || (description === 0n) !== ((flags & 2) === 0)) throw malformed();
    return { kind: "registration", source: { pid, tid, guestTicks, number, instructionRip, nextRip, addressSpace,
      arguments: [view.getBigUint64(offset + 320, true), view.getBigUint64(offset + 328, true),
        view.getBigUint64(offset + 336, true), view.getBigUint64(offset + 344, true),
        view.getBigUint64(offset + 352, true), view.getBigUint64(offset + 360, true)] },
      credentialId, ...(description === 0n ? {} : { openFileId: description }), header: Array.from(sqe) };
  }
  const flags = view.getUint32(offset + 460, true);
  if (pid === 0 || tid === 0 || guestTicks === 0n || number !== 426n || addressSpace === 0n
    || span === 0n || span > 15n || (poolId === 0n) !== (sequence === 0n)
    || sqeIndex >= 32768 || credentialId === 0n || credentialId === 0xffff_ffff_ffff_ffffn
    || (description === 0n) !== ((flags & 2) === 0)
    || sqe[0] !== 14 || ((sqe[1] ?? 0) & (128 | 32)) !== 0
    || view.getUint16(offset + 434, true) !== 0 || view.getBigUint64(offset + 440, true) !== 0n
    || view.getUint32(offset + 476, true) !== 0 || (flags & ~63) !== 0
    || ((flags & 4) !== 0 && (flags & (2 | 32)) !== 0)) throw malformed();
  return {
    kind: "submission",
    source: { pid, tid, guestTicks, number, instructionRip, nextRip, addressSpace, arguments: [
      view.getBigUint64(offset + 320, true), view.getBigUint64(offset + 328, true),
      view.getBigUint64(offset + 336, true), view.getBigUint64(offset + 344, true),
      view.getBigUint64(offset + 352, true), view.getBigUint64(offset + 360, true),
    ] },
    execution: poolId === 0n ? { kind: "inline" } : { kind: "worker", poolId, sequence },
    sqSequence: view.getUint32(offset + 408, true), sqeIndex, credentialId,
    ...(description === 0n ? {} : { openFileId: description }), sqe: Array.from(sqe),
  };
}

function malformed(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace syscall trace is malformed");
}
