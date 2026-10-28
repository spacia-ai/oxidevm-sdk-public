import { VMError } from "../../errors.js";
import { assertUserspaceCheckpointStatus, callUserspaceU32, callUserspaceU64 } from "../userspace-exports.js";
import { FRAME_BYTES, invalid } from "./stream.js";
export interface CheckpointRuntime { readonly instance: Pick<WebAssembly.Instance, "exports">; readonly memory: WebAssembly.Memory }
export class CheckpointRaw {
  readonly #runtime: CheckpointRuntime;
  constructor(runtime: CheckpointRuntime) { this.#runtime = runtime; }
  u32(name: string, ...args: readonly (number | bigint)[]): number { return callUserspaceU32(this.#runtime.instance, `oxidevm_userspace_checkpoint_${name}`, ...args); }
  u64(name: string, ...args: readonly (number | bigint)[]): bigint { return callUserspaceU64(this.#runtime.instance, `oxidevm_userspace_checkpoint_${name}`, ...args); }
  ok(name: string, ...args: readonly (number | bigint)[]): void {
    assertUserspaceCheckpointStatus(this.u32(name, ...args), name);
  }
  stage(bytes: Uint8Array): void {
    if (bytes.length > FRAME_BYTES) invalid("Checkpoint staging frame exceeds its bound");
    const status = callUserspaceU32(this.#runtime.instance, "oxidevm_userspace_staging_resize", bytes.length);
    if (status === 4) throw new VMError("STORAGE_ERROR", "Checkpoint recovery is required", { reason: "checkpoint-recovery-required", recoveryRequired: true, status });
    if (status !== 0) throw new VMError("PROTOCOL_ERROR", "Checkpoint staging allocation failed", { status });
    const pointer = callUserspaceU32(this.#runtime.instance, "oxidevm_userspace_staging_ptr");
    if (pointer + bytes.length > this.#runtime.memory.buffer.byteLength) invalid("Checkpoint staging lies outside Wasm memory");
    new Uint8Array(this.#runtime.memory.buffer, pointer, bytes.length).set(bytes);
  }
  frame(): Uint8Array<ArrayBuffer> {
    const pointer = this.u32("frame_ptr"), length = this.u32("frame_len");
    if (length > FRAME_BYTES || pointer + length > this.#runtime.memory.buffer.byteLength) invalid("Checkpoint frame lies outside Wasm memory");
    return new Uint8Array(this.#runtime.memory.buffer, pointer, length).slice();
  }
}
