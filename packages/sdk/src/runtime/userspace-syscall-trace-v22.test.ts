import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.js";

function signaledReadiness(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 752), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 22, true); view.setUint32(8, 752, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 2, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  bytes[offset + 120] = 2; bytes[offset + 121] = 14; bytes[offset + 123] = 1;
  bytes.set(new TextEncoder().encode("io_uring_enter"), offset + 152);
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 2, true);
  bytes[offset + 232] = 22; bytes[offset + 234] = 6;
  view.setBigUint64(offset + 240, 19n, true);
  bytes[offset + 512] = 2;
  view.setBigUint64(offset + 520, 71n, true); view.setUint32(offset + 528, 2, true);
  bytes[offset + 624] = 4; bytes[offset + 625] = 9;
  view.setUint32(offset + 632, 2, true); view.setUint32(offset + 636, 2, true);
  view.setBigUint64(offset + 640, 50n, true);
  view.setBigUint64(offset + 704, 0x2000n, true);
  view.setBigUint64(offset + 720, 1n, true);
  return bytes;
}

describe("Userspace trace v22 signal-driven issuer exit", () => {
  it("retains the accepted signal and guest boundary without fabricating a syscall", () => {
    expect(decodeUserspaceSyscallTrace(signaledReadiness())).toMatchObject({ version: 22, events: [{
      pid: 2, tid: 2, number: 426n, work: { completion: "task-run-reissue", executor: {
        kind: "exited-signal", source: { pid: 2, tid: 2, signal: 9, guestTicks: 50n, instructionRip: 0x2000n, addressSpace: 1n },
      } },
    }] });
    const bytes = signaledReadiness(), offset = 24;
    bytes.fill(0, offset + 512, offset + 552);
    bytes[offset + 120] = 4; bytes[offset + 233] = 1; bytes[offset + 234] = 7;
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      outcome: { kind: "released" }, work: { completion: "released", executor: { kind: "exited-signal" } },
    });
  });

  it("rejects invalid signals, invented syscall fields, foreign issuers and older versions", () => {
    for (const [field, value] of [[625, 0], [625, 65], [626, 1], [632, 1], [636, 0], [640, 52], [648, 60], [656, 1], [712, 1], [720, 0], [728, 1], [28, 3], [216, 3]] as const) {
      const invalid = signaledReadiness(); invalid[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(invalid)).toThrow();
    }
    const legacy = signaledReadiness(); new DataView(legacy.buffer).setUint16(4, 21, true);
    expect(() => decodeUserspaceSyscallTrace(legacy)).toThrow();
  });
});

