// Reads the Userspace runtime's listening sockets for the SDK: one Wasm call while the listener
// generation stands still, the whole record when it moved.
import { VMError } from "../errors.js";
import { callUserspaceU32, callUserspaceU64 } from "./userspace-exports.js";

const UNREADABLE = 0xffff_ffff_ffff_ffffn;

export type UserspaceListenerRead =
  | { readonly kind: "none" }
  | { readonly kind: "unchanged"; readonly generation: bigint }
  | { readonly kind: "listeners"; readonly record: Uint8Array };

export function readUserspaceListeners(
  runtime: { readonly instance: Pick<WebAssembly.Instance, "exports">; readonly memory: WebAssembly.Memory } | undefined,
  known: bigint | null,
): UserspaceListenerRead {
  if (runtime === undefined) return { kind: "none" };
  const generation = callUserspaceU64(runtime.instance, "oxidevm_userspace_listener_generation");
  if (generation === UNREADABLE) throw new VMError("GUEST_CRASH", "Userspace listeners are unreadable");
  if (known !== null && generation === known) return { kind: "unchanged", generation };
  if (callUserspaceU32(runtime.instance, "oxidevm_userspace_listeners") !== 0) {
    throw new VMError("GUEST_CRASH", "Userspace listeners could not be encoded");
  }
  const pointer = callUserspaceU32(runtime.instance, "oxidevm_userspace_listeners_ptr");
  const length = callUserspaceU32(runtime.instance, "oxidevm_userspace_listeners_len");
  if (pointer + length > runtime.memory.buffer.byteLength) {
    throw new VMError("PROTOCOL_ERROR", "Userspace listener record is outside memory");
  }
  return { kind: "listeners", record: new Uint8Array(runtime.memory.buffer, pointer, length).slice() };
}
