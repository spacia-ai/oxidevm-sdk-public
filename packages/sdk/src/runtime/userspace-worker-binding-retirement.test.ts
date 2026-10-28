import { describe, expect, it } from "vitest";
import { decodeWorkerBindingRetirement, readWorkerBindingFields } from "./userspace-worker-binding-retirement.ts";
import { workerBindingTrace } from "./userspace-worker-binding-retirement.fixtures.ts";
import { decodeUserspaceSyscallTrace, USERSPACE_SYSCALL_TRACE_VERSION } from "./userspace-abi.ts";

describe("original worker binding ownership", () => {
  it.each([false, true])("retains the exact original membership and optional metadata=%s", metadata => {
    const trace = workerBindingTrace(metadata);
    expect(decodeUserspaceSyscallTrace(trace)).toMatchObject({ version: 48, events: [{
      kind: "io-uring-finalization", finalization: { done: false, progress: {
        kind: "worker-bindings", phase: "worker-binding", poolAllocationId: 11n,
        poolAllocationCgroupId: 91n, poolsBefore: 257, bindingsBefore: metadata ? 25 : 1,
        metadataPagesBefore: metadata ? 1 : 0,
        ...(metadata ? { metadata: { allocationId: 57n, allocationCgroupId: 92n, references: 1n } } : {}),
      } },
    }] });
    for (const version of [41, 42, 43, 44, 45, 46, 47, USERSPACE_SYSCALL_TRACE_VERSION + 1]) {
      const bad = trace.slice(); new DataView(bad.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceSyscallTrace(bad)).toThrow();
    }
    for (const field of [238, 256, 264, 288, 296, 304, 312, 320, 440, 511, 549, 550, 551, 560, 991]) {
      const bad = trace.slice(); bad[24 + field] = 1;
      expect(() => decodeUserspaceSyscallTrace(bad)).toThrow();
    }
  });

  it("rejects forged pool, count, geometry and metadata-reference fields", () => {
    const bytes = workerBindingTrace(true);
    const raw = readWorkerBindingFields(new DataView(bytes.buffer), 24 + 512);
    for (const patch of [{ poolAllocationId: 0n }, { poolAllocationId: 0xffff_ffff_ffff_ffffn },
      { poolAllocationCgroupId: 0n }, { poolsBefore: 0 }, { poolsBefore: 4097 }, { poolsBefore: 1.5 },
      { bindingsBefore: 0 }, { bindingsBefore: 4097 }, { metadataPagesBefore: 0 }, { reserved: 1 },
      { metadataAllocationId: 0n }, { metadataAllocationId: 11n }, { metadataAllocationCgroupId: 0n }, { metadataReferences: 0n }]) {
      expect(decodeWorkerBindingRetirement(36, { ...raw, ...patch })).toBeUndefined();
    }
    expect(decodeWorkerBindingRetirement(35, raw)).toBeUndefined();
    expect(decodeWorkerBindingRetirement(36, { ...raw, bindingsBefore: 26 })).toBeUndefined();
    expect(decodeWorkerBindingRetirement(36, { ...raw, metadataReferences: 2n })).toMatchObject({ metadata: { references: 2n } });
  });
});
