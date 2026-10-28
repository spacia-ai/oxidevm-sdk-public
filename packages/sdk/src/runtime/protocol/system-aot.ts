import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { SYSTEM_TRACE_SCHEMA_VERSION } from "./system-trace-schema.js";

export interface SystemAotPackStatus {
  readonly sha256: string;
  readonly phase: "command" | "ready" | "first-request" | "warm-request" | "rebuild";
  readonly bytes: number;
  readonly memberCount: number;
  readonly state: "queued" | "compiling" | "compiled" | "failed";
  readonly beforeFirstEncounter: boolean;
  readonly fetchMilliseconds: number;
  readonly hashMilliseconds: number;
  readonly compileMilliseconds: number;
}

export interface SystemAotStatus {
  readonly kind: "disabled" | "configured";
  readonly reason: "no-catalog" | "untrusted-catalog" | "invalid-catalog" | "offline" | null;
  readonly catalogSha256: string | null;
  readonly indexSha256: string | null;
  readonly keyId: string | null;
  readonly signatureVerified: boolean;
  readonly encounters: number;
  readonly instantiateMilliseconds: number;
  readonly packs: readonly SystemAotPackStatus[];
}

/** Decodes the AOT status of a system trace of `schemaVersion`; "offline" needs schema 42. */
export function decodeSystemAotStatus(value: unknown, schemaVersion: number = SYSTEM_TRACE_SCHEMA_VERSION): SystemAotStatus {
  const status = record(value, "system AOT status");
  exactKeys(status, [
    "kind", "reason", "catalogSha256", "indexSha256", "keyId",
    "signatureVerified", "encounters", "instantiateMilliseconds", "packs",
  ]);
  const kind = string(status["kind"], "system AOT status kind");
  if (kind !== "disabled" && kind !== "configured") throw invalid("system AOT status kind is invalid");
  const reason = status["reason"] === null ? null : skipReason(status["reason"], schemaVersion);
  const catalogSha256 = nullableDigest(status["catalogSha256"], "system AOT catalog digest");
  const indexSha256 = nullableDigest(status["indexSha256"], "system AOT index digest");
  const keyId = status["keyId"] === null ? null : string(status["keyId"], "system AOT key ID");
  const signatureVerified = boolean(status["signatureVerified"], "system AOT signature status");
  if (
    kind === "configured"
      ? reason !== null || catalogSha256 === null || indexSha256 === null || keyId === null || !signatureVerified
      : catalogSha256 !== null || indexSha256 !== null || keyId !== null || signatureVerified
  ) throw invalid("system AOT status identity is inconsistent");
  if (!Array.isArray(status["packs"]) || status["packs"].length > 64) {
    throw invalid("system AOT pack status is invalid");
  }
  const packs = status["packs"].map(decodePackStatus);
  if (kind === "disabled" && packs.length !== 0) throw invalid("disabled AOT has packs");
  return {
    kind,
    reason,
    catalogSha256,
    indexSha256,
    keyId,
    signatureVerified,
    encounters: integer(status["encounters"], "system AOT encounters", 0),
    instantiateMilliseconds: duration(status["instantiateMilliseconds"], "system AOT instantiate time"),
    packs,
  };
}

function decodePackStatus(value: unknown, index: number): SystemAotPackStatus {
  const pack = record(value, `system AOT packs[${index}]`);
  exactKeys(pack, [
    "sha256", "phase", "bytes", "memberCount", "state", "beforeFirstEncounter",
    "fetchMilliseconds", "hashMilliseconds", "compileMilliseconds",
  ]);
  const phase = string(pack["phase"], `system AOT packs[${index}].phase`);
  if (phase !== "command" && phase !== "ready" && phase !== "first-request" && phase !== "warm-request" && phase !== "rebuild") {
    throw invalid("system AOT pack phase is invalid");
  }
  const state = string(pack["state"], `system AOT packs[${index}].state`);
  if (state !== "queued" && state !== "compiling" && state !== "compiled" && state !== "failed") {
    throw invalid("system AOT pack state is invalid");
  }
  return {
    sha256: digest(pack["sha256"], `system AOT packs[${index}].digest`),
    phase,
    bytes: integer(pack["bytes"], `system AOT packs[${index}].bytes`, 1, 4 * 1024 * 1024),
    memberCount: integer(pack["memberCount"], `system AOT packs[${index}].members`, 1, 256),
    state,
    beforeFirstEncounter: boolean(pack["beforeFirstEncounter"], `system AOT packs[${index}].prewarm`),
    fetchMilliseconds: duration(pack["fetchMilliseconds"], `system AOT packs[${index}].fetch time`),
    hashMilliseconds: duration(pack["hashMilliseconds"], `system AOT packs[${index}].hash time`),
    compileMilliseconds: duration(pack["compileMilliseconds"], `system AOT packs[${index}].compile time`),
  };
}

function nullableDigest(value: unknown, name: string): string | null {
  return value === null ? null : digest(value, name);
}

function digest(value: unknown, name: string): string {
  const decoded = string(value, name);
  if (!/^[0-9a-f]{64}$/u.test(decoded)) throw invalid(`${name} is invalid`);
  return decoded;
}

function skipReason(value: unknown, schemaVersion: number): SystemAotStatus["reason"] {
  const reason = string(value, "system AOT skip reason");
  if (reason === "no-catalog" || reason === "untrusted-catalog" || reason === "invalid-catalog") return reason;
  if (reason === "offline" && schemaVersion >= 42) return reason;
  throw invalid("system AOT skip reason is invalid");
}

function duration(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw invalid(`${name} is invalid`);
  return value;
}

function invalid(message: string): VMError {
  return new VMError("PROTOCOL_ERROR", message);
}
