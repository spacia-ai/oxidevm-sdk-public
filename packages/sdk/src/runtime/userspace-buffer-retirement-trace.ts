import { VMError } from "./errors.ts";

/** The owned cleanup action and its counters before this charged kernel step. */
export interface BufferRetirement {
  readonly completion: "skipped" | "pending" | "published" | "released";
  readonly phase: "select" | "unaccount" | "unpin" | "buffer-metadata" | "tag-metadata" | "metadata-pool" | "owner" | "finished" | "tag";
  readonly ringObjectId: bigint;
  readonly resource?: { readonly origin: bigint; readonly index: number };
  readonly pinsBefore: bigint;
  readonly metadataReferencesBefore: bigint;
  readonly tag: bigint;
  readonly release?: RingReleaseProgress;
}

export type RingReleaseProgress =
  | { readonly phase: "copied-inputs"; readonly copiedEntries: number; readonly submissionPages: number; readonly completionPages: number }
  | { readonly phase: "submission-metadata" | "completion-metadata"; readonly copiedEntries: 0; readonly submissionPages: number; readonly completionPages: number }
  | { readonly phase: "owner"; readonly copiedEntries: 0; readonly submissionPages: 0; readonly completionPages: 0 }
  | { readonly phase: "queue-unaccount" | "queue-rings" | "queue-sqes" | "queue-metadata" | "queue-owner"; readonly ringsPages: number; readonly sqePages: number; readonly metadataPages: number };

export function decodeBufferRetirement(
  bytes: Uint8Array, view: DataView, offset: number, version: number,
): BufferRetirement | undefined {
  const present = view.getUint8(offset + 784);
  if (present === 0) {
    if (bytes.subarray(offset + 785, offset + 832).some(byte => byte !== 0)) throw malformed();
    return undefined;
  }
  const phase = decodeBufferDisposalPhase(view.getUint8(offset + 785)), completion = view.getUint8(offset + 786);
  const resource = view.getUint8(offset + 787), index = view.getUint16(offset + 788, true);
  const ringObjectId = view.getBigUint64(offset + 792, true), origin = view.getBigUint64(offset + 800, true);
  const pinsBefore = view.getBigUint64(offset + 808, true), metadataReferencesBefore = view.getBigUint64(offset + 816, true);
  const tag = view.getBigUint64(offset + 824, true);
  const release = version >= 40 ? decodeRelease(view, offset) : undefined;
  const closing = version >= 40 && view.getUint8(offset + 938) === 1;
  const closingTransfer = closing && phase === "select" && resource === 0
    && metadataReferencesBefore === 0n;
  if (present !== 1 || completion > (version >= 40 ? 3 : 2) || resource > 1 || index >= 16384 || ringObjectId === 0n
    || view.getUint16(offset + 790, true) !== 0 || (resource === 0 ? origin !== 0n || index !== 0 || pinsBefore !== 0n || tag !== 0n : origin === 0n)
    || view.getUint8(offset + 123) !== 1 || view.getUint8(offset + 234) !== 8
    || ![4, 5].includes(view.getUint8(offset + 232))
      && !closingTransfer
      && !(release !== undefined && (closing || completion === 3 && [1, 2, 22, 23].includes(view.getUint8(offset + 232))))
    || (phase === "unaccount" || phase === "unpin") && (resource !== 1 || pinsBefore === 0n)
    || phase === "buffer-metadata" && (resource !== 1 || metadataReferencesBefore === 0n || pinsBefore !== 0n)
    || phase === "tag-metadata" && (resource !== 1 || tag === 0n || pinsBefore !== 0n)
    || phase === "tag" && (resource !== 1 || tag === 0n)
    || (phase === "owner" || phase === "finished") && (resource !== 0 || metadataReferencesBefore !== 0n)
    || phase === "metadata-pool" && resource !== 0
    || closing && completion === 3
    || release !== undefined && (completion !== 3 && !closing || phase !== "finished")) throw malformed();
  return {
    phase, completion: completion === 0 ? "skipped" : completion === 1 ? "pending" : completion === 2 ? "published" : "released",
    ringObjectId, pinsBefore, metadataReferencesBefore, tag,
    ...(resource === 0 ? {} : { resource: { origin, index } }),
    ...(release === undefined ? {} : { release }),
  };
}

function decodeRelease(view: DataView, at: number): RingReleaseProgress | undefined {
  const tag = view.getUint8(at + 937), copiedEntries = view.getUint32(at + 940, true);
  const submissionPages = view.getUint32(at + 944, true), completionPages = view.getUint32(at + 948, true);
  if (tag === 0) {
    if (copiedEntries !== 0 || submissionPages !== 0 || completionPages !== 0) throw malformed();
    return undefined;
  }
  if (copiedEntries > 32768 || submissionPages > 16385 || completionPages > 16385) throw malformed();
  if (tag >= 5) {
    const metadataPages = copiedEntries, ringsPages = submissionPages, sqePages = completionPages;
    if (metadataPages > 1024 || ringsPages > 1024 || sqePages > 1024) throw malformed();
    const phase = tag === 5 && ringsPages + sqePages + metadataPages !== 0 ? "queue-unaccount"
      : tag === 6 && ringsPages !== 0 && sqePages === 0 ? "queue-rings"
        : tag === 7 && sqePages !== 0 ? "queue-sqes"
          : tag === 8 && ringsPages === 0 && sqePages === 0 && metadataPages !== 0 ? "queue-metadata"
            : tag === 9 && ringsPages === 0 && sqePages === 0 && metadataPages === 0 ? "queue-owner" : undefined;
    if (phase === undefined) throw malformed();
    return { phase, metadataPages, ringsPages, sqePages };
  }
  if (tag === 1 && copiedEntries !== 0) return { phase: "copied-inputs", copiedEntries, submissionPages, completionPages };
  if (copiedEntries !== 0) throw malformed();
  if (tag === 2 && submissionPages !== 0 && completionPages === 0) return {
    phase: "submission-metadata", copiedEntries: 0, submissionPages, completionPages,
  };
  if (tag === 3 && completionPages !== 0) return {
    phase: "completion-metadata", copiedEntries: 0, submissionPages, completionPages,
  };
  if (tag === 4 && submissionPages === 0 && completionPages === 0) return {
    phase: "owner", copiedEntries: 0, submissionPages: 0, completionPages: 0,
  };
  throw malformed();
}

export function decodeBufferDisposalPhase(value: number): BufferRetirement["phase"] {
  switch (value) {
    case 1: return "select"; case 2: return "unaccount"; case 3: return "unpin";
    case 4: return "buffer-metadata"; case 5: return "tag-metadata"; case 6: return "metadata-pool";
    case 7: return "owner"; case 8: return "finished"; case 9: return "tag";
    default: throw malformed();
  }
}

function malformed(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace registered-resource retirement is malformed");
}
