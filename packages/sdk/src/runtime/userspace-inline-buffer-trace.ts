import { VMError } from "./errors.ts";
import { decodeBufferProgress, type BufferProgress } from "./userspace-buffer-progress.ts";

/** A committed inline effect, before the enter cursor publishes its CQ batch. */
export interface UserspaceInlineBufferTrace {
  readonly ringObjectId: bigint;
  readonly ringOpenFileId: bigint;
  readonly admittedGuestTicks: bigint;
  readonly guestTicks: bigint;
  readonly cpuCgroupId: bigint;
  readonly credentialId: bigint;
  readonly chainSlot: number;
  readonly sqSequence: number;
  readonly sqeIndex: number;
  readonly kernelUnits: 1;
  readonly sqe: { readonly bytes: readonly number[]; readonly opcode: 31 | 32; readonly userData: bigint };
  readonly buffers: Extract<BufferProgress, { readonly kind: "provide" | "remove" }>;
}

export function decodeInlineBufferTrace(bytes: Uint8Array, view: DataView, at: number, version: number): UserspaceInlineBufferTrace {
  if (version < 43 || view.getBigUint64(at + 56, true) !== 426n || view.getUint8(at + 120) !== 0
    || view.getUint8(at + 234) !== 1) throw malformed();
  for (const [start, end] of [[122, 123], [128, 152], [233, 234], [235, 240], [252, 256],
    [352, 584], [624, 960]] as const) {
    if (bytes.subarray(at + start, at + end).some(byte => byte !== 0)) throw malformed();
  }
  const ringObjectId = view.getBigUint64(at + 192, true), ringOpenFileId = view.getBigUint64(at + 200, true);
  const guestTicks = view.getBigUint64(at + 208, true), cpuCgroupId = view.getBigUint64(at + 216, true);
  const credentialId = view.getBigUint64(at + 240, true), admittedGuestTicks = view.getBigUint64(at + 256, true);
  const chainSlot = view.getUint32(at + 224, true), sqeIndex = view.getUint32(at + 228, true);
  if ([ringObjectId, ringOpenFileId, cpuCgroupId, credentialId].some(id => id === 0n || id === 0xffff_ffff_ffff_ffffn)
    || guestTicks === 0n || admittedGuestTicks > guestTicks || chainSlot >= 32768 || sqeIndex >= 32768
    || view.getBigUint64(at + 264, true) !== 1n) throw malformed();
  const buffers = decodeBufferProgress(bytes, view, at, version), opcode = view.getUint8(at + 288);
  if (buffers === undefined || buffers.kind !== "provide" && buffers.kind !== "remove"
    || opcode !== 31 && opcode !== 32 || opcode !== view.getUint8(at + 232)
    || buffers.ring !== ringOpenFileId || buffers.group !== view.getUint16(at + 328, true)
    || view.getUint16(at + 290, true) !== 0 || view.getUint32(at + 316, true) !== 0
    || view.getUint32(at + 332, true) !== 0) throw malformed();
  const count = view.getUint32(at + 292, true), first = view.getBigUint64(at + 296, true);
  const address = view.getBigUint64(at + 304, true), length = view.getUint32(at + 312, true);
  if (buffers.kind === "provide" ? opcode !== 31 || buffers.count !== count || buffers.first !== Number(first)
      || first > 65535n || buffers.address !== address || buffers.length !== length || buffers.allocationOrigin.kind !== "recorded"
    : opcode !== 32 || buffers.requested !== count || first !== 0n || address !== 0n || length !== 0) throw malformed();
  if (buffers.kind === "remove" && bytes.subarray(at + 960, at + 992).some(byte => byte !== 0)) throw malformed();
  return { ringObjectId, ringOpenFileId, admittedGuestTicks, guestTicks, cpuCgroupId, credentialId,
    chainSlot, sqeIndex, sqSequence: view.getUint32(at + 248, true), kernelUnits: 1,
    sqe: { bytes: Array.from(bytes.subarray(at + 288, at + 352)), opcode, userData: view.getBigUint64(at + 320, true) }, buffers };
}

function malformed(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace inline buffer operation is malformed");
}
