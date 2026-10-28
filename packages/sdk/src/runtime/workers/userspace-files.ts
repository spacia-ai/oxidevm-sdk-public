import { MAX_AGENT_PAYLOAD_BYTES } from "../agent-protocol.js";
import { VMError } from "../errors.js";
import { decodeUserspaceFileRecord, decodeUserspaceFileRequest, encodeResidentFileRecord } from "../userspace-files.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";

interface FileRuntime { readonly instance: WebAssembly.Instance; readonly memory: WebAssembly.Memory }

export function callNativeFiles(runtime: FileRuntime, request: Uint8Array): Uint8Array<ArrayBuffer> {
  if (call(runtime.instance, "oxidevm_userspace_staging_resize", request.byteLength) !== 0) throw new VMError("PROTOCOL_ERROR", "file request staging failed");
  new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), request.byteLength).set(request);
  if (call(runtime.instance, "oxidevm_userspace_files", request.byteLength) !== 0) throw new VMError("PROTOCOL_ERROR", "native file request failed validation");
  return readFileRecord(runtime);
}

export function readFileRecord(runtime: FileRuntime): Uint8Array<ArrayBuffer> {
  const length = call(runtime.instance, "oxidevm_userspace_file_record_len");
  const pointer = call(runtime.instance, "oxidevm_userspace_staging_ptr");
  if (length > MAX_AGENT_PAYLOAD_BYTES || pointer + length > runtime.memory.buffer.byteLength) throw new VMError("PROTOCOL_ERROR", "native file record is outside memory");
  return new Uint8Array(runtime.memory.buffer, pointer, length).slice();
}

/** Immutable bytes stay in storage; only the verified response is copied to the page. */
export async function executeNativeFiles(runtime: FileRuntime, requestBytes: Uint8Array, readImage: (path: string, sha256: string | null) => Promise<{ readonly sha256: string; readonly bytes: Uint8Array }>, checkCanceled: () => void,
  requestNative?: (request: Uint8Array, checkCanceled: () => void) => Promise<Uint8Array<ArrayBuffer>>): Promise<Uint8Array> {
  const request = decodeUserspaceFileRequest(requestBytes);
  const record = requestNative === undefined ? callNativeFiles(runtime, requestBytes) : await requestNative(requestBytes, checkCanceled);
  checkCanceled();
  const result = decodeUserspaceFileRecord(record, request);
  if (result.operation !== "image") return record;
  const response = await readImage(result.path, result.sha256);
  checkCanceled();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", response.bytes.slice())), byte => byte.toString(16).padStart(2, "0")).join("");
  if (response.bytes.byteLength !== result.entry.size || digest !== response.sha256 || result.sha256 !== null && digest !== result.sha256) throw new VMError("PROTOCOL_ERROR", "immutable workspace file failed integrity verification");
  checkCanceled();
  const current = decodeUserspaceFileRecord(requestNative === undefined ? callNativeFiles(runtime, requestBytes) : await requestNative(requestBytes, checkCanceled), request);
  checkCanceled();
  if (!("entry" in current) || current.entry.version !== result.entry.version) throw new VMError("STORAGE_ERROR", "workspace file changed during its read", { reason: "busy" });
  return encodeResidentFileRecord(request, result.entry, response.bytes);
}
