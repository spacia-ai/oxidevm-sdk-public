import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.js";

function exitedReadiness(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 752), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 21, true); view.setUint32(8, 752, true); view.setUint32(12, 1, true);
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
  bytes[offset + 624] = 3;
  view.setUint32(offset + 632, 2, true); view.setUint32(offset + 636, 2, true);
  view.setBigUint64(offset + 640, 50n, true); view.setBigUint64(offset + 648, 60n, true);
  view.setBigUint64(offset + 704, 0x2000n, true); view.setBigUint64(offset + 712, 0x2002n, true);
  view.setBigUint64(offset + 720, 1n, true);
  return bytes;
}

describe("Userspace trace v21 exited issuer readiness", () => {
  it("distinguishes final capability release from an I/O result or completion publication", () => {
    const bytes = exitedReadiness(), offset = 24;
    bytes.fill(0, offset + 512, offset + 552);
    bytes[offset + 120] = 4; bytes[offset + 233] = 1; bytes[offset + 234] = 7;
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      outcome: { kind: "released" }, work: { completion: "released", done: true, executor: { kind: "exited" } },
    });
    for (const [field, value] of [[112, 1], [120, 0], [233, 0], [234, 6], [512, 2], [584, 1]] as const) {
      const invalid = bytes.slice(); invalid[offset + field] = value;
      expect(() => decodeUserspaceSyscallTrace(invalid)).toThrow();
    }
    const worker = bytes.slice(); worker.fill(0, offset + 624, offset + 752);
    expect(() => decodeUserspaceSyscallTrace(worker)).toThrow();
    const legacy = bytes.slice(); new DataView(legacy.buffer).setUint16(4, 20, true);
    expect(() => decodeUserspaceSyscallTrace(legacy)).toThrow();
  });

  it("retains the dead issuer, original submission and actual exit without reporting a worker", () => {
    expect(decodeUserspaceSyscallTrace(exitedReadiness())).toMatchObject({ version: 21, events: [{
      pid: 2, tid: 2, number: 426n, outcome: { kind: "blocked" }, work: {
        creatorTid: 2, completion: "task-run-reissue", done: false,
        executor: { kind: "exited", source: { pid: 2, tid: 2, number: 60n, guestTicks: 50n, instructionRip: 0x2000n } },
      },
    }] });
    const bytes = exitedReadiness(), view = new DataView(bytes.buffer);
    view.setBigUint64(24 + 648, 231n, true); view.setUint32(24 + 636, 3, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({ work: {
      creatorTid: 2, executor: { kind: "exited", source: { tid: 3, number: 231n } },
    } });
  });

  it("rejects forged issuers, exits, timestamps, phases and earlier wire versions", () => {
    for (const [field, value] of [[24, 1], [28, 3], [216, 3], [636, 3], [632, 1], [640, 52], [648, 426], [233, 1], [234, 5], [120, 0], [624, 4], [625, 1], [728, 1]] as const) {
      const bytes = exitedReadiness(); new DataView(bytes.buffer).setUint32(24 + field, value, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const old = exitedReadiness(); new DataView(old.buffer).setUint16(4, 20, true);
    expect(() => decodeUserspaceSyscallTrace(old)).toThrow();
    const syscall = exitedReadiness(); syscall[24 + 123] = 0;
    expect(() => decodeUserspaceSyscallTrace(syscall)).toThrow();
  });
});
