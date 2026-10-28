/** One wire identity for syscall-originated I/O, independent of its executor. */
import { VMError } from "./errors.ts";

export interface IoUringSyscallIdentity<N extends bigint> {
  readonly number: N;
  readonly arguments: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  readonly instructionRip: bigint;
  readonly nextRip: bigint;
  readonly addressSpace: bigint;
}

export interface IoUringCallSource<N extends bigint> extends IoUringSyscallIdentity<N> {
  readonly pid: number;
  readonly tid: number;
  readonly guestTicks: bigint;
}

/** Compare the complete admitted identity, including all raw syscall arguments. */
export function sameIoUringCallSource(left: IoUringCallSource<bigint>, right: IoUringCallSource<bigint>): boolean {
  return left.pid === right.pid && left.tid === right.tid && left.guestTicks === right.guestTicks
    && left.number === right.number && left.instructionRip === right.instructionRip
    && left.nextRip === right.nextRip && left.addressSpace === right.addressSpace
    && left.arguments.every((value, index) => value === right.arguments[index]);
}

export function decodeIoUringCallSource(bytes: Uint8Array): IoUringCallSource<bigint> {
  if (bytes.byteLength !== 96) throw malformed();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pid = view.getUint32(0, true), tid = view.getUint32(4, true);
  if (pid === 0 || tid === 0) throw malformed();
  return { pid, tid, guestTicks: view.getBigUint64(8, true), ...decodeIoUringSyscallIdentity(bytes.subarray(16)) };
}

/** Decode the same original syscall in task, worker and final-resource records. */
export function decodeIoUringSyscallIdentity(bytes: Uint8Array): IoUringSyscallIdentity<bigint> {
  if (bytes.byteLength !== 80) throw malformed();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const instructionRip = view.getBigUint64(56, true), nextRip = view.getBigUint64(64, true);
  const span = BigInt.asUintN(64, nextRip - instructionRip), addressSpace = view.getBigUint64(72, true);
  if (addressSpace === 0n || span === 0n || span > 15n) throw malformed();
  return { instructionRip, nextRip, addressSpace, number: view.getBigUint64(0, true),
    arguments: [view.getBigUint64(8, true), view.getBigUint64(16, true), view.getBigUint64(24, true),
      view.getBigUint64(32, true), view.getBigUint64(40, true), view.getBigUint64(48, true)] };
}

function malformed(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace I/O syscall source is malformed");
}
