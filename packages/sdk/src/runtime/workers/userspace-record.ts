import { protocol } from "../js-process/codec.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import { readFileRecord } from "./userspace-files.js";

interface Binding { readonly instance: Pick<WebAssembly.Instance, "exports">; readonly memory: WebAssembly.Memory }

/** Stages an optional request and copies one record from Rust before another call can replace it. */
export function callUserspaceRecord(runtime: Binding, name: string, bytes?: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes !== undefined) {
    if (call(runtime.instance, "oxidevm_userspace_staging_resize", bytes.byteLength) !== 0) protocol("JS staging allocation failed");
    new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), bytes.byteLength).set(bytes);
  }
  if (call(runtime.instance, name, ...(bytes === undefined ? [] : [bytes.byteLength])) !== 0) protocol(`Native JS operation ${name} failed`);
  return readFileRecord(runtime);
}
