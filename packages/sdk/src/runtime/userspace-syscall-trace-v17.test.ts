import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.js";

function selectedStep(waiting = false, requested = 0xffff_ffff_ffff_ffffn): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 624), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 17, true); view.setUint32(8, 624, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  view.setBigInt64(offset + 112, waiting ? 0n : 4n, true);
  bytes[offset + 120] = waiting ? 2 : 0; bytes[offset + 121] = 14; bytes[offset + 123] = 1;
  bytes.set(new TextEncoder().encode("io_uring_enter"), offset + 152);
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 1, true);
  bytes[offset + 232] = 1; bytes[offset + 233] = waiting ? 0 : 1; bytes[offset + 234] = waiting ? 3 : 2;
  view.setBigUint64(offset + 240, 19n, true);
  if (waiting) {
    view.setBigUint64(offset + 248, 17n, true); view.setUint32(offset + 256, 1, true);
    view.setBigUint64(offset + 264, 10n, true);
  }
  bytes[offset + 584] = 4; view.setUint16(offset + 586, 2, true);
  view.setBigUint64(offset + 588, requested, true);
  view.setUint32(offset + 596, 4, true); view.setBigUint64(offset + 600, 0x1234n, true);
  view.setUint16(offset + 608, 65535, true); view.setBigUint64(offset + 616, 41n, true);
  return bytes;
}

describe("Userspace trace v17 selected READV buffers", () => {
  it("retains full unsigned vector length while deriving the bounded selected count", () => {
    expect(decodeUserspaceSyscallTrace(selectedStep())).toMatchObject({ version: 17, events: [{
      work: { opcode: 1, buffers: { kind: "select-vector", ring: 41n, group: 2,
        requested: 0xffff_ffff_ffff_ffffn, count: 4, length: 4, id: 65535, address: 0x1234n } },
    }] });
  });
  it("keeps zero-length whole-buffer selection distinct from a one-byte request", () => {
    expect(decodeUserspaceSyscallTrace(selectedStep(false, 0n)).events[0]).toMatchObject({
      work: { buffers: { requested: 0n, count: 4 } },
    });
    const bytes = selectedStep(false, 1n); new DataView(bytes.buffer).setBigInt64(24 + 112, 1n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({ work: { buffers: { requested: 1n, count: 1 } } });
  });
  it("retains vector selection alongside the original stream's readiness wait", () => {
    expect(decodeUserspaceSyscallTrace(selectedStep(true))).toMatchObject({ events: [{
      outcome: { kind: "blocked" }, work: { completion: "waiting", buffers: { kind: "select-vector" },
        wait: { kind: "readiness", openFileId: 17n, events: 1, wakeups: 10n } },
    }] });
  });
  it("rejects old meanings, wrong opcodes, reserved bytes and oversized results", () => {
    for (const version of [16, 18]) {
      const bytes = selectedStep(); new DataView(bytes.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const [field, value] of [[232, 22], [585, 1], [610, 1], [616, 0]] as const) {
      const bytes = selectedStep(); bytes[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const bytes = selectedStep(); new DataView(bytes.buffer).setBigInt64(24 + 112, 5n, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });
});
