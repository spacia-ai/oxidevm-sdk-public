import { VMError } from "../errors.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import type { IoUringCallSource } from "../userspace-abi.js";
import { decodeUserspaceWorkerFailure } from "./userspace-worker-failure.js";
import { decodeUserspaceRegistrationFailure } from "./userspace-registration-failure.js";
import { decodeUserspaceFinalizationFailure, finalizationFailureDetail } from "./userspace-finalization-failure.ts";

export function throwIfUserspaceKernelFailed(runtime: {
  readonly instance: Pick<WebAssembly.Instance, "exports">; readonly memory: WebAssembly.Memory;
}): void {
  if (call(runtime.instance, "oxidevm_userspace_kernel_failure_read") !== 0) throw malformed();
  const pointer = call(runtime.instance, "oxidevm_userspace_kernel_failure_ptr");
  const length = call(runtime.instance, "oxidevm_userspace_kernel_failure_len");
  if (length === 0) return;
  if ((length !== 64 && length !== 256) || pointer + length > runtime.memory.buffer.byteLength) throw malformed();
  const bytes = new Uint8Array(runtime.memory.buffer, pointer, length);
  if (length === 64) {
    const failure = decodeUserspaceWorkerFailure(bytes);
    throw new VMError("VM_FAULT", "Userspace I/O worker failed", {
      reason: "io-worker-failure", pid: failure.pid, tid: failure.tid,
      stage: failure.stage, errno: failure.errno, guestTicks: failure.guestTicks.toString(),
      ...(failure.work === undefined ? {} : { poolId: failure.work.poolId.toString(), workSequence: failure.work.sequence.toString() }),
    });
  }
  if (new TextDecoder().decode(bytes.subarray(0, 4)) === "OXFF") {
    const failure = decodeUserspaceFinalizationFailure(bytes);
    throw new VMError("VM_FAULT", "Userspace ring resource cleanup failed", finalizationFailureDetail(failure));
  }
  const failure = decodeUserspaceRegistrationFailure(bytes);
  const enter = failure.source.number === 426n;
  throw new VMError("VM_FAULT", enter ? "Userspace I/O submission failed" : "Userspace I/O registration failed", {
    reason: enter ? "io-enter-failure" : "io-registration-failure", phase: failure.phase, cause: failure.reason,
    source: sourceDetail(failure.source), guestTicks: failure.guestTicks.toString(),
    ...(failure.peer === undefined ? {} : { peer: sourceDetail(failure.peer) }),
    ...(failure.openFile === undefined ? {} : { openFile: failure.openFile.toString() }),
    ...(failure.errno === undefined ? {} : { errno: failure.errno }),
  });
}

function sourceDetail(source: IoUringCallSource<bigint>) {
  return { pid: source.pid, tid: source.tid, guestTicks: source.guestTicks.toString(),
    number: source.number.toString(), arguments: source.arguments.map(value => value.toString()),
    instructionRip: source.instructionRip.toString(), nextRip: source.nextRip.toString(),
    addressSpace: source.addressSpace.toString() };
}

function malformed(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace kernel I/O failure record is malformed");
}
