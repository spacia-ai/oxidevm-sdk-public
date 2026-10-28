/** Read-only projections of the admitted ring call and its teardown barrier. */
import { VMError } from "./errors.ts";
import { decodeIoUringCallSource, type IoUringCallSource } from "./userspace-io-uring-source.ts";
export { decodeIoUringEnterBody, type UserspaceIoUringEnterWait, type UserspaceIoUringEnterProgress } from "./userspace-io-uring-enter-body.ts";

export interface CqWriterWait {
  readonly kind: "cq-writer";
  readonly ringOpenFileId: bigint;
  readonly source: IoUringCallSource<426n>;
}

export function decodeCqWriterWait(bytes: Uint8Array, view: DataView, offset: number): CqWriterWait {
  const source = decodeIoUringCallSource(bytes.subarray(offset + 832, offset + 928));
  const ringOpenFileId = view.getBigUint64(offset + 520, true);
  if (ringOpenFileId === 0n || ringOpenFileId === 0xffff_ffff_ffff_ffffn || source.number !== 426n
    || source.guestTicks > view.getBigUint64(offset + 208, true)
    || bytes.subarray(offset + 513, offset + 520).some(byte => byte !== 0)
    || bytes.subarray(offset + 528, offset + 552).some(byte => byte !== 0)
    || bytes.subarray(offset + 248, offset + 272).some(byte => byte !== 0)) throw malformed();
  return { kind: "cq-writer", ringOpenFileId, source: { ...source, number: source.number } };
}

export interface UserspaceIoUringEnterMutex {
  readonly kind: "io-uring-enter-mutex";
  readonly ringOpenFileId: bigint;
  readonly admittedGuestTicks: bigint;
  readonly guestTicks: bigint;
}

export interface UserspaceIoUringEnterDrain {
  readonly kind: "io-uring-enter-drain";
  readonly purpose: "exec" | "exit-group" | "seccomp-process-kill";
  readonly pendingEnters: number;
  readonly pendingRegistrations: number;
  readonly pendingRequests: bigint;
}

export function decodeIoUringEnterMutex(bytes: Uint8Array, view: DataView, offset: number): UserspaceIoUringEnterMutex {
  const ringOpenFileId = view.getBigUint64(offset + 128, true);
  const admittedGuestTicks = view.getBigUint64(offset + 136, true), guestTicks = view.getBigUint64(offset + 192, true);
  const flags = Number(view.getBigUint64(offset + 88, true) & 0xffff_ffffn);
  const fd = view.getBigUint64(offset + 64, true) & 0xffff_ffffn;
  const submitted = view.getBigUint64(offset + 72, true) & 0xffff_ffffn;
  if (view.getBigUint64(offset + 56, true) !== 426n || ringOpenFileId === 0n || ringOpenFileId === 0xffff_ffff_ffff_ffffn
    || (flags & ~255) !== 0 || (flags & 16) !== 0 && fd >= 16n || (flags & 16) === 0 && fd >= 0x8000_0000n
    || submitted === 0n && (flags & 1) === 0 || guestTicks < admittedGuestTicks
    || bytes.subarray(offset + 200, offset + 272).some(byte => byte !== 0)) throw malformed();
  return { kind: "io-uring-enter-mutex", ringOpenFileId, admittedGuestTicks, guestTicks };
}

export function decodeIoUringEnterDrain(bytes: Uint8Array, view: DataView, offset: number): UserspaceIoUringEnterDrain {
  const enters = view.getBigUint64(offset + 128, true), registrations = view.getUint32(offset + 192, true);
  const purposeId = view.getBigUint64(offset + 136, true);
  const purpose = purposeId === 1n ? "exec" : purposeId === 2n ? "exit-group" : purposeId === 3n ? "seccomp-process-kill" : undefined;
  const number = view.getBigUint64(offset + 56, true);
  if (enters === 0n || enters + BigInt(registrations) > 4096n || purpose === undefined
    || purpose === "exec" && number !== 59n && number !== 322n || purpose === "exit-group" && number !== 231n
    || bytes.subarray(offset + 196, offset + 200).some(byte => byte !== 0)
    || bytes.subarray(offset + 208, offset + 272).some(byte => byte !== 0)) throw malformed();
  return { kind: "io-uring-enter-drain", purpose, pendingEnters: Number(enters), pendingRegistrations: registrations,
    pendingRequests: view.getBigUint64(offset + 200, true) };
}

function malformed(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace submission wait is malformed");
}
