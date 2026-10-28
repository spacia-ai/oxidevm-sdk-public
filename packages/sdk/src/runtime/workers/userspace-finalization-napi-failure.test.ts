import { describe, expect, it } from "vitest";
import { VMError } from "../errors.ts";
import { decodeUserspaceFinalizationFailure } from "./userspace-finalization-failure.ts";
import { throwIfUserspaceKernelFailed } from "./userspace-io-failure.ts";

function failure(phase: 15 | 16 | 17): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(256), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXFF")); view.setUint16(4, 4, true); view.setUint16(6, 256, true);
  view.setBigUint64(8, 99n, true); bytes[16] = 2; bytes[17] = 1; bytes[18] = 1;
  view.setInt32(20, 5, true);
  for (const [field, value] of [[24, 7n], [32, 8n], [40, 91n], [64, 50n], [88, 3n],
    [144, 0x1000n], [152, 0x1002n], [160, 1n]] as const) view.setBigUint64(field, value, true);
  bytes[48] = 1; view.setUint32(52, 2, true); view.setUint32(56, 2, true);
  bytes[184] = 6; bytes[185] = phase; bytes[186] = phase === 17 ? 0 : 1;
  view.setUint32(208, 257, true);
  if (phase !== 17) view.setUint32(216, 5, true);
  if (phase === 15) {
    view.setUint32(212, 128, true); view.setUint32(220, 0xffff_ffff, true);
    view.setBigUint64(224, 6000n, true);
  } else if (phase === 16) {
    view.setBigUint64(232, 57n, true); view.setBigUint64(240, 92n, true);
  }
  return bytes;
}

describe("NAPI finalization failure4", () => {
  it("retains the exact ID and original metadata count without requiring a trace", () => {
    expect(decodeUserspaceFinalizationFailure(failure(15))).toMatchObject({ stage: "resource", progress: {
      kind: "napi", phase: "napi-id", originalEntries: 257, idsBefore: 128, metadataPagesBefore: 5,
      napiId: 0xffff_ffff, expiryJiffies: 6000n,
    } });
  });

  it("retains allocation ownership independently of the current CPU account", () => {
    const bytes = failure(16), view = new DataView(bytes.buffer);
    view.setBigUint64(232, 0xffff_ffff_ffff_ffffn, true);
    expect(decodeUserspaceFinalizationFailure(bytes)).toMatchObject({ identity: { cpuCgroupId: 91n }, progress: {
      kind: "napi", phase: "napi-metadata", metadataAllocationId: 0xffff_ffff_ffff_ffffn, allocationCgroupId: 92n,
    } });
    expect(decodeUserspaceFinalizationFailure(failure(17))).toMatchObject({ progress: {
      kind: "napi", phase: "napi-owner", originalEntries: 257,
    } });
  });

  it.each([15, 16, 17] as const)("reports a JSON-safe VM fault for phase %i", phase => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(memory.buffer, 32, 256).set(failure(phase));
    const runtime = { memory, instance: { exports: {
      oxidevm_userspace_kernel_failure_read: () => 0,
      oxidevm_userspace_kernel_failure_ptr: () => 32,
      oxidevm_userspace_kernel_failure_len: () => 256,
    } } } satisfies Parameters<typeof throwIfUserspaceKernelFailed>[0];
    try {
      throwIfUserspaceKernelFailed(runtime);
    } catch (error: unknown) {
      if (!(error instanceof VMError)) throw error;
      expect(error.code).toBe("VM_FAULT");
      expect(() => JSON.stringify(error.detail)).not.toThrow();
      if (phase === 15) expect(error.detail).toMatchObject({ progress: { expiryJiffies: "6000" } });
      if (phase === 16) expect(error.detail).toMatchObject({ progress: { metadataAllocationId: "57", allocationCgroupId: "92" } });
      return;
    }
    throw new Error("Expected the canonical NAPI failure");
  });

  it.each([15, 16, 17] as const)("rejects falsely downgraded headers and reserved bytes for phase %i", phase => {
    for (const version of [1, 2, 3]) {
      const bytes = failure(phase); new DataView(bytes.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
    for (const field of [187, 188, 190, 192, 199, 200, 207, 248, 255]) {
      const bytes = failure(phase); bytes[field] = 1;
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
  });
});
