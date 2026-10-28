import { describe, expect, it } from "vitest";
import { decodeOwnedResponseBytes } from "./decoders.js";

describe("owned worker response bytes", () => {
  it.each([0, 3])("reuses a full fixed buffer of length %i", length => {
    const source = new Uint8Array(length);
    const result = decodeOwnedResponseBytes(source);
    expect(result).not.toBe(source);
    expect(result.buffer).toBe(source.buffer);
  });

  it.each(["partial", "resizable", "shared"] as const)("snapshots %s response storage", kind => {
    const source = kind === "partial" ? new Uint8Array(5).subarray(1, 4)
      : kind === "resizable" ? new Uint8Array(new ArrayBuffer(3, { maxByteLength: 6 }))
      : new Uint8Array(new SharedArrayBuffer(3));
    source.set([1, 2, 3]);
    const result = decodeOwnedResponseBytes(source);
    expect(result).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.buffer).not.toBe(source.buffer);
    expect(result.buffer.byteLength).toBe(3);
    expect(result.buffer.resizable).toBe(false);
    source.fill(9);
    expect(result).toEqual(new Uint8Array([1, 2, 3]));
  });

  it.each([null, [], new ArrayBuffer(3), new Uint16Array(3), new DataView(new ArrayBuffer(3))])("rejects non-byte response %s", value => {
    expect(() => decodeOwnedResponseBytes(value)).toThrow("worker response must be bytes");
  });

  it("rejects a detached buffer even though its length is zero", () => {
    const source = new Uint8Array(3);
    structuredClone(source, { transfer: [source.buffer] });
    expect(() => decodeOwnedResponseBytes(source)).toThrow();
  });
});
