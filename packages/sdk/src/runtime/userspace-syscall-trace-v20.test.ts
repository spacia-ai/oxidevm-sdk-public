import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.js";

function record(number: bigint, name: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 752), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 20, true); view.setUint32(8, 752, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 1, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, number, true);
  bytes[offset + 121] = name.length; bytes.set(new TextEncoder().encode(name), offset + 152);
  return bytes;
}

function execWork(number: 59n | 322n): Uint8Array<ArrayBuffer> {
  const bytes = record(426n, "io_uring_enter"), view = new DataView(bytes.buffer), offset = 24;
  view.setBigInt64(offset + 112, -125n, true);
  bytes[offset + 123] = 1;
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 3, true);
  bytes[offset + 233] = 1; bytes[offset + 234] = 2; view.setBigUint64(offset + 240, 19n, true);
  bytes[offset + 624] = 2;
  view.setUint32(offset + 632, 1, true); view.setUint32(offset + 636, 1, true);
  view.setBigUint64(offset + 640, 50n, true); view.setBigUint64(offset + 648, number, true);
  view.setBigUint64(offset + 704, 0x2000n, true); view.setBigUint64(offset + 712, 0x2002n, true);
  view.setBigUint64(offset + 720, 1n, true);
  return bytes;
}

describe("Userspace trace v20 exec cleanup", () => {
  it("preserves the v20 wire version in the decoded trace envelope", () => {
    expect(decodeUserspaceSyscallTrace(execWork(59n)).version).toBe(20);
    const legacy = record(426n, "io_uring_enter");
    new DataView(legacy.buffer).setUint16(4, 19, true);
    expect(decodeUserspaceSyscallTrace(legacy).version).toBe(19);
  });

  it("retains original submission, creator and actual execve or execveat cleanup source", () => {
    for (const number of [59n, 322n] as const) {
      expect(decodeUserspaceSyscallTrace(execWork(number)).events[0]).toMatchObject({
        number: 426n, tid: 1, outcome: { kind: "result", value: -125n }, work: {
          creatorTid: 3, completion: "published", done: true,
          executor: { kind: "exec", source: { pid: 1, tid: 1, number, guestTicks: 50n, instructionRip: 0x2000n } },
        },
      });
      const issuer = execWork(number); new DataView(issuer.buffer).setUint32(24 + 216, 1, true);
      expect(() => decodeUserspaceSyscallTrace(issuer)).not.toThrow();
    }
  });

  it("rejects foreign callers, impossible source time, wrong syscall, waits and older versions", () => {
    for (const [field, value] of [[632, 2], [636, 2], [640, 52], [648, 426], [720, 0], [624, 3], [625, 1], [728, 1], [234, 3], [234, 5]] as const) {
      const bytes = execWork(59n);
      if (field === 648) new DataView(bytes.buffer).setBigUint64(24 + field, BigInt(value), true);
      else bytes[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const old = execWork(59n); new DataView(old.buffer).setUint16(4, 19, true);
    expect(() => decodeUserspaceSyscallTrace(old)).toThrow();
  });

  it("identifies each bounded exec wait without completing the syscall", () => {
    for (const [id, reason] of [[1n, "collection-bound"], [2n, "cpu-quota"], [3n, "pending-operation"]] as const) {
      const bytes = record(59n, "execve"), view = new DataView(bytes.buffer), offset = 24;
      bytes[offset + 120] = 2; bytes[offset + 122] = 9;
      view.setBigUint64(offset + 128, 256n, true); view.setBigUint64(offset + 136, id, true);
      expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
        outcome: { kind: "blocked" }, wait: { kind: "io-uring-exec", pendingRequests: 256n, reason },
      });
      const invalid = bytes.slice(); new DataView(invalid.buffer).setBigUint64(offset + 56, 426n, true);
      expect(() => decodeUserspaceSyscallTrace(invalid)).toThrow();
      for (const field of [128, 136]) {
        const invalid = bytes.slice(); new DataView(invalid.buffer).setBigUint64(offset + field, 0n, true);
        expect(() => decodeUserspaceSyscallTrace(invalid)).toThrow();
      }
      bytes[offset + 120] = 0;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
