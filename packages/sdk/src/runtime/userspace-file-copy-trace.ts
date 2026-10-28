import { VMError } from "./errors.ts";

export interface UserspaceFileCopyWait {
  readonly kind: "file-copy";
  readonly copiedBytes: bigint;
  readonly totalBytes: bigint;
  readonly reason: "chunk-bound" | "cpu-quota";
}

export function decodeFileCopyWait(bytes: Uint8Array, view: DataView, offset: number): UserspaceFileCopyWait {
  const copiedBytes = view.getBigUint64(offset + 128, true), totalBytes = view.getBigUint64(offset + 136, true);
  const reasonId = view.getUint8(offset + 192);
  const reason = reasonId === 1 ? "chunk-bound" : reasonId === 2 ? "cpu-quota" : undefined;
  if (reason === undefined || totalBytes > 0x7fff_f000n || copiedBytes > totalBytes
    || copiedBytes !== 0n && (copiedBytes === totalBytes || copiedBytes % 65536n !== 0n)
    || reason === "chunk-bound" && copiedBytes === 0n
    || view.getBigUint64(offset + 56, true) !== 326n
    || (view.getBigUint64(offset + 64, true) & 0xffff_ffffn) > 0x7fff_ffffn
    || (view.getBigUint64(offset + 80, true) & 0xffff_ffffn) > 0x7fff_ffffn
    || view.getBigUint64(offset + 72, true) > 0x7fff_ffff_fff8n
    || view.getBigUint64(offset + 88, true) > 0x7fff_ffff_fff8n
    || totalBytes > view.getBigUint64(offset + 96, true)
    || (view.getBigUint64(offset + 104, true) & 0xffff_ffffn) !== 0n
    || (view.getUint8(offset + 120) !== 1 && view.getUint8(offset + 120) !== 2) || view.getUint8(offset + 123) !== 0
    || bytes.subarray(offset + 193, offset + 272).some(byte => byte !== 0)) {
    throw new VMError("PROTOCOL_ERROR", "Userspace syscall trace is malformed");
  }
  return { kind: "file-copy", copiedBytes, totalBytes, reason };
}
