import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function retirement(signaled = true): Uint8Array {
  const bytes = new Uint8Array(24 + 832), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 28, true); view.setUint32(8, 832, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 2, true); view.setUint32(offset + 28, signaled ? 2 : 3, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true); view.setBigInt64(offset + 112, 4n, true);
  bytes[offset + 123] = 1;
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 2, true);
  bytes[offset + 232] = 4; bytes[offset + 234] = 8;
  view.setBigUint64(offset + 240, 19n, true);
  if (signaled) {
    bytes[offset + 624] = 4; bytes[offset + 625] = 9;
    view.setUint32(offset + 632, 2, true); view.setUint32(offset + 636, 2, true);
    view.setBigUint64(offset + 640, 50n, true); view.setBigUint64(offset + 704, 0x2000n, true);
    view.setBigUint64(offset + 720, 1n, true);
  }
  bytes[offset + 784] = 1; bytes[offset + 785] = 3; bytes[offset + 786] = 2; bytes[offset + 787] = 1;
  view.setBigUint64(offset + 792, 11n, true); view.setBigUint64(offset + 800, 31n, true);
  view.setBigUint64(offset + 808, 257n, true); view.setBigUint64(offset + 816, 3n, true);
  view.setBigUint64(offset + 824, 77n, true);
  return bytes;
}

describe("syscall trace v28 retirement after forced issuer exit", () => {
  it("retains the accepted signal, original issuer and completed I/O result", () => {
    expect(decodeUserspaceSyscallTrace(retirement())).toMatchObject({ version: 28, events: [{
      pid: 2, tid: 2, outcome: { kind: "result", value: 4n }, work: {
        completion: "retiring", creatorTid: 2, executor: { kind: "exited-signal", source: {
          pid: 2, tid: 2, signal: 9, guestTicks: 50n, instructionRip: 0x2000n, addressSpace: 1n,
        } }, retirement: { phase: "unpin", pinsBefore: 257n, tag: 77n },
      },
    }] });
  });
  it("preserves ordinary v27 retirement and accepts the same work in v28", () => {
    const bytes = retirement(false);
    expect(decodeUserspaceSyscallTrace(bytes).version).toBe(28);
    new DataView(bytes.buffer).setUint16(4, 27, true);
    expect(decodeUserspaceSyscallTrace(bytes).version).toBe(27);
  });
  it("rejects exited retirement in v27, foreign issuers and invented signal syscalls", () => {
    for (const change of [
      (view: DataView): void => view.setUint16(4, 27, true),
      (view: DataView): void => view.setUint32(24 + 632, 3, true),
      (view: DataView): void => view.setBigUint64(24 + 648, 60n, true),
    ]) {
      const bytes = retirement(); change(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
