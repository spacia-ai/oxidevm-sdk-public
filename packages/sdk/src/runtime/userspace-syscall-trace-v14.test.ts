import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.js";

function populationStep(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 584), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 14, true); view.setUint32(8, 584, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  bytes[offset + 120] = 2; bytes[offset + 121] = 14; bytes[offset + 123] = 1;
  bytes.set(new TextEncoder().encode("io_uring_enter"), offset + 152);
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 1, true);
  bytes[offset + 232] = 25; bytes[offset + 234] = 4;
  view.setBigUint64(offset + 240, 19n, true);
  bytes[offset + 272] = 3; view.setUint32(offset + 276, 0x7fff_0000, true);
  view.setBigUint64(offset + 280, 17n, true);
  bytes[offset + 552] = 1; view.setUint32(offset + 556, 23, true);
  view.setBigUint64(offset + 560, 0x8000n, true);
  view.setBigUint64(offset + 568, 0xc000n, true);
  view.setBigUint64(offset + 576, 0x9000n, true);
  return bytes;
}

describe("Userspace trace v14 memory advice progress", () => {
  it("retains the copied range and last committed page while the request remains runnable", () => {
    expect(decodeUserspaceSyscallTrace(populationStep())).toMatchObject({ version: 14, events: [{
      kind: "io-uring-work", outcome: { kind: "blocked" }, work: {
        completion: "executing", done: false, memoryAdvice: {
          advice: 23, start: 0x8000n, end: 0xc000n, next: 0x9000n, sawHole: false,
        },
      },
    }] });
  });

  it("rejects malformed progress, unknown tags and contradictory work states", () => {
    for (const [field, value] of [[552, 0], [552, 2], [553, 2], [554, 1], [556, 24],
      [560, 1], [568, 1], [576, 1], [233, 1], [234, 5], [232, 0], [120, 0], [123, 0]] as const) {
      const bytes = populationStep(); bytes[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const next of [0x8000n, 0xc000n, 0xd000n]) {
      const bytes = populationStep(); new DataView(bytes.buffer).setBigUint64(24 + 576, next, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("retains the completed boundary without inventing a readiness or storage wait", () => {
    const bytes = populationStep(), view = new DataView(bytes.buffer);
    bytes[24 + 120] = 0; bytes[24 + 234] = 2; bytes[24 + 233] = 1;
    view.setBigUint64(24 + 576, 0xc000n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      outcome: { kind: "result", value: 0n }, work: { completion: "published", done: true,
        memoryAdvice: { next: 0xc000n },
      },
    });
    bytes[24 + 553] = 1;
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });
});
