import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.js";

function cancelledTrace(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 512), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 12, true); view.setUint32(8, 512, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true); view.setBigInt64(offset + 112, -125n, true);
  bytes[offset + 121] = 14; bytes[offset + 123] = 1;
  bytes.set(new TextEncoder().encode("io_uring_enter"), offset + 152);
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 1, true);
  view.setUint32(offset + 224, 0xffff_fffe, true); view.setUint32(offset + 228, 1, true);
  bytes[offset + 232] = 22; bytes[offset + 233] = 1; bytes[offset + 234] = 2;
  view.setBigUint64(offset + 240, 19n, true);
  bytes[offset + 288] = 1;
  view.setUint32(offset + 296, 1, true); view.setUint32(offset + 300, 1, true);
  view.setBigUint64(offset + 304, 50n, true); view.setBigUint64(offset + 312, 426n, true);
  view.setBigUint64(offset + 320, 3n, true); view.setBigUint64(offset + 328, 1n, true);
  view.setBigUint64(offset + 368, 0x2000n, true); view.setBigUint64(offset + 376, 0x2002n, true);
  view.setBigUint64(offset + 384, 1n, true);
  view.setUint32(offset + 408, 1, true); view.setUint32(offset + 412, 1, true);
  view.setBigUint64(offset + 416, 19n, true);
  bytes[offset + 432] = 14; view.setInt32(offset + 436, -1, true);
  view.setBigUint64(offset + 448, 73n, true); view.setBigUint64(offset + 464, 74n, true);
  return bytes;
}

describe("Userspace trace v12 cancellation provenance", () => {
  it("retains an inline control's original syscall and copied SQE on the canceled target", () => {
    expect(decodeUserspaceSyscallTrace(cancelledTrace())).toMatchObject({ version: 12, events: [{
      kind: "io-uring-work", outcome: { kind: "result", value: -125n }, work: {
        completion: "published", canceledBy: {
          source: { pid: 1, tid: 1, guestTicks: 50n, addressSpace: 1n, number: 426n,
            arguments: [3n, 1n, 0n, 0n, 0n, 0n], instructionRip: 0x2000n, nextRip: 0x2002n },
          execution: { kind: "inline" }, sqSequence: 1, sqeIndex: 1, credentialId: 19n,
        },
      },
    }] });
  });

  it("rejects malformed causes, contradictory outcomes and nonzero reserved bytes", () => {
    for (const [offset, value] of [[288, 2], [289, 1], [296, 0], [300, 0], [312, 0],
      [376, 0x20], [384, 0], [392, 1], [416, 0], [432, 0], [434, 1], [460, 64], [496, 1],
      [120, 2], [112, 0]] as const) {
      const bytes = cancelledTrace(); bytes[24 + offset] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow("malformed");
    }
    const bytes = cancelledTrace(); bytes[24 + 288] = 0;
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow("malformed");
  });

  it("retains worker execution identity and the resolved description used by an FD query", () => {
    const bytes = cancelledTrace(), view = new DataView(bytes.buffer), offset = 24;
    view.setBigUint64(offset + 392, 7n, true); view.setBigUint64(offset + 400, 10n, true);
    view.setBigUint64(offset + 424, 23n, true);
    bytes[offset + 433] = 16;
    view.setInt32(offset + 436, 3, true); view.setUint32(offset + 460, 2, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({ kind: "io-uring-work", work: {
      canceledBy: { execution: { kind: "worker", poolId: 7n, sequence: 10n }, openFileId: 23n },
    } });
    view.setBigUint64(offset + 424, 0n, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow("malformed");
  });
});
