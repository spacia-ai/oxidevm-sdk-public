import { VMError } from "./errors.ts";

export interface UserspaceMessageBatchWait {
  readonly kind: "message-batch";
  readonly completedMessages: number;
  readonly totalMessages: number;
  readonly reason: "message-bound" | "cpu-quota";
}

export function decodeMessageBatchWait(bytes: Uint8Array, view: DataView, offset: number): UserspaceMessageBatchWait {
  const completed = view.getBigUint64(offset + 128, true), total = view.getBigUint64(offset + 136, true);
  const number = view.getBigUint64(offset + 56, true), supplied = view.getBigUint64(offset + 80, true) & 0xffff_ffffn;
  const expected = number === 307n && supplied > 1024n ? 1024n : supplied;
  const reasonId = view.getUint8(offset + 192);
  const reason = reasonId === 1 ? "message-bound" : reasonId === 2 ? "cpu-quota" : undefined;
  if (reason === undefined || (number !== 299n && number !== 307n)
    || total === 0n || total > 0xffff_ffffn || total !== expected || completed >= total
    || reason === "message-bound" && completed < 64n
    || (view.getBigUint64(offset + 64, true) & 0xffff_ffffn) > 0x7fff_ffffn
    || (view.getUint8(offset + 120) !== 1 && view.getUint8(offset + 120) !== 2)
    || view.getUint8(offset + 123) !== 0
    || bytes.subarray(offset + 144, offset + 152).some(byte => byte !== 0)
    || bytes.subarray(offset + 193, offset + 272).some(byte => byte !== 0)) {
    throw new VMError("PROTOCOL_ERROR", "Userspace syscall trace is malformed");
  }
  return { kind: "message-batch", completedMessages: Number(completed), totalMessages: Number(total), reason };
}
