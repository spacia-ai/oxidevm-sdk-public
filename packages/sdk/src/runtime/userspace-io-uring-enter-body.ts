/** Typed projections of Rust-owned caller cursors; these decoders perform no syscall policy. */
import { VMError } from "./errors.ts";

interface EnterItemIdentity { readonly sqSequence: number; readonly sqeIndex: number; readonly opcode: number }
type EnterItem =
  | (EnterItemIdentity & { readonly kind: "prepared" })
  | (EnterItemIdentity & { readonly kind: "iovecs"; readonly copiedHeaders: number; readonly totalHeaders: number });

export type UserspaceIoUringEnterProgress =
  | { readonly kind: "starting" }
  | { readonly kind: "funding"; readonly submissionPages: number; readonly submissionGoal: number; readonly completionPages: number; readonly completionGoal: number }
  | { readonly kind: "submitting"; readonly submitted: number; readonly maximum: number; readonly preparedEntries: number; readonly completions: number; readonly item?: EnterItem }
  | { readonly kind: "cq-claim"; readonly outputs: number }
  | { readonly kind: "publishing"; readonly phase: "outputs" | "overflow" | "flush" | "commit"; readonly nextOutput: number; readonly ownedOutputs: number; readonly stagedTail: number; readonly retiringPages: number }
  | { readonly kind: "retiring"; readonly submitted: number; readonly submissionPages: number; readonly completionPages: number; readonly overflowPages?: number }
  | { readonly kind: "allocation-cleanup"; readonly submissionPages: number; readonly completionPages: number; readonly errno: 12 }
  | { readonly kind: "submission-cleanup"; readonly submitted: number; readonly copiedEntries: number; readonly submissionPages: number; readonly completionPages: number; readonly errno: 12 }
  | { readonly kind: "complete"; readonly submitted: number }
  | { readonly kind: "failed"; readonly errno: number };

export interface UserspaceIoUringEnterWait {
  readonly kind: "io-uring-enter";
  readonly ringOpenFileId: bigint;
  readonly admittedGuestTicks: bigint;
  readonly guestTicks: bigint;
  readonly kernelUnits: number;
  readonly reason: "turn-limit" | "cpu-quota";
  readonly metadataStorage?: "legacy" | "paged";
  readonly progress: UserspaceIoUringEnterProgress;
}

export function decodeIoUringEnterBody(bytes: Uint8Array, view: DataView, offset: number, version = 35): UserspaceIoUringEnterWait {
  const ringOpenFileId = view.getBigUint64(offset + 128, true);
  const admittedGuestTicks = view.getBigUint64(offset + 136, true), guestTicks = view.getBigUint64(offset + 200, true);
  const flags = Number(view.getBigUint64(offset + 88, true) & 0xffff_ffffn);
  const fd = view.getBigUint64(offset + 64, true) & 0xffff_ffffn;
  const kernelUnits = view.getUint32(offset + 196, true), reason = view.getUint8(offset + 193);
  const model = view.getUint8(offset + 194), phase = view.getUint8(offset + 192);
  if (phase === 13 && version < 37) throw malformed();
  const active = phase >= 2 && phase <= 10 || phase === 13;
  if (version < 36 ? view.getUint16(offset + 194, true) !== 0
    : model > 2 || view.getUint8(offset + 195) !== 0 || active !== (model !== 0)) throw malformed();
  const metadataStorage = model === 1 ? "legacy" : model === 2 ? "paged" : undefined;
  const span = BigInt.asUintN(64, view.getBigUint64(offset + 48, true) - view.getBigUint64(offset + 40, true));
  if (view.getBigUint64(offset + 56, true) !== 426n || ringOpenFileId === 0n || ringOpenFileId === 0xffff_ffff_ffff_ffffn
    || (flags & ~255) !== 0 || (flags & 16) !== 0 && fd >= 16n || (flags & 16) === 0 && fd >= 0x8000_0000n
    || kernelUnits > 128 || (reason !== 2 && reason !== 3) || reason === 2 && kernelUnits !== 128
    || guestTicks < admittedGuestTicks + BigInt(kernelUnits) || span === 0n || span > 15n
    || view.getUint16(offset + 234, true) !== 0
    || bytes.subarray(offset + 248, offset + 272).some(byte => byte !== 0)) throw malformed();
  const maximum = Math.min(32768, Number(view.getBigUint64(offset + 72, true) & 0xffff_ffffn));
  return { kind: "io-uring-enter", ringOpenFileId, admittedGuestTicks, guestTicks, kernelUnits,
    reason: reason === 2 ? "turn-limit" : "cpu-quota",
    ...(metadataStorage === undefined ? {} : { metadataStorage }),
    progress: decodeProgress(bytes, view, offset, maximum, metadataStorage === "paged") };
}

