import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function providedTrace(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 992), view = new DataView(bytes.buffer), at = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 43, true); view.setUint32(8, 992, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(at + field, 1n, true);
  view.setUint32(at + 24, 2, true); view.setUint32(at + 28, 2, true);
  view.setBigUint64(at + 40, 0x1000n, true); view.setBigUint64(at + 48, 0x1002n, true);
  view.setBigUint64(at + 56, 3n, true); bytes[at + 120] = 2; bytes[at + 123] = 4;
  for (const [field, value] of [[192, 7n], [200, 8n], [208, 99n], [216, 50n], [224, 91n],
    [536, 0x1234n], [544, 57n], [552, 92n]] as const) view.setBigUint64(at + field, value, true);
  bytes[at + 232] = 5; bytes[at + 233] = 13; bytes[at + 234] = 1; bytes[at + 236] = 1;
  view.setUint16(at + 512, 9, true); view.setUint16(at + 514, 7, true);
  for (const [field, value] of [[516, 4], [520, 257], [524, 1], [528, 257], [532, 2]] as const) view.setUint32(at + field, value, true);
  return bytes;
}

describe("trace43 provided-buffer finalization", () => {
  it("retains the original allocation separately from the closing CPU account", () => {
    expect(decodeUserspaceSyscallTrace(providedTrace())).toMatchObject({ version: 43, events: [{
      kind: "io-uring-finalization", finalization: { cpuCgroupId: 91n, done: false, progress: {
        kind: "provided-buffers", phase: "provided-run", groupId: 9, firstId: 7,
        address: 0x1234n, length: 4, count: 257, runsBefore: 1, buffersBefore: 257,
        groupsBefore: 2, metadataAllocationId: 57n, allocationCgroupId: 92n,
      } },
    }] });
  });

  it("retains the empty group's allocation before its separate release", () => {
    const bytes = providedTrace(), at = 24;
    bytes[at + 233] = 14; bytes.fill(0, at + 514, at + 532); bytes.fill(0, at + 536, at + 544);
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ finalization: { done: false, progress: {
      kind: "provided-buffers", phase: "provided-group", groupId: 9,
      metadataAllocationId: 57n, allocationCgroupId: 92n, groupsBefore: 2,
    } } }] });
  });

  it("rejects old headers, unclaimed bytes and an early released outcome", () => {
    const old = providedTrace(); new DataView(old.buffer).setUint16(4, 42, true);
    expect(() => decodeUserspaceSyscallTrace(old)).toThrow();
    for (const field of [256, 264, 288, 304, 312, 440, 511, 560, 959, 960, 991]) {
      const bytes = providedTrace(); bytes[24 + field] = 1;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const early = providedTrace(); early[24 + 235] = 1; early[24 + 120] = 4;
    expect(() => decodeUserspaceSyscallTrace(early)).toThrow();
  });
});
