import { describe, expect, it } from "vitest";
import { decodeUserspaceWorkerFailure } from "./userspace-worker-failure.js";
import { throwIfUserspaceKernelFailed } from "./userspace-io-failure.js";
import { VMError } from "../errors.js";

function failure(operation: () => void): VMError {
  try { operation(); } catch (error: unknown) {
    if (error instanceof VMError) return error;
    throw error;
  }
  throw new Error("Expected a typed runtime failure");
}

function record(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(64), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXWF")); view.setUint16(4, 1, true); view.setUint16(6, 64, true);
  view.setUint32(8, 7, true); view.setUint32(12, 8, true);
  view.setBigUint64(16, 9n, true); view.setBigUint64(24, 10n, true);
  view.setInt32(32, 5, true); bytes[36] = 3; view.setBigUint64(40, 51n, true);
  return bytes;
}

describe("kernel worker failure reporting", () => {
  it.each([[9, "issuer-selection"], [10, "issuer-operation"], [11, "issuer-publication"],
    [12, "issuer-notification"], [13, "issuer-retirement"]] as const)(
    "identifies the v4 issuer boundary %s and rejects its use in v3", (stage, name) => {
      const bytes = record(); bytes[4] = 4; bytes[36] = stage;
      expect(decodeUserspaceWorkerFailure(bytes)).toMatchObject({ stage: name,
        work: { poolId: 9n, sequence: 10n } });
      if (stage === 9) {
        bytes.fill(0, 16, 32);
        expect(decodeUserspaceWorkerFailure(bytes)).toMatchObject({ stage: name, work: undefined });
      } else {
        const missing = bytes.slice(); missing.fill(0, 16, 32);
        expect(() => decodeUserspaceWorkerFailure(missing)).toThrow();
      }
      bytes[4] = 3;
      expect(() => decodeUserspaceWorkerFailure(bytes)).toThrow();
    });
  it.each([[6, "idle-selection"], [7, "idle-commit"], [8, "admission"]] as const)("identifies v3 stage %s without inventing a work request", (stage, name) => {
    const bytes = record(); bytes[4] = 3; bytes[36] = stage; bytes.fill(0, 16, 32);
    expect(decodeUserspaceWorkerFailure(bytes)).toMatchObject({ stage: name, work: undefined });
    bytes[4] = 2;
    expect(() => decodeUserspaceWorkerFailure(bytes)).toThrow();
  });

  it("identifies a v2 readiness failure without inventing a request result", () => {
    const bytes = record(); bytes[4] = 2; bytes[36] = 5;
    expect(decodeUserspaceWorkerFailure(bytes)).toMatchObject({ stage: "readiness", work: { poolId: 9n, sequence: 10n } });
  });

  it("decodes the typed stage, errno and canonical work identity", () => {
    expect(decodeUserspaceWorkerFailure(record())).toEqual({
      pid: 7, tid: 8, work: { poolId: 9n, sequence: 10n }, stage: "request", errno: 5, guestTicks: 51n,
    });
    const bytes = record(); bytes.fill(0, 16, 32); bytes[36] = 1;
    expect(decodeUserspaceWorkerFailure(bytes)).toMatchObject({ stage: "selection", work: undefined });
  });

  it("rejects unsupported versions, incomplete identity and reserved or invalid fields", () => {
    for (const [offset, value] of [[0, 0], [4, 5], [6, 63], [8, 0], [12, 0], [16, 0], [24, 0], [32, 0], [36, 0], [36, 5], [37, 1], [63, 1]] as const) {
      const bytes = record(); bytes[offset] = value;
      expect(() => decodeUserspaceWorkerFailure(bytes)).toThrow();
    }
    expect(() => decodeUserspaceWorkerFailure(record().subarray(1))).toThrow();
  });

  it("reports an internal VM fault while preserving the guest exit distinction", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(memory.buffer, 32, 64).set(record());
    const runtime = { memory, instance: { exports: {
      oxidevm_userspace_kernel_failure_read: () => 0,
      oxidevm_userspace_kernel_failure_ptr: () => 32,
      oxidevm_userspace_kernel_failure_len: () => 64,
    } } };
    const error = failure(() => throwIfUserspaceKernelFailed(runtime));
    expect(error.code).toBe("VM_FAULT");
    expect(error.detail).toEqual({ reason: "io-worker-failure", pid: 7, tid: 8, stage: "request", errno: 5, guestTicks: "51", poolId: "9", workSequence: "10" });
    expect(() => throwIfUserspaceKernelFailed({ ...runtime, instance: { exports: { ...runtime.instance.exports, oxidevm_userspace_kernel_failure_len: () => 0 } } })).not.toThrow();
    expect(failure(() => throwIfUserspaceKernelFailed({ ...runtime, instance: { exports: { ...runtime.instance.exports, oxidevm_userspace_kernel_failure_ptr: () => 65_520 } } })).code).toBe("PROTOCOL_ERROR");
  });
});
