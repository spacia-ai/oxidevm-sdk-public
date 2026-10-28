import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function inline(remove = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 992), view = new DataView(bytes.buffer), at = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 43, true); view.setUint32(8, 992, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(at + field, 1n, true);
  view.setUint32(at + 24, 1, true); view.setUint32(at + 28, 1, true);
  for (const [field, value] of [[40, 0x1000n], [48, 0x1002n], [56, 426n], [64, 3n], [72, 1n],
    [192, 61n], [200, 8n], [208, 18n], [216, 7n], [240, 19n], [256, 17n], [264, 1n], [616, 8n]] as const) view.setBigUint64(at + field, value, true);
  bytes[at + 123] = 5; bytes[at + 232] = remove ? 32 : 31; bytes[at + 234] = 1;
  view.setUint32(at + 248, 17, true);
  bytes[at + 288] = remove ? 32 : 31;
  view.setUint32(at + 292, 2, true); view.setUint16(at + 328, 9, true);
  view.setBigUint64(at + 320, 73n, true);
  bytes[at + 584] = remove ? 2 : 1;
  view.setUint16(at + 586, 9, true); view.setUint32(at + 588, 2, true);
  view.setUint32(at + 592, 2, true);
  if (remove) view.setBigInt64(at + 112, 2n, true);
  else {
    view.setBigUint64(at + 296, 7n, true); view.setBigUint64(at + 304, 0x1234n, true);
    view.setUint32(at + 312, 4, true);
    view.setBigUint64(at + 600, 0x1234n, true); view.setUint32(at + 596, 4, true);
    view.setUint16(at + 608, 7, true); bytes[at + 610] = 1;
    for (const [field, value] of [[960, 51n], [968, 7n], [976, 52n], [984, 8n]] as const) view.setBigUint64(at + field, value, true);
  }
  return bytes;
}

describe("inline buffer operations", () => {
  it("retains the real syscall, copied SQE and allocated origins without an io-wq identity", () => {
    expect(decodeUserspaceSyscallTrace(inline())).toMatchObject({ version: 43, events: [{
      kind: "io-uring-inline-buffers", pid: 1, tid: 1, number: 426n,
      operation: { ringObjectId: 61n, ringOpenFileId: 8n, guestTicks: 18n, admittedGuestTicks: 17n,
        cpuCgroupId: 7n, credentialId: 19n, chainSlot: 0, sqSequence: 17, sqeIndex: 0, kernelUnits: 1,
        sqe: { opcode: 31, userData: 73n }, buffers: { kind: "provide", count: 2, provided: 2,
          allocationOrigin: { kind: "recorded", run: { allocationId: 51n, cgroupId: 7n },
            group: { allocationId: 52n, cgroupId: 8n } } },
      },
    }] });
  });

  it("retains actual synchronous removals under their original SQE", () => {
    expect(decodeUserspaceSyscallTrace(inline(true))).toMatchObject({ events: [{
      kind: "io-uring-inline-buffers", outcome: { kind: "result", value: 2n }, operation: {
        sqe: { opcode: 32, userData: 73n }, buffers: { kind: "remove", requested: 2, removed: 2 },
      },
    }] });
  });

  it("rejects an allocation-origin trailer on a removal", () => {
    const bytes = inline(true); bytes[24 + 960] = 1;
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });

  it("rejects missing owners, mismatched copied fields, invented worker fields and old versions", () => {
    for (const [field, value] of [[56, 427], [192, 0], [200, 0], [208, 0], [216, 0], [240, 0],
      [264, 0], [264, 2], [233, 1], [234, 2], [235, 1], [252, 1], [288, 32], [292, 3],
      [296, 8], [304, 9], [312, 5], [328, 8], [352, 1], [512, 1], [624, 1], [752, 1],
      [832, 1], [928, 1], [952, 1]] as const) {
      const bytes = inline(); new DataView(bytes.buffer).setUint8(24 + field, value);
      expect(() => decodeUserspaceSyscallTrace(bytes), String(field)).toThrow();
    }
    const backwards = inline(); new DataView(backwards.buffer).setBigUint64(24 + 256, 19n, true);
    expect(() => decodeUserspaceSyscallTrace(backwards)).toThrow();
    const legacy = inline(); legacy.fill(0, 24 + 960); legacy[24 + 610] = 2;
    expect(() => decodeUserspaceSyscallTrace(legacy)).toThrow();
    const old = inline().slice(0, 24 + 960), view = new DataView(old.buffer);
    view.setUint16(4, 42, true); view.setUint32(8, 960, true);
    expect(() => decodeUserspaceSyscallTrace(old)).toThrow();
  });
});
