import { VMError } from "../../errors.js";
import { encodeUserspaceArguments } from "../../userspace-abi.js";
import { callUserspaceU32 as call, assertUserspaceStatus } from "../userspace-exports.js";
import { readFileRecord } from "../userspace-files.js";
import { decodeProcessId } from "../../../values.js";

export function admitJSProcess(runtime: { readonly instance: WebAssembly.Instance; readonly memory: WebAssembly.Memory }, token: number, args: readonly string[], env: readonly string[], cwd: string, terminal?: { readonly columns: number; readonly rows: number }): number {
  const argumentsRecord = encodeUserspaceArguments(args), environmentRecord = encodeUserspaceArguments(env), cwdRecord = new TextEncoder().encode(cwd);
  const length = argumentsRecord.byteLength + environmentRecord.byteLength + cwdRecord.byteLength;
  assertUserspaceStatus(call(runtime.instance, "oxidevm_userspace_staging_resize", length), "JS process staging");
  const staging = new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), length);
  staging.set(argumentsRecord); staging.set(environmentRecord, argumentsRecord.byteLength); staging.set(cwdRecord, argumentsRecord.byteLength + environmentRecord.byteLength);
  assertUserspaceStatus(call(runtime.instance, "oxidevm_userspace_spawn_js_process", token, argumentsRecord.byteLength, environmentRecord.byteLength, cwdRecord.byteLength, terminal?.columns ?? 0, terminal?.rows ?? 0), "JS process admission");
  const result = readFileRecord(runtime);
  if (result.byteLength !== 8) throw new VMError("PROTOCOL_ERROR", "Invalid JS process admission record");
  const view = new DataView(result.buffer), errno = view.getUint32(0, true), pid = view.getUint32(4, true);
  if (errno !== 0) {
    if (pid !== 0 || errno > 4095) throw new VMError("PROTOCOL_ERROR", "Invalid failed JS admission identity");
    const code = errno === 11 || errno === 12 ? "QUOTA_EXCEEDED" : errno === 95 ? "FEATURE_NOT_AVAILABLE" : errno === 1 || errno === 13 ? "PERMISSION_DENIED" : "INVALID_ARGUMENT";
    throw new VMError(code, `Rust JS process admission failed with errno ${errno}`, { errno });
  }
  return decodeProcessId(pid);
}
