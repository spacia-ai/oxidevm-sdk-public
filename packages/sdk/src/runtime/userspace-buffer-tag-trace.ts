import { VMError } from "./errors.ts";

interface TagIdentity {
  readonly ringObjectId: bigint;
  readonly resourceOrigin: bigint;
  readonly resourceIndex: number;
  readonly value: bigint;
}

export type UserspaceIoUringTagPublication = TagIdentity & (
  | { readonly state: "queued" }
  | { readonly state: "published"; readonly cqSequence: number }
);

export function decodeBufferTagPublication(bytes: Uint8Array, view: DataView, offset: number): UserspaceIoUringTagPublication {
  const number = view.getBigUint64(offset + 56, true), stage = view.getUint8(offset + 752);
  const resourceIndex = view.getUint16(offset + 754, true), cqSequence = view.getUint32(offset + 756, true);
  const ringObjectId = view.getBigUint64(offset + 760, true), resourceOrigin = view.getBigUint64(offset + 768, true);
  const value = view.getBigUint64(offset + 776, true);
  if ((number !== 426n && number !== 427n) || view.getUint8(offset + 120) !== 0
    || view.getBigInt64(offset + 112, true) !== 0n || view.getUint8(offset + 122) !== 0
    || bytes.subarray(offset + 128, offset + 152).some(byte => byte !== 0)
    || bytes.subarray(offset + 192, offset + 272).some(byte => byte !== 0)
    || bytes.subarray(offset + 288, offset + 752).some(byte => byte !== 0)
    || view.getUint8(offset + 753) !== 0 || (stage !== 1 && stage !== 2)
    || resourceIndex >= 16384 || ringObjectId === 0n || resourceOrigin === 0n || value === 0n
    || stage === 1 && cqSequence !== 0) {
    throw new VMError("PROTOCOL_ERROR", "Userspace buffer tag trace is malformed");
  }
  const identity = { ringObjectId, resourceOrigin, resourceIndex, value };
  return stage === 1 ? { ...identity, state: "queued" } : { ...identity, state: "published", cqSequence };
}
