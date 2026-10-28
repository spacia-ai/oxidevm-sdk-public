import { VMError } from "../errors.js";
import { MAX_USERSPACE_SYSCALL_TRACE_BYTES } from "../userspace-abi.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";

export function readUserspaceSyscallTrace(
  runtime: { readonly instance: Pick<WebAssembly.Instance, "exports">; readonly memory: WebAssembly.Memory },
  mode: "snapshot" | "drain" = "snapshot",
): Uint8Array {
  const operation = mode === "drain" ? "oxidevm_userspace_syscall_trace_drain" : "oxidevm_userspace_syscall_trace_snapshot";
  const status = call(runtime.instance, operation);
  if (status !== 0) throw new VMError("GUEST_CRASH", `Userspace Wasm ${operation} failed with status ${status}`);
  const pointer = call(runtime.instance, "oxidevm_userspace_syscall_trace_ptr");
  const length = call(runtime.instance, "oxidevm_userspace_syscall_trace_len");
  if (length < 24 || length > MAX_USERSPACE_SYSCALL_TRACE_BYTES || pointer + length > runtime.memory.buffer.byteLength) {
    throw new VMError("PROTOCOL_ERROR", "Userspace syscall trace export is invalid");
  }
  return new Uint8Array(runtime.memory.buffer, pointer, length).slice();
}
