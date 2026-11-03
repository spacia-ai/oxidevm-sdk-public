import { exactKeys, integer, record, string } from "../decode.js";
import { decodeErrorCode, VMError, type VMErrorCode } from "../errors.js";

/**
 * Image reads the Userspace worker answered with a guest error (worker protocol 179). The guest sees
 * only EIO, so the profile keeps the storage owner's typed cause for each refused read.
 */

/** The storage owner's typed causes; any other cause is `unclassified`, never dropped. */
export const USERSPACE_STORAGE_FAILURE_REASONS = [
  "image-pack-space-refused",
  "image-pack-write-refused",
  "image-pack-write-failed",
  "image-pack-fetch-failed",
  "image-pack-damaged",
  "image-not-cached",
  "response-invalid",
  "unclassified",
] as const;
export type UserspaceStorageFailureReason = (typeof USERSPACE_STORAGE_FAILURE_REASONS)[number];

export interface UserspaceStorageFailure {
  readonly code: VMErrorCode;
  readonly reason: UserspaceStorageFailureReason;
  /** The guest path the read was for. */
  readonly path: string;
  /** The pack chunk whose acquisition or read failed, when the cause names one. */
  readonly chunk?: string;
}

export interface UserspaceStorageFailureProfile {
  /** Refused reads since the runtime started; `recent` holds the latest of them. */
  readonly total: number;
  readonly recent: readonly UserspaceStorageFailure[];
}

export const MAX_RECENT_STORAGE_FAILURES = 16;
const MAX_PATH = 4096;
const CHUNK = /^[0-9a-f]{64}$/u;

export function emptyUserspaceStorageFailureProfile(): UserspaceStorageFailureProfile {
  return { total: 0, recent: [] };
}

export function decodeUserspaceStorageFailureProfile(value: unknown): UserspaceStorageFailureProfile {
  const profile = record(value, "Userspace storage failures");
  exactKeys(profile, ["total", "recent"]);
  const total = integer(profile["total"], "Userspace storage failure total", 0);
  const recent = profile["recent"];
  if (!Array.isArray(recent) || recent.length > Math.min(total, MAX_RECENT_STORAGE_FAILURES)) {
    throw new VMError("PROTOCOL_ERROR", "Userspace storage failure list is invalid");
  }
  return { total, recent: Array.from<unknown>(recent).map(decodeFailure) };
}

function decodeFailure(value: unknown): UserspaceStorageFailure {
  const failure = record(value, "Userspace storage failure");
  exactKeys(failure, ["code", "reason", "path"], ["chunk"]);
  const code = decodeErrorCode(string(failure["code"], "Userspace storage failure code"));
  const reason = string(failure["reason"], "Userspace storage failure reason");
  const path = string(failure["path"], "Userspace storage failure path");
  const chunk = failure["chunk"] === undefined ? undefined : string(failure["chunk"], "Userspace storage failure chunk");
  if (!isReason(reason) || path.length > MAX_PATH || (chunk !== undefined && !CHUNK.test(chunk))) {
    throw new VMError("PROTOCOL_ERROR", "Userspace storage failure is invalid");
  }
  return { code, reason, path, ...(chunk === undefined ? {} : { chunk }) };
}

function isReason(value: string): value is UserspaceStorageFailureReason {
  return USERSPACE_STORAGE_FAILURE_REASONS.some(reason => reason === value);
}
