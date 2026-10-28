import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.js";

function completedTaskWork(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 752), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 18, true); view.setUint32(8, 752, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  bytes[offset + 121] = 14; bytes[offset + 123] = 1;
  bytes.set(new TextEncoder().encode("io_uring_enter"), offset + 152);
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 1, true);
  bytes[offset + 234] = 5;
  view.setBigUint64(offset + 240, 19n, true);
  bytes[offset + 512] = 2;
  view.setBigUint64(offset + 520, 71n, true); view.setUint32(offset + 528, 1, true);
  return bytes;
}

describe("Userspace trace v18 completed deferred work", () => {
  it("retains the actual result and issuer wait without describing the I/O as unexecuted", () => {
    expect(decodeUserspaceSyscallTrace(completedTaskWork())).toMatchObject({ version: 18, events: [{
      kind: "io-uring-work", outcome: { kind: "result", value: 0n }, work: {
        poolId: 7n, sequence: 9n, completion: "task-run", done: false,
        wait: { kind: "task-run", ringOpenFileId: 71n, issuerTid: 1 },
      },
    }] });
  });

  it("rejects missing identities, reserved payload, other work phases and unversioned tags", () => {
    for (const [field, value] of [[512, 0], [512, 3], [513, 1], [519, 1], [520, 0],
      [528, 0], [528, 2], [532, 1], [551, 1], [248, 1], [233, 1], [234, 3], [234, 2], [120, 2], [123, 0], [624, 1]] as const) {
      const bytes = completedTaskWork(); bytes[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const old = completedTaskWork(); new DataView(old.buffer).setUint16(4, 17, true);
    expect(() => decodeUserspaceSyscallTrace(old)).toThrow();
  });

  it("retains a completed selected-buffer read and rejects a different ring identity", () => {
    const bytes = completedTaskWork(), view = new DataView(bytes.buffer), offset = 24;
    bytes[offset + 232] = 22; bytes[offset + 584] = 3;
    view.setBigInt64(offset + 112, 4n, true);
    view.setUint16(offset + 586, 7, true); view.setUint32(offset + 588, 4, true);
    view.setUint32(offset + 592, 4, true); view.setUint32(offset + 596, 8, true);
    view.setBigUint64(offset + 600, 0x4000n, true); view.setUint16(offset + 608, 3, true);
    view.setBigUint64(offset + 616, 71n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      outcome: { kind: "result", value: 4n }, work: {
        completion: "task-run", wait: { kind: "task-run", ringOpenFileId: 71n, issuerTid: 1 },
        buffers: { kind: "select", ring: 71n, group: 7, id: 3, count: 4 },
      },
    });
    view.setBigUint64(offset + 616, 72n, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });

  it("identifies publication under the issuer and the actual collecting syscall", () => {
    const bytes = completedTaskWork(), view = new DataView(bytes.buffer), offset = 24;
    bytes.fill(0, offset + 512, offset + 552);
    bytes[offset + 233] = 1; bytes[offset + 234] = 2; bytes[offset + 624] = 1;
    view.setUint32(offset + 28, 1, true);
    view.setUint32(offset + 632, 1, true); view.setUint32(offset + 636, 1, true);
    view.setBigUint64(offset + 640, 50n, true); view.setBigUint64(offset + 648, 426n, true);
    view.setBigUint64(offset + 656, 5n, true); view.setBigUint64(offset + 680, 1n, true);
    view.setBigUint64(offset + 704, 0x2000n, true); view.setBigUint64(offset + 712, 0x2002n, true);
    view.setBigUint64(offset + 720, 1n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      tid: 1, instructionRip: 0x1000n, work: {
        poolId: 7n, sequence: 9n, creatorTid: 1, completion: "published", done: true,
        executor: { kind: "task-run", source: {
          pid: 1, tid: 1, guestTicks: 50n, number: 426n,
          instructionRip: 0x2000n, nextRip: 0x2002n, addressSpace: 1n,
          arguments: [5n, 0n, 0n, 1n, 0n, 0n],
        } },
      },
    });
    for (const field of [632, 636, 640, 648, 680, 704, 712, 720]) {
      const malformed = bytes.slice(); malformed.fill(0, offset + field, offset + field + (field < 640 ? 4 : 8));
      expect(() => decodeUserspaceSyscallTrace(malformed)).toThrow();
    }
  });

  it("retains a bounded GETEVENTS kernel continuation without inventing another guest instruction", () => {
    const bytes = completedTaskWork(), view = new DataView(bytes.buffer), offset = 24;
    bytes.fill(0, offset + 192, offset + 752);
    bytes[offset + 123] = 0; bytes[offset + 120] = 2; bytes[offset + 122] = 8;
    view.setBigUint64(offset + 88, 1n, true);
    view.setBigUint64(offset + 128, 71n, true); view.setBigUint64(offset + 136, 300n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      kind: "syscall", instructionRip: 0x1000n, nextRip: 0x1002n,
      outcome: { kind: "blocked" },
      wait: { kind: "io-uring-task-run", ringOpenFileId: 71n, pendingRequests: 300 },
    });
    for (const field of [88, 128, 136]) {
      const bad = bytes.slice(); bad.fill(0, offset + field, offset + field + 8);
      expect(() => decodeUserspaceSyscallTrace(bad)).toThrow();
    }
  });
});
