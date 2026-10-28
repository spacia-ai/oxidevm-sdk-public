import { describe, expect, it } from "vitest";
import { workerBindingFailure } from "../userspace-worker-binding-retirement.fixtures.ts";
import { decodeUserspaceFinalizationFailure, finalizationFailureDetail } from "./userspace-finalization-failure.ts";

describe("canonical original worker binding failure8", () => {
  it.each([false, true])("retains the stopped original allocation with metadata=%s and tracing disabled", metadata => {
    const bytes = workerBindingFailure(metadata), decoded = decodeUserspaceFinalizationFailure(bytes);
    expect(decoded).toMatchObject({ stage: "resource", errno: 5, progress: {
      kind: "worker-bindings", poolAllocationId: 11n, poolAllocationCgroupId: 91n,
    } });
    expect(() => JSON.stringify(finalizationFailureDetail(decoded))).not.toThrow();
    expect(finalizationFailureDetail(decoded)).toMatchObject({ progress: { poolAllocationId: "11", poolAllocationCgroupId: "91",
      ...(metadata ? { metadata: { allocationId: "57", allocationCgroupId: "92", references: "1" } } : {}) } });
    for (const version of [1, 2, 3, 4, 5, 6, 7, 9]) {
      const bad = bytes.slice(); new DataView(bad.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceFinalizationFailure(bad)).toThrow();
    }
    for (const field of [187, 188, 190, 192, 199, 200, 207, 245, 246, 247]) {
      const bad = bytes.slice(); bad[field] = 1;
      expect(() => decodeUserspaceFinalizationFailure(bad)).toThrow();
    }
  });
});
