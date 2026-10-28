import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace, USERSPACE_SYSCALL_TRACE_VERSION } from "./userspace-abi.ts";
import { poolFinalizationTrace } from "./userspace-pool-finalization-trace.fixtures.ts";

describe("task-owned pool finalization trace49", () => {
  it.each([1, 2, 3] as const)("keeps original pool, actor, allocation and CPU identities for kind=%s", kind => {
    expect(decodeUserspaceSyscallTrace(poolFinalizationTrace(kind))).toMatchObject({ version: 49, events: [{
      pid: 1, tid: 2, number: 60n, kind: "io-uring-pool-finalization", finalization: {
        poolAllocationId: 11n, ownerPid: 1, ownerTid: 2, guestTicks: 99n, cpuCgroupId: 41n,
        authority: { kind: "exiting-task" }, done: kind === 3,
        progress: { kind: kind === 1 ? "registered-ring" : kind === 2 ? "worker-binding" : "owner" },
      },
    }] });
  });

  it("retains seccomp and the actual final-request identity in distinct wire fields", () => {
    expect(decodeUserspaceSyscallTrace(poolFinalizationTrace(2, true, true))).toMatchObject({ events: [{
      seccomp: { kind: "strict", action: "allow" }, finalization: {
        authority: { kind: "last-request", work: { poolId: 11n, sequence: 7n } },
        progress: { binding: { poolAllocationCgroupId: 91n, metadata: { allocationCgroupId: 92n, references: 1n } } },
      },
    }] });
  });

  it("validates the original exit actor and admits a different actor only for a real group exit", () => {
    const bytes = poolFinalizationTrace(2), view = new DataView(bytes.buffer), at = 24;
    view.setUint32(at + 28, 0x8000_0000, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    view.setUint32(at + 28, 3, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    view.setBigUint64(at + 56, 231n, true);
    bytes.fill(0, at + 152, at + 192);bytes.set(new TextEncoder().encode("exit_group"), at + 152);bytes[at + 121] = 10;
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({ tid: 3, finalization: { ownerTid: 2 } });
    view.setBigUint64(at + 56, 39n, true);
    bytes.fill(0, at + 152, at + 192);bytes.set(new TextEncoder().encode("getpid"), at + 152);bytes[at + 121] = 6;
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    bytes[at + 272] = 2;
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    view.setUint32(at + 28, 2, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({ seccomp: { kind: "strict", action: "kill" } });
  });

  it("rejects unqualified versions, foreign owners, reserved bytes and an invented completion", () => {
    for (const version of [1, 41, 42, 43, 44, 45, 46, 47, 48, USERSPACE_SYSCALL_TRACE_VERSION + 1]) {
      const bytes = poolFinalizationTrace(2);new DataView(bytes.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const offset of [128, 144, 232, 233, 234, 238, 252, 256, 264, 288, 440, 511, 513, 519, 536, 543, 624, 991]) {
      const bytes = poolFinalizationTrace(2);bytes[24 + offset] = 1;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const [offset, value] of [[192, 12n], [200, 0n], [200, 0x8000_0000n], [208, 49n], [224, 0n], [520, 12n], [528, 0n]] as const) {
      const bytes = poolFinalizationTrace(2, true);new DataView(bytes.buffer).setBigUint64(24 + offset, value, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const bytes = poolFinalizationTrace(2);bytes[24 + 235] = 1;bytes[24 + 120] = 4;
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });
});
