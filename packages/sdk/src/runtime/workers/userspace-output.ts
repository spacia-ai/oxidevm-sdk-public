import { VMError } from "../errors.js";
import { STREAM_HIGH_WATER_BYTES } from "../guest-process.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";

type Stream = "stdout" | "stderr";
interface Runtime {
  readonly instance: Pick<WebAssembly.Instance, "exports">;
  readonly memory: WebAssembly.Memory;
}

/** Rust retains each prefix until the consumer acknowledges its delivery. */
export function readUserspaceOutput(runtime: Runtime, pid: number, stream: Stream): Uint8Array {
  const pointer = call(runtime.instance, `oxidevm_userspace_process_${stream}_ptr`, pid);
  const length = call(runtime.instance, `oxidevm_userspace_${stream}_len`);
  if (length > 16 * 1024 * 1024 || pointer + length > runtime.memory.buffer.byteLength) {
    throw new VMError("PROTOCOL_ERROR", `Userspace ${stream} buffer is invalid`);
  }
  return new Uint8Array(runtime.memory.buffer, pointer, Math.min(length, STREAM_HIGH_WATER_BYTES)).slice();
}

export function acknowledgeUserspaceOutput(runtime: Runtime, pid: number, stream: Stream, count: number): void {
  const status = call(runtime.instance, "oxidevm_userspace_process_output_acknowledge", pid, stream === "stdout" ? 0 : 1, count);
  if (status !== 0) throw new VMError("GUEST_CRASH", `Userspace output acknowledgement failed with status ${status}`);
}
