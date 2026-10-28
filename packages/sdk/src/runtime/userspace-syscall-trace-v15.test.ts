import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.js";

function bufferStep(provide = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 624), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 15, true); view.setUint32(8, 624, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  bytes[offset + 120] = provide ? 0 : 2; bytes[offset + 121] = 14; bytes[offset + 123] = 1;
  bytes.set(new TextEncoder().encode("io_uring_enter"), offset + 152);
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 1, true);
  bytes[offset + 232] = provide ? 31 : 32;
  bytes[offset + 233] = provide ? 1 : 0; bytes[offset + 234] = provide ? 2 : 4;
  view.setBigUint64(offset + 240, 19n, true);
  bytes[offset + 584] = provide ? 1 : 2; view.setUint16(offset + 586, 65535, true);
  view.setUint32(offset + 588, provide ? 2 : 65536, true);
  view.setUint32(offset + 592, provide ? 2 : 16384, true);
  if (provide) {
    view.setUint32(offset + 596, 16, true); view.setBigUint64(offset + 600, 0x1234n, true);
    view.setUint16(offset + 608, 65534, true);
  }
  view.setBigUint64(offset + 616, 41n, true);
  return bytes;
}

describe("Userspace trace v15 classic buffer operations", () => {
  it("retains copied provide bounds and the stable ring description identity", () => {
    expect(decodeUserspaceSyscallTrace(bufferStep(true))).toMatchObject({ version: 15, events: [{
      kind: "io-uring-work", work: { completion: "published", done: true, buffers: {
        kind: "provide", ring: 41n, group: 65535, count: 2, provided: 2, address: 0x1234n, length: 16, first: 65534,
      } },
    }] });
  });

  it("retains a committed removal prefix while the worker remains runnable", () => {
    expect(decodeUserspaceSyscallTrace(bufferStep())).toMatchObject({ events: [{
      outcome: { kind: "blocked" }, work: { completion: "executing", done: false, buffers: {
        kind: "remove", ring: 41n, group: 65535, requested: 65536, removed: 16384,
      } },
    }] });
    const bytes = bufferStep(), view = new DataView(bytes.buffer);
    bytes[24 + 120] = 0; bytes[24 + 233] = 1; bytes[24 + 234] = 2;
    view.setBigInt64(24 + 112, 16384n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      outcome: { kind: "result", value: 16384n }, work: { completion: "published" },
    });
  });

  it("rejects absent, conflicting, reserved and inconsistent buffer state", () => {
    for (const [field, value] of [[584, 0], [584, 3], [585, 1], [591, 2],
      [595, 2], [596, 1], [600, 1], [608, 1], [610, 1], [615, 1], [616, 0],
      [232, 31], [233, 1], [234, 3], [120, 0], [123, 0]] as const) {
      const bytes = bufferStep(); bytes[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const [field, value] of [[588, 0], [588, 65537], [592, 0], [592, 65536], [592, 65537]] as const) {
      const bytes = bufferStep(); new DataView(bytes.buffer).setUint32(24 + field, value, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const [field, value] of [[596, 0], [608, 65535], [592, 0], [592, 3]] as const) {
      const bytes = bufferStep(true), view = new DataView(bytes.buffer);
      view.setUint32(24 + field, value, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const bytes = bufferStep(true);
    new DataView(bytes.buffer).setBigUint64(24 + 600, (1n << 47n) - 1n, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });
});
