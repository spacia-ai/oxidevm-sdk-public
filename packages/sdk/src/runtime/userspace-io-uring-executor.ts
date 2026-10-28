import { decodeIoUringCallSource, type IoUringCallSource } from "./userspace-io-uring-source.ts";
import { VMError } from "./errors.ts";
import { decodeSeccompTrace, type UserspaceSeccompTrace } from "./userspace-seccomp-trace.ts";
import { decodeIoUringExitedIssuerProgress, decodeIoUringIssuerProgress,
  type IoUringExitedIssuerProgress, type IoUringIssuerProgress } from "./userspace-io-uring-issuer.ts";

export type IoUringExecutor =
  | (IoUringIssuerProgress & { readonly kind: "ordinary-task-run"; readonly source: IoUringCallSource<bigint> })
  | { readonly kind: "worker" }
  | { readonly kind: "worker-admission-failed"; readonly errno: 11 | 12 }
  | { readonly kind: "task-run"; readonly source: IoUringCallSource<426n | 427n> }
  | { readonly kind: "exec"; readonly source: IoUringCallSource<59n | 322n> }
  | IoUringExitedCause
  | IoUringExitedIssuerExecutor;

type IoUringExitedCause =
  | { readonly kind: "exited"; readonly source: IoUringCallSource<60n | 231n> }
  | { readonly kind: "exited-seccomp"; readonly source: IoUringCallSource<bigint>;
      readonly decision: Extract<UserspaceSeccompTrace, { readonly kind: "filter" }> | { readonly kind: "strict"; readonly action: "kill" } }
  | { readonly kind: "exited-signal"; readonly source: { readonly pid: number; readonly tid: number; readonly guestTicks: bigint; readonly signal: number; readonly instructionRip: bigint; readonly addressSpace: bigint } };

export type IoUringExitedIssuerExecutor = IoUringExitedCause & {
  readonly issuer: IoUringExitedIssuerProgress;
};

function exitedExecutor(cause: IoUringExitedCause, view: DataView, offset: number,
  version: number): IoUringExitedCause | IoUringExitedIssuerExecutor {
  const issuer = decodeIoUringExitedIssuerProgress(view, offset, version);
  return issuer === undefined ? cause : { ...cause, issuer };
}

export function decodeIoUringExecutor(
  bytes: Uint8Array, view: DataView, offset: number, version: number,
): IoUringExecutor | undefined {
  if (version < 18) return undefined;
  const tag = view.getUint8(offset + 624);
  if (tag === 0) {
    if (bytes.subarray(offset + 625, offset + 752).some(byte => byte !== 0)) throw malformed();
    return { kind: "worker" };
  }
  if (tag === 6 && version >= 31) {
    const errno = view.getUint32(offset + 628, true);
    if ((errno !== 11 && errno !== 12)
      || view.getUint32(offset + 28, true) !== view.getUint32(offset + 216, true)
      || bytes.subarray(offset + 625, offset + 628).some(byte => byte !== 0)
      || bytes.subarray(offset + 632, offset + 752).some(byte => byte !== 0)) throw malformed();
    return { kind: "worker-admission-failed", errno };
  }
  const signaled = tag === 4 && version >= 22;
  const seccomp = tag === 5 && version >= 23;
  const ordinary = tag === 7 && version >= 38;
  const exited = tag === 3 || signaled || seccomp;
  if (!(tag === 1 || tag === 2 && version >= 20 || tag === 3 && version >= 21 || signaled || seccomp || ordinary) || bytes.subarray(offset + (signaled ? 626 : 625), offset + 632).some(byte => byte !== 0)
    || bytes.subarray(offset + (seccomp ? 744 : 728), offset + 752).some(byte => byte !== 0)) throw malformed();
  const pid = view.getUint32(offset + 632, true), tid = view.getUint32(offset + 636, true);
  const guestTicks = view.getBigUint64(offset + 640, true), number = view.getBigUint64(offset + 648, true);
  const instructionRip = view.getBigUint64(offset + 704, true), nextRip = view.getBigUint64(offset + 712, true);
  const addressSpace = view.getBigUint64(offset + 720, true);
  const span = BigInt.asUintN(64, nextRip - instructionRip);
  if (pid === 0 || pid !== view.getUint32(offset + 24, true)
    || tid === 0 || !exited && tid !== view.getUint32(offset + 28, true)
    || exited && view.getUint32(offset + 28, true) !== view.getUint32(offset + 216, true)
    || guestTicks === 0n && !(tag === 1 && version >= 33 && number === 427n)
    || guestTicks > view.getBigUint64(offset + 208, true)
    || addressSpace === 0n || !signaled && (span === 0n || span > 15n)) throw malformed();
  if (signaled) {
    const signal = view.getUint8(offset + 625);
    if (signal === 0 || signal > 64 || bytes.subarray(offset + 648, offset + 704).some(byte => byte !== 0)
      || nextRip !== 0n) throw malformed();
    return exitedExecutor({ kind: "exited-signal", source: { pid, tid, guestTicks, signal, instructionRip, addressSpace } }, view, offset, version);
  }
  const args = decodeIoUringCallSource(bytes.subarray(offset + 632, offset + 728)).arguments;
  if (ordinary) {
    if (addressSpace !== view.getBigUint64(offset + 32, true)) throw malformed();
    return { kind: "ordinary-task-run", ...decodeIoUringIssuerProgress(view, offset),
      source: { pid, tid, guestTicks, number, instructionRip, nextRip, addressSpace, arguments: args } };
  }
  if (seccomp) {
    const decision = decodeSeccompTrace(bytes, view, offset + 728);
    if (decision === undefined || addressSpace !== view.getBigUint64(offset + 32, true)) throw malformed();
    if (decision.kind === "strict") {
      if (decision.action !== "kill" || tid !== view.getUint32(offset + 216, true)) throw malformed();
      return exitedExecutor({ kind: "exited-seccomp", source: { pid, tid, guestTicks, number, instructionRip, nextRip, addressSpace, arguments: args }, decision: { kind: "strict", action: "kill" } }, view, offset, version);
    }
    const action = (decision.value & 0xffff0000) >>> 0;
    if ([0x00030000, 0x00050000, 0x7fc00000, 0x7ff00000, 0x7ffc0000, 0x7fff0000].includes(action)
      || action === 0 && tid !== view.getUint32(offset + 216, true)) throw malformed();
    return exitedExecutor({ kind: "exited-seccomp", source: { pid, tid, guestTicks, number, instructionRip, nextRip, addressSpace, arguments: args }, decision }, view, offset, version);
  }
  if (tag === 1) {
    if (number === 426n && (args[3] & 1n) !== 0n
      || version >= 33 && number === 427n && (args[1] & 0x7fff_ffffn) === 24n
        && (args[0] & 0xffff_ffffn) !== 0xffff_ffffn && args[2] !== 0n && (args[3] & 0xffff_ffffn) === 1n) {
      return { kind: "task-run", source: { pid, tid, guestTicks, number, instructionRip, nextRip, addressSpace, arguments: args } };
    }
    throw malformed();
  }
  if (tag === 3) {
    if (number !== 60n && number !== 231n || number === 60n && tid !== view.getUint32(offset + 216, true)) throw malformed();
    return exitedExecutor({ kind: "exited", source: { pid, tid, guestTicks, number, instructionRip, nextRip, addressSpace, arguments: args } }, view, offset, version);
  }
  if (number !== 59n && number !== 322n) throw malformed();
  return { kind: "exec", source: { pid, tid, guestTicks, number, instructionRip, nextRip, addressSpace, arguments: args } };
}

function malformed(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace I/O executor trace is malformed");
}
