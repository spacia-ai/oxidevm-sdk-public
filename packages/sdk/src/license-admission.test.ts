import { describe, expect, it } from "vitest";
import { VMError } from "./runtime/errors.js";
import { decodeAdmissionRecord, encodeAdmissionInput } from "./license-admission.js";

function code(run: () => unknown): string {
  try { run(); } catch (error) { if (error instanceof VMError) return error.code; throw error; }
  throw new Error("expected a VMError");
}

describe("license admission records", () => {
  it("rejects legacy development and free records instead of trusting old admission", () => {
    for (const tier of [0, 1]) expect(code(() => decodeAdmissionRecord(Uint8Array.from([1, tier, 0])))).toBe("CORE_LOAD_FAILED");
  });
  it("reports the new public license requirement", () => {
    try { decodeAdmissionRecord(Uint8Array.from([2, 3, 11])); throw new Error("admitted"); }
    catch (error) { expect(error).toMatchObject({ code: "PERMISSION_DENIED", detail: { reason: "license-required", rejected: "public-requires-license" } }); }
  });
  it("retains commercial permissions and grace metadata from the engine", () => {
    const time = (value: bigint) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); return bytes; };
    const record = Uint8Array.from([2, 2, 0, ...Array<number>(16).fill(9), ...time(1_800_000_000n), ...time(1_800_604_800n), 0, 1, 1, 76]);
    expect(decodeAdmissionRecord(record)).toMatchObject({ tier: "licensed", commercial: false, validity: "grace", expiresAt: 1_800_000_000, validUntil: 1_800_604_800 });
  });
  it("encodes the three length-prefixed fields the engine reads", () => {
    expect([...encodeAdmissionInput({ runtimeOrigin: "a", embedderOrigin: "bc" })]).toEqual([1, 0, 97, 2, 0, 98, 99, 0, 0]);
    expect(code(() => encodeAdmissionInput({ runtimeOrigin: "x".repeat(257), embedderOrigin: "b" }))).toBe("INVALID_ARGUMENT");
  });
  it("decodes version 2 development and licensed tiers", () => {
    expect(decodeAdmissionRecord(Uint8Array.from([2, 1, 0]))).toEqual({ tier: "development" });
    const time = (value: bigint) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); return bytes; };
    const licensed = Uint8Array.from([2, 2, 0, ...Array<number>(16).fill(9), ...time(1_800_000_010n), ...time(1_800_604_810n), 3, 0, 2, 65, 66]);
    expect(decodeAdmissionRecord(licensed)).toEqual({ tier: "licensed", licenseId: "09".repeat(16), licensee: "AB", expiresAt: 1_800_000_010, validUntil: 1_800_604_810, validity: "active", commercial: true, selfHost: true, telemetry: true });
    licensed[35] = 5;
    expect(decodeAdmissionRecord(licensed)).toMatchObject({ selfHost: false, telemetry: false });
  });
  it("turns a refusal into PERMISSION_DENIED that names license-required or license-invalid", () => {
    try { decodeAdmissionRecord(Uint8Array.from([2, 3, 9])); throw new Error("admitted"); }
    catch (error) { expect(error).toMatchObject({ code: "PERMISSION_DENIED", detail: { reason: "license-required" } }); }
    try { decodeAdmissionRecord(Uint8Array.from([2, 3, 8])); throw new Error("admitted"); }
    catch (error) { expect(error).toMatchObject({ code: "PERMISSION_DENIED", detail: { reason: "license-invalid", rejected: "not-self-host-license" } }); }
  });
  it.each([[2, 0, 0], [1, 4, 0], [1, 0, 99], [1, 0], [1, 1, 0, 0], [1, 2, 0, 1]])("rejects a malformed record %j", (...record) => {
    expect(code(() => decodeAdmissionRecord(Uint8Array.from(record)))).toBe("CORE_LOAD_FAILED");
  });
});
