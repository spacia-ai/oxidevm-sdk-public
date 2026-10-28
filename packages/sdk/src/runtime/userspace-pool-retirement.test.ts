import { describe, expect, it } from "vitest";
import { decodePoolCpuAuthority, decodePoolRetirementProgress, poolRetirementProgressDetail } from "./userspace-pool-retirement.ts";
import { poolRetirementProgress } from "./userspace-pool-retirement.fixtures.ts";

describe("original exited task-pool resources", () => {
  it.each([1, 2, 3] as const)("decodes original resource kind %s and rejects reserved or foreign-owner fields", kind => {
    const bytes = poolRetirementProgress(kind), view = new DataView(bytes.buffer);
    const progress = decodePoolRetirementProgress(view, 0, 11n);
    expect(progress).toMatchObject({ kind: kind === 1 ? "registered-ring" : kind === 2 ? "worker-binding" : "owner" });
    for (const offset of [2, 3, 4, 5, 6, 7, 72, 79]) {
      const bad = bytes.slice();bad[offset] = 1;
      expect(decodePoolRetirementProgress(new DataView(bad.buffer), 0, 11n)).toBeUndefined();
    }
    if (kind !== 1) expect(decodePoolRetirementProgress(view, 0, 12n)).toBeUndefined();
    for (const at of [-1, 0.5, 1, 80, Number.MAX_SAFE_INTEGER]) expect(decodePoolRetirementProgress(view, at, 11n)).toBeUndefined();
    expect(decodePoolRetirementProgress(view, 0, 0n)).toBeUndefined();
  });

  it("retains original metadata allocation and reference counts across both diagnostic channels", () => {
    const bytes = poolRetirementProgress(2, true), view = new DataView(bytes.buffer);
    const progress = decodePoolRetirementProgress(view, 0, 11n);
    expect(progress).toMatchObject({ binding: { metadata: { allocationId: 57n, allocationCgroupId: 92n, references: 1n } } });
    if (progress === undefined) throw new Error("valid original metadata fixture");
    expect(() => JSON.stringify(poolRetirementProgressDetail(progress))).not.toThrow();
    view.setBigUint64(24 + 16, 11n, true);
    expect(decodePoolRetirementProgress(view, 0, 11n)).toBeUndefined();
  });

  it("accepts only an exiting task or the actual original final request as CPU authority", () => {
    expect(decodePoolCpuAuthority(1, 0n, 0n, 11n)).toEqual({ kind: "exiting-task" });
    expect(decodePoolCpuAuthority(2, 11n, 7n, 11n)).toEqual({ kind: "last-request", work: { poolId: 11n, sequence: 7n } });
    for (const [kind, pool, sequence] of [[0, 0n, 0n], [1, 11n, 0n], [1, 0n, 1n], [2, 12n, 7n], [2, 11n, 0n], [3, 11n, 1n]] as const) {
      expect(decodePoolCpuAuthority(kind, pool, sequence, 11n)).toBeUndefined();
    }
  });
});
