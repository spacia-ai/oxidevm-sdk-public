import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace, USERSPACE_SYSCALL_TRACE_VERSION,
  type UserspaceSyscallTraceSnapshot } from "./userspace-abi.ts";

function caller(metadata: number, phase: number, counts: readonly number[], maximum = 512): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 928), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 36, true); view.setUint32(8, 928, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 7, true); view.setUint32(offset + 28, 7, true);
  view.setBigUint64(offset + 40, 0x5000n, true); view.setBigUint64(offset + 48, 0x5002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  view.setBigUint64(offset + 64, 3n, true); view.setBigUint64(offset + 72, BigInt(maximum), true);
  bytes[offset + 120] = 2; bytes[offset + 122] = 15;
  view.setBigUint64(offset + 128, 17n, true); view.setBigUint64(offset + 136, 11n, true);
  bytes[offset + 192] = phase; bytes[offset + 193] = 3; bytes[offset + 194] = metadata;
  view.setBigUint64(offset + 200, 11n, true);
  for (const [index, count] of counts.entries()) view.setUint32(offset + 208 + index * 4, count, true);
  return bytes;
}

describe("trace36 actual caller metadata owners", () => {
  it("retains version36 in the exported historical snapshot type", () => {
    const historical: UserspaceSyscallTraceSnapshot["version"] = 36;
    expect(USERSPACE_SYSCALL_TRACE_VERSION).toBeGreaterThanOrEqual(historical);
    expect(decodeUserspaceSyscallTrace(caller(2, 2, [0, 1, 0, 0], 0)).version).toBe(historical);
  });

  it("admits one real header page for an empty caller before any SQE exists", () => {
    expect(decodeUserspaceSyscallTrace(caller(2, 2, [0, 1, 0, 0], 0))).toMatchObject({
      version: 36, events: [{ wait: { metadataStorage: "paged", progress: {
        kind: "funding", submissionPages: 0, submissionGoal: 1, completionPages: 0, completionGoal: 0,
      } } }],
    });
  });

  it("retains legacy reservations when a historical continuation runs under the new engine", () => {
    expect(decodeUserspaceSyscallTrace(caller(1, 2, [127, 256, 0, 33]))).toMatchObject({
      events: [{ wait: { metadataStorage: "legacy", progress: { kind: "funding", submissionGoal: 256 } } }],
    });
  });

  it("counts processed output separately from the remaining paged suffix", () => {
    for (const phase of [5, 8]) {
      expect(decodeUserspaceSyscallTrace(caller(2, phase, [500, 12, 500, 0]))).toMatchObject({
        events: [{ wait: { metadataStorage: "paged", progress: {
          kind: "publishing", nextOutput: 500, ownedOutputs: 12,
        } } }],
      });
    }
  });

  it("retains this call's outputs while older overflow is staged privately", () => {
    expect(decodeUserspaceSyscallTrace(caller(2, 7, [0, 512, 500, 0]))).toMatchObject({
      events: [{ wait: { progress: { kind: "publishing", phase: "flush", nextOutput: 0, ownedOutputs: 512 } } }],
    });
    for (const bytes of [caller(2, 6, [512, 0, 500, 0]), caller(2, 7, [1, 511, 500, 0]), caller(2, 7, [0, 512, 500, 1])]) {
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("retains the charged caller header through CQ retirement", () => {
    expect(decodeUserspaceSyscallTrace(caller(2, 9, [512, 1, 19, 0]))).toMatchObject({
      events: [{ wait: { metadataStorage: "paged", progress: {
        kind: "retiring", submitted: 512, submissionPages: 1, completionPages: 19,
      } } }],
    });
  });

  it("keeps older overflow retirement distinct from this call's submitted output", () => {
    expect(decodeUserspaceSyscallTrace(caller(2, 9, [0, 1, 0, 19], 0))).toMatchObject({
      events: [{ wait: { metadataStorage: "paged", progress: {
        kind: "retiring", submitted: 0, submissionPages: 1, completionPages: 0, overflowPages: 19,
      } } }],
    });
    for (const bytes of [
      caller(2, 9, [0, 1, 1, 19], 0), caller(1, 9, [0, 0, 0, 19], 0),
      caller(2, 9, [0, 1, 0, 1_048_576 * 2049 + 1], 0),
    ]) expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });

  it("rejects unknown owners, prepaid paged storage, oversized suffixes and missing live headers", () => {
    for (const bytes of [
      caller(3, 2, [0, 1, 0, 0]), caller(0, 2, [0, 1, 0, 0]),
      caller(2, 2, [0, 2, 0, 0]), caller(2, 2, [1, 1, 1, 33]),
      caller(2, 5, [501, 12, 500, 0]), caller(2, 9, [512, 0, 0, 0]),
      caller(2, 9, [512, 45, 0, 0]), caller(2, 9, [512, 1, 20, 0]),
    ]) expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });

  it("forbids an owner on phases that no longer retain a caller allocation", () => {
    for (const phase of [1, 11]) {
      const counts = [0, 0, 0, 0];
      expect(decodeUserspaceSyscallTrace(caller(0, phase, counts))).toMatchObject({ events: [{ wait: {} }] });
      expect(() => decodeUserspaceSyscallTrace(caller(2, phase, counts))).toThrow();
    }
  });

  it("rejects a paged tag on a historical trace or nonzero reserved padding", () => {
    for (const historical of [true, false]) {
      const bytes = caller(2, 2, [0, 1, 0, 0]), view = new DataView(bytes.buffer);
      if (historical) view.setUint16(4, 35, true);
      else bytes[24 + 195] = 1;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
