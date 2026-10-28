import { describe, expect, it } from "vitest";
import { decodeUserspaceRunResult } from "./userspace-abi.ts";

function result(tag: number): Uint8Array {
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXLR"));
  view.setUint16(4, 2, true); view.setUint32(8, 4, true); view.setUint8(12, tag);
  return bytes;
}

describe("Userspace execution completion", () => {
  it("distinguishes a bounded kernel yield from a blocked or exited runtime", () => {
    for (const [status, tag, kind] of [[3, 0, "exit"], [4, 3, "blocked"], [5, 1, "step-limit"]] as const) {
      expect(decodeUserspaceRunResult(result(tag), status).kind).toBe(kind);
      for (const wrong of [0, 1, 2, 3].filter(value => value !== tag)) {
        expect(() => decodeUserspaceRunResult(result(wrong), status)).toThrow();
      }
    }
  });

  it("rejects ready, error and unknown completion statuses at the result boundary", () => {
    for (const status of [0, 1, 2, 6, -1, 0xffff_ffff]) {
      expect(() => decodeUserspaceRunResult(result(1), status)).toThrow();
    }
  });
});
