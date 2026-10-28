import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace, USERSPACE_SYSCALL_TRACE_VERSION,
  type UserspaceSyscallTraceSnapshot } from "./userspace-abi.ts";

function cleanup(counts: readonly number[] = [17, 129, 12, 1], metadata = 2): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 928), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 37, true); view.setUint32(8, 928, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 7, true); view.setUint32(offset + 28, 7, true);
  view.setBigUint64(offset + 40, 0x5000n, true); view.setBigUint64(offset + 48, 0x5002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  view.setBigUint64(offset + 64, 3n, true); view.setBigUint64(offset + 72, 512n, true);
  bytes[offset + 120] = 2; bytes[offset + 122] = 15;
  view.setBigUint64(offset + 128, 17n, true); view.setBigUint64(offset + 136, 11n, true);
  bytes[offset + 192] = 13; bytes[offset + 193] = 3; bytes[offset + 194] = metadata;
  view.setBigUint64(offset + 200, 11n, true);
  for (const [index, count] of counts.entries()) view.setUint32(offset + 208 + index * 4, count, true);
  view.setUint32(offset + 244, 12, true);
  return bytes;
}

describe("trace37 retained submission failure", () => {
  it("exports and decodes the exact current wire version", () => {
    const version: UserspaceSyscallTraceSnapshot["version"] = 37;
    const latest: UserspaceSyscallTraceSnapshot["version"] = USERSPACE_SYSCALL_TRACE_VERSION;
    expect(latest).toBeGreaterThanOrEqual(version);
    expect(decodeUserspaceSyscallTrace(cleanup()).version).toBe(version);
  });

  it("retains the completed prefix, unsubmitted copies and real page owners", () => {
    expect(decodeUserspaceSyscallTrace(cleanup())).toMatchObject({ version: 37, events: [{
      wait: { kind: "io-uring-enter", metadataStorage: "paged", progress: {
        kind: "submission-cleanup", submitted: 17, copiedEntries: 129,
        submissionPages: 12, completionPages: 1, errno: 12,
      } },
    }] });
  });

  it("admits a zero-prefix failure and the final empty copied chain", () => {
    for (const counts of [[0, 0, 1, 0], [1, 0, 1, 1]]) {
      expect(decodeUserspaceSyscallTrace(cleanup(counts))).toMatchObject({ events: [{
        wait: { progress: { kind: "submission-cleanup", submitted: counts[0], copiedEntries: 0 } },
      }] });
    }
  });

  it("retains a historical vector reservation under the current failure format", () => {
    expect(decodeUserspaceSyscallTrace(cleanup([17, 129, 256, 33], 1))).toMatchObject({ events: [{
      wait: { metadataStorage: "legacy", progress: { kind: "submission-cleanup", submissionPages: 256 } },
    }] });
  });

  it("rejects copied entries beyond the admitted suffix and impossible page bounds", () => {
    for (const counts of [[513, 0, 1, 0], [512, 1, 1, 1], [1, 512, 1, 1],
      [1, 1, 0, 1], [1, 1, 45, 1], [1, 1, 1, 20]]) {
      expect(() => decodeUserspaceSyscallTrace(cleanup(counts))).toThrow();
    }
  });

  it("rejects invented errors, owners, items, reserved bytes and foreign syscalls", () => {
    const mutations: readonly ((view: DataView) => void)[] = [
      view => view.setUint32(24 + 244, 0, true), view => view.setUint32(24 + 244, 4, true),
      view => view.setUint8(24 + 194, 0), view => view.setUint8(24 + 194, 3),
      view => view.setUint8(24 + 195, 1), view => view.setUint32(24 + 224, 1, true),
      view => view.setUint8(24 + 248, 1), view => view.setBigUint64(24 + 56, 425n, true),
    ];
    for (const mutate of mutations) {
      const bytes = cleanup(); mutate(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("does not reinterpret failure cleanup in historical trace versions", () => {
    for (const version of [35, 36]) {
      const bytes = cleanup(); new DataView(bytes.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
