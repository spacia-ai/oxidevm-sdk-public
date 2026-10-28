import { describe, expect, it } from "vitest";
import { decodeUserspaceFinalizationFailure, finalizationFailureDetail } from "./userspace-finalization-failure.ts";
import { poolFinalizationFailure } from "./userspace-pool-finalization-failure.fixtures.ts";
import { workerBindingFailure } from "../userspace-worker-binding-retirement.fixtures.ts";

describe("canonical task-pool failure9", () => {
  it.each([1, 2, 3] as const)("retains original pool, resource and authority for kind=%s without tracing", kind => {
    const decoded = decodeUserspaceFinalizationFailure(poolFinalizationFailure(kind, true));
    expect(decoded).toMatchObject({ kind: "pool", errno: 5, guestTicks: 99n, identity: {
      poolAllocationId: 11n, ownerPid: 1, ownerTid: 2, source: { kind: "syscall", number: 60n },
    }, account: { cpuCgroupId: 41n, authority: { kind: "last-request", work: { poolId: 11n, sequence: 7n } } } });
    const detail = finalizationFailureDetail(decoded);
    expect(detail).toMatchObject({ kind: "pool", poolAllocationId: "11", cpuCgroupId: "41", authority: {
      kind: "last-request", work: { poolId: "11", sequence: "7" },
    } });
    expect(() => JSON.stringify(detail)).not.toThrow();
  });

  it("retains selection identity without inventing a resource or missing CPU authority", () => {
    const bytes = poolFinalizationFailure(2), view = new DataView(bytes.buffer);
    bytes[16] = 4;bytes.fill(0, 192, 272);
    expect(decodeUserspaceFinalizationFailure(bytes)).toMatchObject({ kind: "pool", stage: "selection", account: { cpuCgroupId: 41n } });
    view.setBigUint64(40, 0n, true);bytes[184] = 0;
    const decoded = decodeUserspaceFinalizationFailure(bytes);
    expect(decoded).toMatchObject({ kind: "pool", stage: "selection" });
    expect(decoded).not.toHaveProperty("account");expect(decoded).not.toHaveProperty("progress");
    bytes[192] = 2;
    expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
  });

  it("preserves historical ring payloads in the extended failure envelope", () => {
    const old = workerBindingFailure(true), bytes = new Uint8Array(320);bytes.set(old);
    const view = new DataView(bytes.buffer);view.setUint16(4, 9, true);view.setUint16(6, 320, true);
    expect(decodeUserspaceFinalizationFailure(bytes)).toEqual(decodeUserspaceFinalizationFailure(old));
    bytes[319] = 1;expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
  });

  it("rejects fabricated exit sources while retaining real seccomp process and thread kills", () => {
    const bytes = poolFinalizationFailure(2), view = new DataView(bytes.buffer);
    view.setBigUint64(88, 39n, true);
    expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    bytes[168] = 2;
    expect(decodeUserspaceFinalizationFailure(bytes)).toMatchObject({ identity: { source: { number: 39n, decision: { action: "kill" } } } });
    view.setUint32(56, 3, true);
    expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    bytes[168] = 3;view.setBigUint64(176, 7n, true);view.setUint32(172, 0x8000_0000, true);
    expect(decodeUserspaceFinalizationFailure(bytes)).toMatchObject({ identity: { ownerTid: 2, source: { tid: 3, decision: { value: 0x8000_0000 } } } });
    view.setUint32(172, 0x7fff_0000, true);
    expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
  });

  it("rejects partial envelopes, foreign owners, wrong stages, missing accounts and reserved bytes", () => {
    for (const offset of [19, 50, 51, 185, 186, 187, 288, 319]) {
      const bytes = poolFinalizationFailure(2);bytes[offset] = 1;
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
    for (const [offset, value] of [[24, 12n], [32, 0n], [40, 0n], [272, 12n], [280, 0n]] as const) {
      const bytes = poolFinalizationFailure(2, true);new DataView(bytes.buffer).setBigUint64(offset, value, true);
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
    for (const stage of [1, 2, 3, 4, 7, 8]) {
      const bytes = poolFinalizationFailure(2);bytes[16] = stage;
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
    expect(() => decodeUserspaceFinalizationFailure(poolFinalizationFailure(2).subarray(0, 256))).toThrow();
    const old = poolFinalizationFailure(2);new DataView(old.buffer).setUint16(4, 8, true);
    expect(() => decodeUserspaceFinalizationFailure(old)).toThrow();
  });
});
