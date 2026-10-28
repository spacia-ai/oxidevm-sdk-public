import { describe, expect, it } from "vitest";
import { decodeJitRetiredInstructions, decodeJitModuleExit, isJitGuardExit, jitInterpretReason, JIT_CONTEXT_LENGTH } from "../core-abi.js";

function context(): Uint8Array {
  const bytes = new Uint8Array(JIT_CONTEXT_LENGTH);
  bytes.set(new TextEncoder().encode("OXJC"));
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 40, true);
  view.setUint32(8, bytes.byteLength - 12, true);
  view.setBigUint64(208, 0xffff_ffff_ffff_ffffn, true);
  return bytes;
}

describe("committed JIT retirement", () => {
  it("retains the pending virtual interrupt admission reason", () => {
    expect(jitInterpretReason(16)).toBe("pending-virtual-interrupt");
  });
  it("distinguishes the PMU boundary from ordinary guard exits", () => {
    expect(decodeJitModuleExit(5)).toBe("performance-overflow-boundary");
    expect(decodeJitModuleExit(1)).toBe("guard");
    expect(isJitGuardExit(5)).toBe(true);
    expect(isJitGuardExit(1)).toBe(true);
    expect(isJitGuardExit(2)).toBe(false);
    for (const value of [-1, 6, 0.5, NaN, "5", null]) expect(() => decodeJitModuleExit(value)).toThrow();
  });
  it("retains the precise PMU overflow admission reason", () => {
    expect(jitInterpretReason(15)).toBe("performance-overflow-boundary");
  });
  it("retains all 64 bits and reads a nonzero byte offset", () => {
    const source = context();
    const padded = new Uint8Array(source.length + 8);
    padded.set(source, 8);
    expect(decodeJitRetiredInstructions(padded.subarray(8))).toBe(0xffff_ffff_ffff_ffffn);
  });
  it("rejects the previous context even when its retirement prefix is readable", () => {
    const old = context().slice(0, 5_725_528);
    const view = new DataView(old.buffer);
    view.setUint16(4, 38, true);
    view.setUint32(8, old.length - 12, true);
    expect(() => decodeJitRetiredInstructions(old)).toThrow();
  });
  it("rejects incomplete, stale or malformed context records", () => {
    expect(() => decodeJitRetiredInstructions(context().subarray(1))).toThrow();
    for (const offset of [0, 4, 6, 8]) {
      const bytes = context();
      bytes[offset] = 0xff;
      expect(() => decodeJitRetiredInstructions(bytes)).toThrow();
    }
  });
});