function decodeProgress(bytes: Uint8Array, view: DataView, offset: number, bound: number, paged: boolean): UserspaceIoUringEnterProgress {
  const phase = view.getUint8(offset + 192), error = view.getUint32(offset + 244, true);
  const first = view.getUint32(offset + 208, true), second = view.getUint32(offset + 212, true);
  const third = view.getUint32(offset + 216, true), fourth = view.getUint32(offset + 220, true);
  if (phase !== 3 && bytes.subarray(offset + 224, offset + 244).some(byte => byte !== 0)
    || phase !== 10 && phase !== 12 && phase !== 13 && error !== 0) throw malformed();
  const pages = paged ? 1 + Math.ceil(Math.max(bound - 2, 0) / 12) : Math.ceil(bound / 2);
  const completionPages = paged ? Math.ceil(bound / 28) : bound === 0 ? 0 : Math.ceil((bound * 256 + 128) / 4096);
  switch (phase) {
    case 1:
      if (first !== 0 || second !== 0 || third !== 0 || fourth !== 0) throw malformed();
      return { kind: "starting" };
    case 2:
      if (paged && (second !== 1 || third !== 0 || fourth !== 0)
        || first > second || third > fourth || second > pages || fourth > completionPages
        || third !== 0 && first !== second || second === 0 && fourth !== 0) throw malformed();
      return { kind: "funding", submissionPages: first, submissionGoal: second, completionPages: third, completionGoal: fourth };
    case 3: {
      if (first > second || second > bound || third > second - first || fourth > first) throw malformed();
      const item = decodeItem(bytes, view, offset);
      if (item?.kind === "prepared" && third === 0) throw malformed();
      return { kind: "submitting", submitted: first, maximum: second, preparedEntries: third, completions: fourth,
        ...(item === undefined ? {} : { item }) };
    }
    case 4:
      if (first !== 0 || second > bound || third !== 0 || fourth !== 0) throw malformed();
      return { kind: "cq-claim", outputs: second };
    case 5: case 6: case 7: case 8:
      if (first > bound || second > bound || fourth > 2049
        || (paged ? first + second > bound || phase === 6 || phase === 7 && (first !== 0 || fourth !== 0)
          : phase === 5 && first > second || phase === 6 && first !== second || phase >= 7 && second !== 0)
        || phase !== 7 && fourth !== 0) throw malformed();
      return { kind: "publishing", phase: phase === 5 ? "outputs" : phase === 6 ? "overflow" : phase === 7 ? "flush" : "commit",
        nextOutput: first, ownedOutputs: second, stagedTail: third, retiringPages: fourth };
    case 9:
      if (first > bound || second > pages || paged && second === 0 || third > completionPages
        || (paged ? fourth > 1_048_576 * 2049 : fourth !== 0)) throw malformed();
      return { kind: "retiring", submitted: first, submissionPages: second, completionPages: third,
        ...(paged ? { overflowPages: fourth } : {}) };
    case 10:
      if (first > (paged ? 1 : pages) || second > (paged ? 0 : completionPages) || third !== 0 || fourth !== 0 || error !== 12) throw malformed();
      return { kind: "allocation-cleanup", submissionPages: first, completionPages: second, errno: 12 };
    case 11:
      if (first > bound || second !== 0 || third !== 0 || fourth !== 0) throw malformed();
      return { kind: "complete", submitted: first };
    case 12:
      if (first !== 0 || second !== 0 || third !== 0 || fourth !== 0 || error === 0 || error > 4095) throw malformed();
      return { kind: "failed", errno: error };
    case 13:
      if (bound === 0 || first > bound || second > bound - first || third > pages
        || paged && third === 0 || fourth > completionPages || error !== 12) throw malformed();
      return { kind: "submission-cleanup", submitted: first, copiedEntries: second,
        submissionPages: third, completionPages: fourth, errno: 12 };
    default: throw malformed();
  }
}

function decodeItem(bytes: Uint8Array, view: DataView, offset: number): EnterItem | undefined {
  const kind = view.getUint8(offset + 233);
  if (kind === 0) {
    if (bytes.subarray(offset + 224, offset + 244).some(byte => byte !== 0)) throw malformed();
    return undefined;
  }
  const sqSequence = view.getUint32(offset + 224, true), sqeIndex = view.getUint32(offset + 228, true);
  const opcode = view.getUint8(offset + 232), copiedHeaders = view.getUint32(offset + 236, true), totalHeaders = view.getUint32(offset + 240, true);
  if (sqeIndex >= 32768 || view.getUint16(offset + 234, true) !== 0) throw malformed();
  if (kind === 1 && copiedHeaders === 0 && totalHeaders === 0) return { kind: "prepared", sqSequence, sqeIndex, opcode };
  if (kind === 2 && (opcode === 1 || opcode === 2) && totalHeaders > 0 && totalHeaders <= 1024
    && copiedHeaders < totalHeaders && copiedHeaders % 16 === 0) {
    return { kind: "iovecs", sqSequence, sqeIndex, opcode, copiedHeaders, totalHeaders };
  }
  throw malformed();
}

function malformed(): VMError { return new VMError("PROTOCOL_ERROR", "Userspace submission body trace is malformed"); }
