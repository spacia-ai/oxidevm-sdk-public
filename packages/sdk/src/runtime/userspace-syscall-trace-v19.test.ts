import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.js";

function reissue(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 752);
  const view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 19, true); view.setUint32(8, 752, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  bytes[offset + 120] = 2; bytes[offset + 121] = 14; bytes[offset + 123] = 1;
  bytes.set(new TextEncoder().encode("io_uring_enter"), offset + 152);
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 1, true);
  bytes[offset + 232] = 22; bytes[offset + 234] = 6;
  view.setBigUint64(offset + 240, 19n, true);
  bytes[offset + 512] = 2;
  view.setBigUint64(offset + 520, 71n, true); view.setUint32(offset + 528, 1, true);
  return bytes;
}

describe("Userspace trace v19 issuer-owned readiness reissue", () => {
  it("retains the issuer and collecting syscall when a ready retry must wait again", () => {
    const bytes = reissue(), view = new DataView(bytes.buffer), offset = 24;
    bytes.fill(0, offset + 512, offset + 552);
    bytes[offset + 234] = 3; bytes[offset + 624] = 1;
    view.setUint32(offset + 28, 1, true);
    view.setBigUint64(offset + 248, 91n, true); view.setUint32(offset + 256, 1, true);
    view.setUint32(offset + 632, 1, true); view.setUint32(offset + 636, 1, true);
    view.setBigUint64(offset + 640, 50n, true); view.setBigUint64(offset + 648, 426n, true);
    view.setBigUint64(offset + 656, 5n, true); view.setBigUint64(offset + 680, 1n, true);
    view.setBigUint64(offset + 704, 0x2000n, true); view.setBigUint64(offset + 712, 0x2002n, true);
    view.setBigUint64(offset + 720, 1n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      tid: 1, outcome: { kind: "blocked" }, work: {
        completion: "waiting", done: false, wait: { kind: "readiness", openFileId: 91n, events: 1 },
        executor: { kind: "task-run", source: { tid: 1, number: 426n, instructionRip: 0x2000n } },
      },
    });
    const old = bytes.slice(); new DataView(old.buffer).setUint16(4, 18, true);
    expect(() => decodeUserspaceSyscallTrace(old)).toThrow();
    const invalid = bytes.slice(); invalid[offset + 232] = 0;
    expect(() => decodeUserspaceSyscallTrace(invalid)).toThrow();
  });

  it("distinguishes an unexecuted ready retry from an already completed deferred result", () => {
    expect(decodeUserspaceSyscallTrace(reissue())).toMatchObject({ version: 19, events: [{
      kind: "io-uring-work", outcome: { kind: "blocked" }, work: {
        completion: "task-run-reissue", done: false, executor: { kind: "worker" },
        wait: { kind: "task-run", ringOpenFileId: 71n, issuerTid: 1 },
      },
    }] });
  });

  it("rejects an earlier trace version, result, finished retry, foreign issuer or missing wait", () => {
    for (const [field, value] of [[120, 0], [233, 1], [512, 0], [528, 2], [232, 0], [624, 1]] as const) {
      const bytes = reissue(); bytes[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const old = reissue(); new DataView(old.buffer).setUint16(4, 18, true);
    expect(() => decodeUserspaceSyscallTrace(old)).toThrow();
  });

  it("retains selected-buffer ownership while the ready read still awaits execution", () => {
    const bytes = reissue(), view = new DataView(bytes.buffer), offset = 24;
    bytes[offset + 584] = 3;
    view.setUint16(offset + 586, 7, true); view.setUint32(offset + 588, 4, true);
    view.setUint32(offset + 592, 4, true); view.setUint32(offset + 596, 8, true);
    view.setBigUint64(offset + 600, 0x4000n, true); view.setUint16(offset + 608, 3, true);
    view.setBigUint64(offset + 616, 71n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({ outcome: { kind: "blocked" }, work: {
      completion: "task-run-reissue", buffers: { kind: "select", ring: 71n, group: 7, id: 3, count: 4 },
    } });
    bytes[offset + 584] = 4; bytes[offset + 232] = 1;
    view.setBigUint64(offset + 588, 0xffff_ffff_ffff_ffffn, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({ work: {
      completion: "task-run-reissue", buffers: { kind: "select-vector", requested: 0xffff_ffff_ffff_ffffn, count: 8 },
    } });
  });
});
