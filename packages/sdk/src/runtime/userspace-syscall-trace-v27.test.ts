import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function record(): Uint8Array {
  const bytes = new Uint8Array(24 + 832), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 27, true); view.setUint32(8, 832, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x401000n, true); view.setBigUint64(offset + 48, 0x401002n, true);
  view.setBigUint64(offset + 56, 426n, true); view.setBigInt64(offset + 112, 4n, true);
  view.setUint8(offset + 123, 1);
  for (const field of [192, 200, 208, 240]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 216, 1, true); view.setUint8(offset + 232, 4); view.setUint8(offset + 234, 8);
  view.setUint8(offset + 784, 1); view.setUint8(offset + 785, 3);
  view.setUint8(offset + 786, 2); view.setUint8(offset + 787, 1);
  view.setUint16(offset + 788, 7, true); view.setBigUint64(offset + 792, 11n, true);
  view.setBigUint64(offset + 800, 31n, true); view.setBigUint64(offset + 808, 257n, true);
  view.setBigUint64(offset + 816, 3n, true); view.setBigUint64(offset + 824, 77n, true);
  return bytes;
}

describe("syscall trace v27 bounded registered-resource retirement", () => {
  it("retains the original I/O completion and exact pre-step resource cursor", () => {
    expect(decodeUserspaceSyscallTrace(record()).events[0]).toMatchObject({
      kind: "io-uring-work", outcome: { kind: "result", value: 4n }, work: {
        completion: "retiring", done: false, retirement: {
          completion: "published", phase: "unpin", ringObjectId: 11n,
          resource: { origin: 31n, index: 7 }, pinsBefore: 257n, metadataReferencesBefore: 3n, tag: 77n,
        },
      },
    });
  });
  it.each([0, 1, 2])("preserves original CQ visibility %s without republishing the I/O CQE", completion => {
    const bytes = record(); bytes[24 + 786] = completion;
    const shifted = new Uint8Array(bytes.length + 13); shifted.set(bytes, 7);
    expect(decodeUserspaceSyscallTrace(shifted.subarray(7, 7 + bytes.length)).events[0]).toMatchObject({
      work: { completion: "retiring", retirement: { completion: completion === 0 ? "skipped" : completion === 1 ? "pending" : "published" } },
    });
  });
  it("represents owner completion without inventing a buffer identity", () => {
    const bytes = record(), view = new DataView(bytes.buffer), offset = 24;
    view.setUint8(offset + 233, 1); view.setUint8(offset + 785, 8); bytes.fill(0, offset + 787, offset + 792);
    bytes.fill(0, offset + 800, offset + 832);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      work: { completion: "retiring", done: true, retirement: { phase: "finished", pinsBefore: 0n } },
    });
  });
  it("rejects unknown states, missing identity, impossible cursors and nonzero reserved bytes", () => {
    const changes: readonly ((view: DataView) => void)[] = [
      view => view.setUint16(4, 26, true), view => view.setUint8(24 + 234, 9),
      view => view.setUint8(24 + 784, 0), view => view.setUint8(24 + 784, 2),
      view => view.setUint8(24 + 785, 0), view => view.setUint8(24 + 785, 10),
      view => view.setUint8(24 + 786, 3), view => view.setUint8(24 + 787, 2),
      view => view.setUint16(24 + 788, 16384, true), view => view.setUint16(24 + 790, 1, true),
      view => view.setBigUint64(24 + 792, 0n, true), view => view.setBigUint64(24 + 800, 0n, true),
      view => view.setBigUint64(24 + 808, 0n, true), view => view.setUint8(24 + 120, 2),
      view => view.setUint8(24 + 123, 0), view => view.setUint8(24 + 234, 2),
      ...[1, 2, 22, 23].map(opcode => (view: DataView): void => view.setUint8(24 + 232, opcode)),
    ];
    for (const change of changes) {
      const bytes = record(); change(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
