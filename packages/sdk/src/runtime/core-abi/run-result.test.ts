import { describe, expect, it } from "vitest";
import { decodeRunResult } from "../core-abi.ts";

function result(version: number, kind: number, detail: number) {
  const bytes = new Uint8Array(48);
  bytes.set([0x4f, 0x58, 0x52, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, version, true);
  view.setUint32(8, 36, true);
  bytes[12] = 5;
  view.setBigUint64(16, 1n, true);
  bytes[24] = kind;
  bytes[25] = detail;
  return bytes;
}

describe("precise core internal failure identity", () => {
  it("retains every entropy replay failure reason", () => {
    const reasons = ["input-too-large", "invalid-request", "invalid-sequence", "replay-mismatch", "replay-exhausted", "sequence-exhausted"];
    reasons.forEach((reason, index) => {
      expect(decodeRunResult(result(2, 5, index + 1))).toEqual({ kind: "internal-failure", steps: 1n, failure: { kind: "entropy-replay", reason } });
    });
  });

  it("retains the four architectural adapter failure families", () => {
    const kinds = ["unsupported-semantic", "unsupported-profile", "unsupported-system-management-interrupt", "unexpected-adapter-exit"];
    kinds.forEach((kind, index) => {
      expect(decodeRunResult(result(2, index + 1, 0))).toEqual({ kind: "internal-failure", steps: 1n, failure: { kind } });
    });
  });

  it("rejects unknown codes, mismatched detail and reserved bytes", () => {
    for (const bytes of [result(2, 0, 0), result(2, 6, 0), result(2, 1, 1), result(2, 5, 0), result(2, 5, 7), result(3, 1, 0)]) {
      expect(() => decodeRunResult(bytes)).toThrow();
    }
    const reserved = result(2, 5, 4);
    reserved[26] = 1;
    expect(() => decodeRunResult(reserved)).toThrow();
  });

  it("keeps historical records explicit about their absent failure identity", () => {
    expect(decodeRunResult(result(1, 0, 0))).toEqual({ kind: "internal-failure", steps: 1n });
    expect(() => decodeRunResult(result(1, 1, 0))).toThrow();
  });
});
