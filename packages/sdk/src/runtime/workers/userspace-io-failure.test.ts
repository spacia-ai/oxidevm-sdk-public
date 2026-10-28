import { describe, expect, it } from "vitest";
import { throwIfUserspaceKernelFailed } from "./userspace-io-failure.js";
import { putSource, record } from "./userspace-registration-failure.fixtures.js";
import { VMError } from "../errors.js";

function failure(operation: () => void): VMError {
  try { operation(); } catch (error: unknown) {
    if (error instanceof VMError) return error;
    throw error;
  }
  throw new Error("Expected a typed kernel failure");
}

describe("canonical kernel I/O failure bridge", () => {
  it("reports enter provenance as an enter fault", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const bytes = record(), view = new DataView(bytes.buffer);
    view.setUint16(4, 5, true);
    putSource(view, 8, 426n, 8);
    new Uint8Array(memory.buffer, 32, 256).set(bytes);
    const runtime = { memory, instance: { exports: {
      oxidevm_userspace_kernel_failure_read: () => 0,
      oxidevm_userspace_kernel_failure_ptr: () => 32,
      oxidevm_userspace_kernel_failure_len: () => 256,
    } } };
    const error = failure(() => throwIfUserspaceKernelFailed(runtime));
    expect(error.code).toBe("VM_FAULT");
    expect(error.detail).toMatchObject({ reason: "io-enter-failure", phase: "mutex", cause: "not-owner", source: { number: "426" } });
  });

  it("reports registration provenance without turning it into a guest exit", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(memory.buffer, 32, 256).set(record());
    const runtime = { memory, instance: { exports: {
      oxidevm_userspace_kernel_failure_read: () => 0,
      oxidevm_userspace_kernel_failure_ptr: () => 32,
      oxidevm_userspace_kernel_failure_len: () => 256,
    } } };
    const error = failure(() => throwIfUserspaceKernelFailed(runtime));
    expect(error.code).toBe("VM_FAULT");
    expect(error.detail).toMatchObject({ reason: "io-registration-failure", phase: "mutex", cause: "not-owner", errno: 5,
      source: { pid: 7, tid: 8, number: "427", addressSpace: "11", guestTicks: "41" }, guestTicks: "51" });
    expect(() => throwIfUserspaceKernelFailed({ ...runtime, instance: { exports: { ...runtime.instance.exports,
      oxidevm_userspace_kernel_failure_len: () => 0 } } })).not.toThrow();
    for (const exports of [
      { ...runtime.instance.exports, oxidevm_userspace_kernel_failure_ptr: () => 65_520 },
      { ...runtime.instance.exports, oxidevm_userspace_kernel_failure_len: () => 255 },
      { ...runtime.instance.exports, oxidevm_userspace_kernel_failure_read: () => 2 },
    ]) expect(failure(() => throwIfUserspaceKernelFailed({ memory, instance: { exports } })).code).toBe("PROTOCOL_ERROR");
  });
});
