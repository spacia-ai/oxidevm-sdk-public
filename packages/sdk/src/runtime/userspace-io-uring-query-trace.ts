import { VMError } from "./errors.ts";

/** The next effect in a copied registration query; no guest payload bytes cross the wire. */
export interface UserspaceIoUringQueryWait {
  readonly kind: "io-uring-query";
  readonly headerAddress: bigint;
  readonly completedQueries: number;
  readonly ringOpenFileId: bigint | null;
  readonly stage: "header" | "clear-tail" | "payload" | "copy-header";
  readonly operation: number | null;
  readonly dataAddress: bigint;
  readonly nextByte: number;
  readonly requestedBytes: number;
  readonly reason: "turn-limit" | "cpu-quota";
}

export function decodeIoUringQueryWait(bytes: Uint8Array, view: DataView, offset: number): UserspaceIoUringQueryWait {
  const headerAddress = view.getBigUint64(offset + 128, true);
  const completed = view.getBigUint64(offset + 136, true);
  const phase = view.getUint8(offset + 192);
  const reason = view.getUint8(offset + 193);
  const present = view.getUint8(offset + 194);
  const operation = view.getUint32(offset + 196, true);
  const dataAddress = view.getBigUint64(offset + 200, true);
  const nextByte = view.getUint32(offset + 208, true);
  const requestedBytes = view.getUint32(offset + 212, true);
  const ring = view.getBigUint64(offset + 216, true);
  const descriptor = view.getBigUint64(offset + 64, true) & 0xffff_ffffn;
  const global = descriptor === 0xffff_ffffn;
  const registered = (view.getBigUint64(offset + 72, true) & 0x8000_0000n) !== 0n;
  const responseBytes = Math.min(requestedBytes, operation === 0 ? 48 : operation === 1 ? 40 : operation === 2 ? 16 : 0);
  const stage = phase === 1 ? "header" : phase === 2 ? "clear-tail" : phase === 3 ? "payload" : phase === 4 ? "copy-header" : undefined;
  const registeredOperation = view.getBigUint64(offset + 72, true) & 0x7fff_ffffn;
  if (stage === undefined || reason !== 1 && reason !== 2 || completed > 1000n
    || view.getBigUint64(offset + 56, true) !== 427n || registeredOperation !== 35n
    || (view.getBigUint64(offset + 88, true) & 0xffff_ffffn) !== 0n
    || (ring === 0n) !== global || ring === 0xffff_ffff_ffff_ffffn
    || !global && (descriptor > 0x7fff_ffffn || registered && descriptor >= 16n)
    || completed === 0n && headerAddress !== view.getBigUint64(offset + 80, true)
    || view.getUint8(offset + 195) !== 0 || bytes.subarray(offset + 224, offset + 272).some(byte => byte !== 0)
    || (stage === "header"
      ? present !== 0 || operation !== 0 || dataAddress !== 0n || nextByte !== 0 || requestedBytes !== 0
      : present !== 1 || headerAddress === 0n || completed === 1000n || nextByte > requestedBytes
        || stage !== "clear-tail" && nextByte !== 0
        || stage === "clear-tail" && (nextByte >= requestedBytes
          || nextByte % 64 !== 0 && (nextByte < responseBytes || (nextByte - responseBytes) % 64 !== 0))
        || stage === "payload" && (operation > 2 || requestedBytes === 0))) throw malformed();
  return { kind: "io-uring-query", ringOpenFileId: ring === 0n ? null : ring, headerAddress, completedQueries: Number(completed), stage,
    operation: present === 0 ? null : operation, dataAddress, nextByte, requestedBytes,
    reason: reason === 1 ? "turn-limit" : "cpu-quota" };
}

function malformed(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace registration query trace is malformed");
}
