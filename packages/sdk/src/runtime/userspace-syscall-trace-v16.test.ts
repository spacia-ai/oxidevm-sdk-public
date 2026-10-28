import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.js";

function selectedStep(waiting = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 624), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 16, true); view.setUint32(8, 624, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  view.setBigInt64(offset + 112, waiting ? 0n : 4n, true);
  bytes[offset + 120] = waiting ? 2 : 0; bytes[offset + 121] = 14; bytes[offset + 123] = 1;
  bytes.set(new TextEncoder().encode("io_uring_enter"), offset + 152);
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 1, true);
  bytes[offset + 232] = 22; bytes[offset + 233] = waiting ? 0 : 1; bytes[offset + 234] = waiting ? 3 : 2;
  view.setBigUint64(offset + 240, 19n, true);
  if (waiting) {
    view.setBigUint64(offset + 248, 17n, true); view.setUint32(offset + 256, 1, true);
    view.setBigUint64(offset + 264, 10n, true);
  }
  bytes[offset + 584] = 3; view.setUint16(offset + 586, 2, true);
  view.setUint32(offset + 588, 8, true); view.setUint32(offset + 592, 4, true);
  view.setUint32(offset + 596, 4, true); view.setBigUint64(offset + 600, 0x1234n, true);
  view.setUint16(offset + 608, 65535, true); view.setBigUint64(offset + 616, 41n, true);
  return bytes;
}

describe("Userspace trace v16 selected READ buffers", () => {
  it("retains ring, group, buffer ID, address, capacity and effective read length", () => {
    expect(decodeUserspaceSyscallTrace(selectedStep())).toMatchObject({ version: 16, events: [{
      outcome: { kind: "result", value: 4n }, work: { completion: "published", done: true, buffers: {
        kind: "select", ring: 41n, group: 2, id: 65535, requested: 8, count: 4, length: 4, address: 0x1234n,
      } },
    }] });
  });

  it("retains the selected entry while the original stream description waits", () => {
    expect(decodeUserspaceSyscallTrace(selectedStep(true))).toMatchObject({ events: [{
      outcome: { kind: "blocked" }, work: { completion: "waiting", done: false,
        wait: { kind: "readiness", openFileId: 17n, events: 1, wakeups: 10n },
        buffers: { kind: "select", ring: 41n, id: 65535, count: 4 },
      },
    }] });
  });

  it("keeps a consumed NULL entry's identity on its Linux error result", () => {
    const bytes = selectedStep(), view = new DataView(bytes.buffer);
    view.setBigUint64(24 + 600, 0n, true); view.setBigInt64(24 + 112, -105n, true);
    view.setUint32(24 + 588, 0, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      outcome: { kind: "result", value: -105n }, work: { buffers: { kind: "select", address: 0n, requested: 0, count: 4 } },
    });
  });

  it("rejects old meanings, noncanonical ranges, reserved bytes and inconsistent progress", () => {
    for (const [field, value] of [[232, 27], [233, 2], [234, 4], [585, 1], [610, 1], [616, 0]] as const) {
      const bytes = selectedStep(); bytes[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const [field, value] of [[592, 0], [592, 3], [592, 5], [596, 0]] as const) {
      const bytes = selectedStep(); new DataView(bytes.buffer).setUint32(24 + field, value, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const version of [15, 18]) {
      const bytes = selectedStep(); new DataView(bytes.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const bytes = selectedStep(true), view = new DataView(bytes.buffer);
    view.setUint32(24 + 256, 4, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    const outOfRange = selectedStep(); new DataView(outOfRange.buffer).setBigUint64(24 + 600, (1n << 47n) - 1n, true);
    expect(() => decodeUserspaceSyscallTrace(outOfRange)).toThrow();
  });
});
