import { describe, expect, it } from "vitest";

import { CoreAbiError } from "../core-abi.js";
import { decodeAotIndex } from "./aot-index.js";

function fixture(): Uint8Array {
  const sourceOffset = 64;
  const packOffset = sourceOffset + 40;
  const memberOffset = packOffset + 48;
  const spanOffset = memberOffset + 64;
  const dataOffset = spanOffset + 48;
  const sourceAnchorLength = 64;
  const bytes = new Uint8Array(dataOffset + sourceAnchorLength + 1);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4f, 0x58, 0x41, 0x49]);
  view.setUint16(4, 1, true);
  view.setUint16(6, 64, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint16(12, 1, true);
  view.setUint16(14, 1, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, sourceAnchorLength + 1, true);
  view.setUint32(28, sourceOffset, true);
  view.setUint32(32, packOffset, true);
  view.setUint32(36, memberOffset, true);
  view.setUint32(40, spanOffset, true);
  view.setUint32(44, dataOffset, true);
  bytes.fill(1, sourceOffset, sourceOffset + 32);
  view.setUint32(sourceOffset + 32, 0, true);
  view.setUint16(sourceOffset + 36, sourceAnchorLength, true);
  view.setUint16(sourceOffset + 38, 1, true);
  bytes.set([0x7f, 0x45, 0x4c, 0x46], dataOffset);
  bytes.fill(2, packOffset, packOffset + 32);
  view.setUint16(packOffset + 32, 0, true);
  view.setUint32(packOffset + 36, 0, true);
  view.setUint16(packOffset + 40, 1, true);
  view.setUint32(packOffset + 44, 1024, true);
  view.setUint16(memberOffset, 0, true);
  view.setUint16(memberOffset + 2, 0, true);
  view.setUint16(memberOffset + 4, 0, true);
  view.setUint8(memberOffset + 6, 3);
  view.setUint32(memberOffset + 8, 1, true);
  view.setBigUint64(memberOffset + 12, 0x1234n, true);
  view.setBigUint64(memberOffset + 20, fnv1a64([0x90]), true);
  view.setUint16(memberOffset + 28, 1, true);
  view.setUint16(memberOffset + 30, 1, true);
  view.setBigUint64(memberOffset + 36, 9n, true);
  view.setBigUint64(spanOffset, 0x1234n, true);
  view.setUint32(spanOffset + 8, sourceAnchorLength, true);
  view.setUint16(spanOffset + 12, 1, true);
  view.setUint32(spanOffset + 16, 1, true);
  view.setUint16(spanOffset + 20, 2, true);
  view.setBigUint64(spanOffset + 24, 0x1235n, true);
  view.setBigUint64(spanOffset + 40, 0x3344n, true);
  bytes[dataOffset + sourceAnchorLength] = 0x90;
  return bytes;
}

describe("AOT binary index", () => {
  it("retains versioned CPU capabilities and rejects historical reinterpretation", () => {
    expect(decodeAotIndex(fixture()).members[0]?.capabilityRevision).toBe(0);
    for (const capabilityRevision of [0, 1]) {
      const bytes = fixture();
      const view = new DataView(bytes.buffer);
      view.setUint16(4, 2, true);
      view.setUint8(159, capabilityRevision);
      expect(decodeAotIndex(bytes).members[0]?.capabilityRevision).toBe(capabilityRevision);
    }
    for (const [version, capability] of [[1, 1], [2, 2], [2, 255], [3, 0]]) {
      const bytes = fixture();
      const view = new DataView(bytes.buffer);
      if (version === undefined || capability === undefined) throw new Error("missing fixture");
      view.setUint16(4, version, true);
      view.setUint8(159, capability);
      expect(() => decodeAotIndex(bytes)).toThrow(CoreAbiError);
    }
  });
  it("decodes exact source, pack, member, and span identity", () => {
    const index = decodeAotIndex(fixture());
    expect(index.sources).toEqual(["01".repeat(32)]);
    expect(index.packs).toEqual([{
      sha256: "02".repeat(32),
      sourceIndex: 0,
      phase: "command",
      memberStart: 0,
      memberCount: 1,
      byteLength: 1024,
    }]);
    expect(index.members[0]?.entryOffset).toBe(0x1234n);
    expect(index.members[0]?.spans[0]?.fileOffset).toBe(0x3344n);
    expect(index.members[0]?.spans[0]?.bytes).toEqual(new Uint8Array([0x90]));
  });

  it("rejects reserved, truncated, and fingerprint-corrupt indexes", () => {
    const reserved = fixture();
    reserved[48] = 1;
    expect(() => decodeAotIndex(reserved)).toThrow(CoreAbiError);
    expect(() => decodeAotIndex(fixture().subarray(0, -1))).toThrow(CoreAbiError);
    const corrupt = fixture();
    corrupt[corrupt.byteLength - 1] = 0xcc;
    expect(() => decodeAotIndex(corrupt)).toThrow(/fingerprint/u);
  });
});

function fnv1a64(bytes: readonly number[]): bigint {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x0000_0100_0000_01b3n);
  return hash;
}
