import { describe, expect, it } from "vitest";

import { decodeCorePendingAot } from "./aot.js";

function record(): Uint8Array {
  const bytes = new Uint8Array(144);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4f, 0x58, 0x41, 0x50]);
  view.setUint16(4, 1, true);
  view.setUint16(6, 144, true);
  view.setBigUint64(8, 7n, true);
  view.setBigUint64(16, 11n, true);
  view.setBigUint64(24, 12n, true);
  view.setBigUint64(32, 13n, true);
  view.setBigUint64(40, 0x400000n, true);
  bytes.fill(0xab, 48, 80);
  view.setUint32(80, 4096, true);
  view.setUint16(84, 2, true);
  view.setUint16(86, 3, true);
  view.setBigUint64(88, 0x1234n, true);
  view.setBigUint64(96, 0x401234n, true);
  view.setUint16(104, 1, true);
  view.setBigUint64(112, 0x401000n, true);
  view.setBigUint64(120, 0x201000n, true);
  view.setBigUint64(128, 9n, true);
  return bytes;
}

describe("pending AOT core record", () => {
  it("decodes the exact OXAP identity", () => {
    expect(decodeCorePendingAot(record())).toEqual({
      generation: 7n,
      token: [11n, 12n],
      cacheKey: 13n,
      imageBase: 0x400000n,
      packSha256: "ab".repeat(32),
      packByteLength: 4096,
      packMemberIndex: 2,
      instructionCount: 3,
      memberEntryOffset: 0x1234n,
      startRip: 0x401234n,
      codePages: [{
        linear: 0x401000n,
        physical: 0x201000n,
        generation: 9n,
        globalSupervisor: false,
      }],
    });
  });

  it("rejects truncation, reserved fields, and zero instructions", () => {
    expect(() => decodeCorePendingAot(record().subarray(0, -1))).toThrow(/length/u);
    const reserved = record();
    reserved[106] = 1;
    expect(() => decodeCorePendingAot(reserved)).toThrow(/code pages/u);
    const empty = record();
    new DataView(empty.buffer).setUint16(86, 0, true);
    expect(() => decodeCorePendingAot(empty)).toThrow(/instruction/u);
  });
});
