import { describe, expect, it } from "vitest";
import { decodeUserspaceFinalizationFailure } from "./userspace-finalization-failure.ts";
import { throwIfUserspaceKernelFailed } from "./userspace-io-failure.ts";
import { VMError } from "../errors.ts";

function failure(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(256), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXFF")); view.setUint16(4, 3, true); view.setUint16(6, 256, true);
  view.setBigUint64(8, 99n, true); bytes[16] = 2; bytes[17] = 1; bytes[18] = 1;
  view.setInt32(20, 5, true);
  for (const [field, value] of [[24, 7n], [32, 8n], [40, 91n], [64, 50n], [88, 3n],
    [144, 0x1000n], [152, 0x1002n], [160, 1n], [192, 57n], [200, 92n], [208, 0x1234n]] as const) view.setBigUint64(field, value, true);
  bytes[48] = 1; view.setUint32(52, 2, true); view.setUint32(56, 2, true);
  bytes[184] = 5; bytes[185] = 13; bytes[186] = 1;
  view.setUint16(188, 9, true); view.setUint16(190, 7, true);
  for (const [field, value] of [[216, 4], [220, 257], [224, 1], [228, 257], [232, 2]] as const) view.setUint32(field, value, true);
  return bytes;
}

describe("provided-buffer finalization failure3", () => {
  it("retains the actual allocation, buffer geometry and closing authority", () => {
    expect(decodeUserspaceFinalizationFailure(failure())).toMatchObject({
      stage: "resource", errno: 5, identity: { cpuCgroupId: 91n }, progress: {
        kind: "provided-buffers", phase: "provided-run", groupId: 9, firstId: 7,
        address: 0x1234n, length: 4, count: 257, runsBefore: 1, buffersBefore: 257,
        groupsBefore: 2, metadataAllocationId: 57n, allocationCgroupId: 92n,
      },
    });
  });

  it("distinguishes an empty group from the final ring owner", () => {
    const bytes = failure(), view = new DataView(bytes.buffer);
    bytes[185] = 14; bytes.fill(0, 190, 192); bytes.fill(0, 208, 232);
    expect(decodeUserspaceFinalizationFailure(bytes)).toMatchObject({ progress: {
      kind: "provided-buffers", phase: "provided-group", groupId: 9,
      groupsBefore: 2, metadataAllocationId: 57n, allocationCgroupId: 92n,
    } });
    view.setBigUint64(192, 0n, true);
    expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
  });

  it("retains a JSON-safe VM fault without requiring an enabled trace", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(memory.buffer, 32, 256).set(failure());
    const runtime = { memory, instance: { exports: {
      oxidevm_userspace_kernel_failure_read: () => 0,
      oxidevm_userspace_kernel_failure_ptr: () => 32,
      oxidevm_userspace_kernel_failure_len: () => 256,
    } } };
    try {
      throwIfUserspaceKernelFailed(runtime);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(VMError);
      if (!(error instanceof VMError)) throw error;
      expect(error.code).toBe("VM_FAULT");
      expect(() => JSON.stringify(error.detail)).not.toThrow();
      expect(error.detail).toMatchObject({ progress: {
        metadataAllocationId: "57", allocationCgroupId: "92", address: "4660",
      } });
      return;
    }
    throw new Error("Expected the canonical finalization failure");
  });

  it("rejects forged legacy headers and unclaimed tail bytes", () => {
    for (const version of [1, 2]) {
      const bytes = failure(); new DataView(bytes.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
    for (const at of [187, 236, 240, 247, 248, 255]) {
      const bytes = failure(); bytes[at] = 1;
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
  });
});
