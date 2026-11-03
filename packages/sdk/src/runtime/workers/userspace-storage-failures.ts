import { VMError } from "../errors.js";
import {
  MAX_RECENT_STORAGE_FAILURES, USERSPACE_STORAGE_FAILURE_REASONS,
  type UserspaceStorageFailure, type UserspaceStorageFailureProfile, type UserspaceStorageFailureReason,
} from "../protocol/userspace-storage-failures.js";

/** The guest completion a refused image read gets; Rust maps these to ENOENT, EINTR and EIO. */
export type UserspaceStorageCompletionKind = "not-found" | "aborted" | "io";

/**
 * One runtime's refused image reads. Each read the guest sees as EIO keeps the storage owner's typed cause:
 * the error code, its `detail.reason`, the guest path and the pack chunk, bounded to the latest few.
 */
export class UserspaceStorageFailures {
  #total = 0;
  readonly #recent: UserspaceStorageFailure[] = [];

  /** Classifies a failed read for the guest and records every one that becomes EIO. */
  record(error: unknown, path: string): UserspaceStorageCompletionKind {
    if (error instanceof VMError && error.code === "STORAGE_NOT_FOUND") return "not-found";
    if (error instanceof VMError && error.code === "ABORTED") return "aborted";
    const detail = error instanceof VMError ? error.detail : undefined, chunk = detail?.["chunk"];
    this.#total++;
    this.#recent.push({
      code: error instanceof VMError ? error.code : "STORAGE_ERROR",
      reason: storageFailureReason(error),
      path: path.slice(0, 4096),
      ...(typeof chunk === "string" && /^[0-9a-f]{64}$/u.test(chunk) ? { chunk } : {}),
    });
    if (this.#recent.length > MAX_RECENT_STORAGE_FAILURES) this.#recent.shift();
    return "io";
  }

  profile(): UserspaceStorageFailureProfile {
    return { total: this.#total, recent: this.#recent.map(failure => ({ ...failure })) };
  }
}

function storageFailureReason(error: unknown): UserspaceStorageFailureReason {
  if (!(error instanceof VMError)) return "unclassified";
  if (error.code === "PROTOCOL_ERROR") return "response-invalid";
  const reason = error.detail?.["reason"];
  return USERSPACE_STORAGE_FAILURE_REASONS.find(known => known === reason) ?? "unclassified";
}
