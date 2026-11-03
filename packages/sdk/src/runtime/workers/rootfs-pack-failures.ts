import { normalizeStorageError, serializeUnknownError, VMError } from "../errors.js";
import { refusedForSpace, refusedWrite } from "./browser-quota.js";

/** Where an on-demand pack acquisition stopped. */
export type RootfsPackStage = "fetch" | "decode" | "write" | "verify";

/** Why a pack could not be read in place; the caller then falls back to the loose file or acquires the pack. */
export type RootfsPackMissReason = "pack-missing" | "pack-damaged" | "pack-unreadable";
export interface RootfsPackMiss { readonly reason: RootfsPackMissReason; readonly chunk: string }

/**
 * The typed failure of one pack acquisition: a refused write keeps `QUOTA_EXCEEDED`, a cancellation stays
 * `ABORTED`, and every other cause becomes a storage error naming the chunk, the stage and the original error.
 */
export function packAcquisitionFailure(error: unknown, chunk: string, stage: RootfsPackStage): VMError {
  if (error instanceof VMError && error.code === "ABORTED") return error;
  const reason = refusedForSpace(error) ? "image-pack-space-refused"
    : stage === "write" ? refusedWrite(error) ? "image-pack-write-refused" : "image-pack-write-failed"
      : stage === "fetch" ? "image-pack-fetch-failed"
        : "image-pack-damaged";
  const code = reason === "image-pack-space-refused" ? "QUOTA_EXCEEDED"
    // A missing pack artifact is a broken image, not a missing guest file.
    : error instanceof VMError && stage === "fetch" && error.code !== "STORAGE_NOT_FOUND" ? error.code
      : "STORAGE_ERROR";
  const message = error instanceof Error ? error.message : "Rootfs pack acquisition failed";
  return new VMError(code, message, { reason, chunk, stage, cause: serializeUnknownError(error instanceof DOMException ? normalizeStorageError(error) : error) });
}

/** Classifies a failed in-place pack read; only a missing or damaged pack is an expected miss. */
export function packMiss(error: unknown, chunk: string): RootfsPackMiss {
  if (error instanceof DOMException && error.name === "NotFoundError") return { reason: "pack-missing", chunk };
  if (error instanceof VMError && error.code === "STORAGE_ERROR" && error.detail?.["reason"] === "image-not-cached") return { reason: "pack-damaged", chunk };
  return { reason: "pack-unreadable", chunk };
}
