import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.js";

function workerTrace(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(312), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 9, true); view.setUint32(8, 288, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  bytes[offset + 121] = 14; bytes[offset + 123] = 1;
  bytes.set(new TextEncoder().encode("io_uring_enter"), offset + 152);
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 1, true);
  view.setUint32(offset + 220, 3, true); view.setUint32(offset + 224, 0xffff_fffe, true);
  view.setUint32(offset + 228, 1, true); bytes[offset + 233] = 1; bytes[offset + 234] = 2;
  return bytes;
}

describe("Userspace trace v9", () => {
  it("decodes v10 worker credential identity and rejects absent, invalid or unversioned identity", () => {
    const bytes = workerTrace(), view = new DataView(bytes.buffer);
    view.setUint16(4, 10, true); view.setBigUint64(24 + 240, 19n, true);
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ version: 10, events: [{
      kind: "io-uring-work", work: { credentialId: 19n },
    }] });
    for (const invalid of [0n, 0xffff_ffff_ffff_ffffn]) {
      view.setBigUint64(24 + 240, invalid, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow("malformed");
    }
    view.setBigUint64(24 + 240, 19n, true); view.setUint16(4, 9, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow("malformed");
  });

  it("identifies an exit waiting for its owner's requests or the entire process", () => {
    const bytes = workerTrace(), view = new DataView(bytes.buffer), offset = 24;
    bytes.fill(0, offset + 192, offset + 272);
    bytes[offset + 123] = 0; bytes[offset + 122] = 7; bytes[offset + 120] = 1;
    view.setBigUint64(offset + 56, 60n, true);
    view.setBigUint64(offset + 128, 2n, true); view.setBigUint64(offset + 136, 128n, true);
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ kind: "syscall",
      wait: { kind: "io-uring-exit", scope: { kind: "owner", tid: 2 }, pendingRequests: 128n },
    }] });
    view.setBigUint64(offset + 56, 231n, true); view.setBigUint64(offset + 128, 0n, true);
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{
      wait: { kind: "io-uring-exit", scope: { kind: "process" }, pendingRequests: 128n },
    }] });
    for (const [field, value] of [[56, 60n], [128, 1n], [136, 0n]] as const) {
      const invalid = bytes.slice(); new DataView(invalid.buffer).setBigUint64(offset + field, value, true);
      expect(() => decodeUserspaceSyscallTrace(invalid)).toThrow("malformed");
    }
  });
  it("decodes the worker and originating syscall identities without treating a worker as a guest syscall", () => {
    expect(decodeUserspaceSyscallTrace(workerTrace())).toMatchObject({ version: 9, events: [{
      kind: "io-uring-work", pid: 1, tid: 2, instructionRip: 0x1000n, nextRip: 0x1002n,
      number: 426n, name: "io_uring_enter", outcome: { kind: "result", value: 0n },
      work: { poolId: 7n, sequence: 9n, guestTicks: 51n, creatorTid: 1, chainSlot: 3,
        sqSequence: 0xffff_fffe, sqeIndex: 1, opcode: 0, done: true, completion: "published" },
    }] });
  });

  it("rejects invalid identity, discriminants, waits, results and reserved bytes", () => {
    for (const [offset, value] of [[123, 2], [192, 0], [200, 0], [216, 0], [233, 2], [234, 3], [235, 1], [271, 1], [122, 1], [120, 2]] as const) {
      const bytes = workerTrace(); bytes[24 + offset] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow("malformed");
    }
    for (const [offset, value] of [[56, 1n], [112, 0x8000_0000n], [112, -0x8000_0001n]] as const) {
      const bytes = workerTrace(); new DataView(bytes.buffer).setBigInt64(24 + offset, value, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow("malformed");
    }
    const legacy = workerTrace(); new DataView(legacy.buffer).setUint16(4, 8, true);
    expect(() => decodeUserspaceSyscallTrace(legacy)).toThrow("malformed");
  });
});
