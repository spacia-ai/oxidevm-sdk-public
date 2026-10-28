import { VMError } from "./errors.ts";

export type IoUringIssuerPhase = "issue" | "admit-worker" | "publish" | "notify" | "retire";
export interface IoUringIssuerProgress {
  readonly generation: bigint;
  readonly phase: IoUringIssuerPhase;
}
export interface IoUringExitedIssuerProgress extends IoUringIssuerProgress {
  readonly phase: "publish" | "notify" | "retire";
}
export interface IoUringIssuerWait extends IoUringIssuerProgress {
  readonly kind: "io-uring-issuer";
  readonly ringOpenFileId: bigint;
  readonly pendingRequests: number;
  readonly kernelUnits: number;
  readonly reason: "turn-limit" | "cpu-quota" | "cq-writer";
}

/** The versioned trailer belongs to either ordinary task work or its caller's yield. */
export function validateIoUringIssuerTrailer(bytes: Uint8Array, view: DataView,
  offset: number, version: number): void {
  if (version < 38) return;
  const executor = view.getUint8(offset + 624);
  const cpu = version >= 40 && view.getUint8(offset + 123) === 1 && [3, 4, 5].includes(executor);
  const closing = version >= 40 ? view.getUint8(offset + 938) : 0;
  if (closing !== 0 && (!cpu || closing !== 1)) throw malformed();
  const nonzero = (start: number, end: number): boolean => cpu && start <= 938 && end > 938
    ? bytes.subarray(offset + start, offset + 938).some(byte => byte !== 0)
      || bytes.subarray(offset + 939, offset + end).some(byte => byte !== 0)
    : bytes.subarray(offset + start, offset + end).some(byte => byte !== 0);
  const reservedEnd = cpu ? 952 : 960;
  const release = version >= 40 && view.getUint8(offset + 123) === 1
    && view.getUint8(offset + 234) === 8 && view.getUint8(offset + 784) === 1
    && (view.getUint8(offset + 786) === 3 || closing === 1);
  if (release) {
    if (bytes.subarray(offset + 928, offset + 937).some(byte => byte !== 0)
      || nonzero(938, 940)) throw malformed();
    return;
  }
  const work = view.getUint8(offset + 123) === 1 && (executor === 7
    || version >= 39 && [3, 4, 5].includes(executor) && view.getBigUint64(offset + 928, true) !== 0n);
  const wait = view.getUint8(offset + 123) === 0 && view.getUint8(offset + 122) === 16;
  if (work || wait) {
    decodeIoUringIssuerProgress(view, offset);
    if (nonzero(938, 940) || nonzero(944, reservedEnd)
      || work && nonzero(937, 944)) throw malformed();
  } else if (nonzero(928, reservedEnd)) throw malformed();
}

export function decodeIoUringExitedIssuerProgress(view: DataView, offset: number,
  version: number): IoUringExitedIssuerProgress | undefined {
  if (version < 39 || view.getBigUint64(offset + 928, true) === 0n) return undefined;
  const { generation, phase } = decodeIoUringIssuerProgress(view, offset);
  if (phase !== "publish" && phase !== "notify" && phase !== "retire") throw malformed();
  return { generation, phase };
}

export function decodeIoUringIssuerProgress(view: DataView, offset: number): IoUringIssuerProgress {
  const generation = view.getBigUint64(offset + 928, true);
  const phase = decodePhase(view.getUint8(offset + 936));
  if (generation === 0n) throw malformed();
  return { generation, phase };
}

export function decodeIoUringIssuerWait(bytes: Uint8Array, view: DataView, offset: number): IoUringIssuerWait {
  const progress = decodeIoUringIssuerProgress(view, offset);
  const ringOpenFileId = view.getBigUint64(offset + 128, true);
  const pending = view.getBigUint64(offset + 136, true), tag = view.getUint8(offset + 937);
  const reason = tag === 1 ? "turn-limit" : tag === 2 ? "cpu-quota" : tag === 3 ? "cq-writer" : undefined;
  const kernelUnits = view.getUint32(offset + 940, true);
  if (ringOpenFileId === 0n || ringOpenFileId === 0xffff_ffff_ffff_ffffn
    || pending === 0n || pending > 1_048_576n || reason === undefined || kernelUnits > 128
    || reason === "turn-limit" && kernelUnits !== 128
    || reason === "cq-writer" && progress.phase !== "publish"
    || bytes.subarray(offset + 192, offset + 272).some(byte => byte !== 0)) throw malformed();
  return { kind: "io-uring-issuer", ...progress, ringOpenFileId, pendingRequests: Number(pending), reason, kernelUnits };
}

function decodePhase(tag: number): IoUringIssuerPhase {
  switch (tag) {
    case 1: return "issue";
    case 2: return "admit-worker";
    case 3: return "publish";
    case 4: return "notify";
    case 5: return "retire";
    default: throw malformed();
  }
}

function malformed(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace issuer generation trace is malformed");
}
