import type { LicenseRejection, LicenseStatus } from "./contracts.js";
import { VMError } from "./runtime/errors.js";

// License admission (ADR 0021). The engine decides: this module stages the input for the engine's
// `oxidevm_license_admit` export and decodes its record. It instantiates the already verified
// engine module once with imports that refuse to run, because admission never calls the host.

const STATUS_OK = 0;
const RECORD_VERSION = 2;
const MAX_ORIGIN_BYTES = 256;
const MAX_TOKEN_BYTES = 4096;
const FLAG_SELF_HOST = 2;
const FLAG_COMMERCIAL = 1;
const FLAG_NO_TELEMETRY = 4;

const REJECTIONS: Readonly<Record<number, LicenseRejection>> = {
  1: "malformed", 2: "unsupported-version", 3: "unknown-key", 4: "bad-signature", 5: "expired", 6: "not-yet-valid",
  7: "origin-mismatch", 8: "not-self-host-license", 9: "self-host-requires-license",
  11: "public-requires-license", 12: "issuer-policy-violation",
};

export interface AdmissionInput {
  /** The origin this engine runs on. */
  readonly runtimeOrigin: string;
  /** The page that embeds the runtime frame, or the runtime origin when self-hosted. */
  readonly embedderOrigin: string;
  readonly token?: string;
  readonly nowSeconds: number;
}

export function encodeAdmissionInput(input: Omit<AdmissionInput, "nowSeconds">): Uint8Array {
  const fields = [input.runtimeOrigin, input.embedderOrigin, input.token ?? ""].map(text => new TextEncoder().encode(text));
  if ((fields[0]?.length ?? 0) > MAX_ORIGIN_BYTES || (fields[1]?.length ?? 0) > MAX_ORIGIN_BYTES || (fields[2]?.length ?? 0) > MAX_TOKEN_BYTES) {
    throw new VMError("INVALID_ARGUMENT", "license token or origin is too long");
  }
  const bytes = new Uint8Array(fields.reduce((sum, field) => sum + 2 + field.length, 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const field of fields) { view.setUint16(offset, field.length, true); bytes.set(field, offset + 2); offset += 2 + field.length; }
  return bytes;
}

/**
 * Decodes version 2 admission. Legacy records and free decisions fail closed.
 */
export function decodeAdmissionRecord(record: Uint8Array): LicenseStatus {
  const reason = (code: number | undefined): LicenseRejection | undefined => code === undefined || code === 0 ? undefined : REJECTIONS[code];
  if (record[0] !== RECORD_VERSION || record.length < 3) throw new VMError("CORE_LOAD_FAILED", "the engine returned an unknown license record");
  const rejected = reason(record[2]);
  if (record[2] !== 0 && rejected === undefined) throw new VMError("CORE_LOAD_FAILED", "the engine returned an unknown license reason");
  switch (record[1] ?? -1) {
    case 1:
      if (record.length !== 3 || rejected !== undefined) break;
      return { tier: "development" };
    case 3:
      if (record.length !== 3 || rejected === undefined) break;
      { const required = rejected === "self-host-requires-license" || rejected === "public-requires-license";
        throw new VMError("PERMISSION_DENIED", required
          ? "this public origin needs an OxideVM license token (runtime.license); register at https://accounts.oxidevm.dev/"
          : `the license token does not admit this origin (${rejected})`, { reason: required ? "license-required" : "license-invalid", rejected }); }
    case 2: {
      if (record.length < 38 || rejected !== undefined) break;
      const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
      const length = record[37] ?? 0;
      const flags = record[35] ?? 0;
      const validity = record[36];
      const expiresAt = Number(view.getBigUint64(19, true));
      const validUntil = Number(view.getBigUint64(27, true));
      if (length > 64 || record.length !== 38 + length || flags > 7 || (validity !== 0 && validity !== 1)
        || !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(validUntil) || validUntil <= expiresAt) break;
      const licenseId = Array.from(record.subarray(3, 19), byte => byte.toString(16).padStart(2, "0")).join("");
      let licensee: string;
      try { licensee = new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(38)); }
      catch { throw new VMError("CORE_LOAD_FAILED", "the engine returned an invalid license name"); }
      return {
        tier: "licensed", licenseId, licensee, expiresAt, validUntil,
        commercial: (flags & FLAG_COMMERCIAL) !== 0, validity: validity === 0 ? "active" : "grace",
        selfHost: (flags & FLAG_SELF_HOST) !== 0, telemetry: (flags & FLAG_NO_TELEMETRY) === 0,
      };
    }
    default:
      break;
  }
  throw new VMError("CORE_LOAD_FAILED", "the engine returned a malformed license record");
}

/** Runs the engine's admission on its verified module: its bytes, or the Blob URL that holds them. */
export async function admitLicense(module: BufferSource | string | WebAssembly.Module, input: AdmissionInput): Promise<LicenseStatus> {
  const compiled = module instanceof WebAssembly.Module ? module : await WebAssembly.compile(typeof module === "string" ? await (await fetch(module)).arrayBuffer() : module);
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  for (const entry of WebAssembly.Module.imports(compiled)) {
    if (entry.kind !== "function") throw new VMError("CORE_LOAD_FAILED", "the engine module imports more than functions");
    (imports[entry.module] ??= {})[entry.name] = () => { throw new Error("license admission must not call the host"); };
  }
  const instance = await WebAssembly.instantiate(compiled, imports);
  const call = (name: string, ...args: (number | bigint)[]): number => {
    const value: unknown = instance.exports[name];
    if (typeof value !== "function") throw new VMError("CORE_LOAD_FAILED", `the engine has no ${name}`);
    const result: unknown = Reflect.apply(value, undefined, args);
    if (typeof result !== "number") throw new VMError("CORE_LOAD_FAILED", `${name} returned no status`);
    return result;
  };
  const memory = instance.exports["memory"];
  if (!(memory instanceof WebAssembly.Memory)) throw new VMError("CORE_LOAD_FAILED", "the engine exports no memory");
  const bytes = encodeAdmissionInput(input);
  if (call("oxidevm_staging_resize", bytes.length) !== STATUS_OK) throw new VMError("CORE_LOAD_FAILED", "the engine refused the license input");
  new Uint8Array(memory.buffer, call("oxidevm_staging_ptr"), bytes.length).set(bytes);
  if (call("oxidevm_license_admit", bytes.length, BigInt(Math.max(0, Math.floor(input.nowSeconds)))) !== STATUS_OK) {
    throw new VMError("INVALID_ARGUMENT", "the engine could not read the license input");
  }
  return decodeAdmissionRecord(new Uint8Array(memory.buffer, call("oxidevm_result_ptr"), call("oxidevm_result_len")).slice());
}
