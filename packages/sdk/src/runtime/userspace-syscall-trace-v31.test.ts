import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function idleRecord(reason = 4): Uint8Array {
  const bytes = new Uint8Array(24 + 832), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 31, true); view.setUint32(8, 832, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 7, true);
  view.setBigUint64(offset + 56, 0xffff_ffff_ffff_ffffn, true);
  bytes[offset + 123] = 3;
  bytes[offset + 192] = reason;
  bytes[offset + 194] = reason === 4 ? 0 : 1;
  bytes[offset + 195] = reason === 1 ? 2 : reason === 2 ? 3 : 1;
  view.setUint32(offset + 196, reason === 3 ? 2 : 1, true);
  view.setBigUint64(offset + 200, 11n, true);
  view.setBigUint64(offset + 208, 15_360_000_000n, true);
  view.setUint32(offset + 216, 1, true); view.setUint32(offset + 220, 1, true);
  if (reason !== 1) view.setBigUint64(offset + 224, 5_000_000_000n, true);
  if (reason < 3) view.setBigUint64(offset + 232, 11_000_000_000n, true);
  view.setBigUint64(offset + 240, 31n, true);
  view.setBigUint64(offset + 248, 77n, true); view.setBigUint64(offset + 256, 99n, true);
  return bytes;
}

describe("syscall trace v31 io-wq lifecycle", () => {
  it.each([
    [1, "idle-started"], [2, "last-worker"], [3, "excess-worker"], [4, "affinity-excluded"],
  ] as const)("decodes committed idle decision %s", (reason, name) => {
    expect(decodeUserspaceSyscallTrace(idleRecord(reason))).toMatchObject({ version: 31, events: [{
      kind: "io-uring-worker-idle", pid: 1, tid: 7, outcome: { kind: "result", value: 0n },
      worker: { poolId: 11n, creatorTid: 1, class: "bounded", reason: name,
        allocationId: 31n, allocationCgroup: 77n, cpuCgroup: 99n,
        cpuAllowed: reason !== 4, classWorkers: reason === 3 ? 2 : 1,
        kernelUnits: 1, guestTicks: 15_360_000_000n,
        ...(reason === 1 ? {} : { deadline: 5_000_000_000n }),
        ...(reason < 3 ? { nextDeadline: 11_000_000_000n } : {}),
      },
    }] });
  });

  it("preserves unbounded class and shifted byte views", () => {
    const bytes = idleRecord(); bytes[24 + 193] = 1;
    const shifted = new Uint8Array(bytes.length + 11); shifted.set(bytes, 7);
    expect(decodeUserspaceSyscallTrace(shifted.subarray(7, 7 + bytes.length)).events[0]).toMatchObject({
      worker: { class: "unbounded" },
    });
  });

  it("rejects impossible decisions, forged context and nonzero reserved fields", () => {
    const changes: readonly ((view: DataView) => void)[] = [
      view => view.setUint16(4, 30, true), view => view.setBigUint64(24 + 56, 427n, true),
      view => view.setBigUint64(24 + 40, 1n, true), view => view.setBigUint64(24 + 48, 1n, true),
      view => view.setBigUint64(24 + 64, 1n, true), view => view.setBigInt64(24 + 112, -11n, true),
      view => view.setUint8(24 + 120, 2), view => view.setUint8(24 + 122, 1),
      view => view.setUint8(24 + 192, 0), view => view.setUint8(24 + 192, 5),
      view => view.setUint8(24 + 193, 2), view => view.setUint8(24 + 194, 1),
      view => view.setUint8(24 + 195, 0), view => view.setUint8(24 + 195, 5),
      view => view.setUint32(24 + 196, 0, true), view => view.setUint32(24 + 196, 4097, true),
      view => view.setBigUint64(24 + 200, 0n, true), view => view.setBigUint64(24 + 208, 0n, true),
      view => view.setUint32(24 + 216, 0, true), view => view.setUint32(24 + 216, 7, true),
      view => view.setUint32(24 + 220, 0, true), view => view.setUint32(24 + 220, 128, true),
      view => view.setBigUint64(24 + 224, 7_000_000_000n, true),
      view => view.setBigUint64(24 + 232, 1n, true),
      view => view.setBigUint64(24 + 240, 0n, true), view => view.setBigUint64(24 + 240, 11n, true),
      view => view.setBigUint64(24 + 248, 0n, true), view => view.setBigUint64(24 + 256, 0n, true),
      view => view.setUint8(24 + 264, 1), view => view.setUint8(24 + 272, 2),
      view => view.setUint8(24 + 624, 1), view => view.setUint8(24 + 831, 1),
    ];
    for (const change of changes) {
      const bytes = idleRecord(); change(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});

function rejectedWorker(errno: number): Uint8Array {
  const bytes = idleRecord(), view = new DataView(bytes.buffer), offset = 24;
  bytes.fill(0, offset + 192);
  view.setUint32(offset + 28, 1, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  view.setBigInt64(offset + 112, -125n, true); bytes[offset + 123] = 1;
  view.setBigUint64(offset + 192, 11n, true); view.setBigUint64(offset + 200, 1n, true);
  view.setBigUint64(offset + 208, 100n, true); view.setUint32(offset + 216, 1, true);
  bytes[offset + 232] = 22; bytes[offset + 233] = 1; bytes[offset + 234] = 2;
  view.setBigUint64(offset + 240, 7n, true);
  bytes[offset + 624] = 6; view.setUint32(offset + 628, errno, true);
  return bytes;
}

describe("syscall trace v31 rejected worker admission", () => {
  it.each([11, 12])("retains admission errno %s separately from the cancellation CQE", errno => {
    expect(decodeUserspaceSyscallTrace(rejectedWorker(errno)).events[0]).toMatchObject({
      kind: "io-uring-work", tid: 1, outcome: { kind: "result", value: -125n },
      work: { creatorTid: 1, poolId: 11n, sequence: 1n, completion: "published",
        executor: { kind: "worker-admission-failed", errno },
      },
    });
  });
  it("rejects old formats, impossible errors, foreign owners and forged success", () => {
    const changes: readonly ((view: DataView) => void)[] = [
      view => view.setUint16(4, 30, true), view => view.setUint32(24 + 628, 5, true),
      view => view.setUint32(24 + 628, 0, true), view => view.setUint8(24 + 625, 1),
      view => view.setUint32(24 + 28, 2, true), view => view.setBigInt64(24 + 112, 8n, true),
      view => view.setBigUint64(24 + 632, 1n, true), view => view.setUint8(24 + 234, 3),
    ];
    for (const change of changes) {
      const bytes = rejectedWorker(11); change(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
