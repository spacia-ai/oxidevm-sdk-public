import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { engineModulePath } from "../engine-wasm.test-support.js";
import { instantiateRuntime } from "../userspace-runtime.js";
import { callUserspaceU32 as call } from "../userspace-exports.js";
import { readFileRecord } from "../userspace-files.js";
import { admitJSProcess } from "./admission.js";
import { decodeUserspaceHostRequest, decodeUserspaceWaitStatus } from "../../userspace-abi.js";
import { decodeJSCompletion, encodeJSRequest, type JSProcessIdentity } from "../../js-process/native-abi.js";
import { LinuxError, type LinuxOperation } from "../../js-process/codec.js";
import { decodeCommandNotice, encodeCommandNoticeRequest } from "../../userspace-command-abi.js";
import type { ModuleReach } from "../../../wasm/reach.js";

/**
 * One JS process admitted in the real Userspace engine (OXIDEVM_ENGINE_DIR), with the test playing its worker: `submit`
 * stages an OXJR request, `completion` takes Rust's answer, `notice` the next OXCS caught-signal notice.
 */
export async function fixture(args: readonly string[] = [], reach?: ModuleReach) {
  const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
  const module = await WebAssembly.compile(bytes.buffer);
  const runtime = await instantiateRuntime(module, "js-bridge-core-test", { kind: "disabled" });
  const stage = (bytes: Uint8Array) => { expect(call(runtime.instance, "oxidevm_userspace_staging_resize", bytes.byteLength)).toBe(0); new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), bytes.byteLength).set(bytes); };
  stage(new Uint8Array()); expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", 0, 1, 128)).toBe(0);
  // A module process's refusals are traced; the trace is configured while no command is active.
  if (reach !== undefined) expect(call(runtime.instance, "oxidevm_userspace_js_trace_configure", 64)).toBe(0);
  const pid = admitJSProcess(runtime, 1, args, [], "/workspace", undefined, reach);
  expect(call(runtime.instance, "oxidevm_userspace_host_request_next", 8)).toBe(0);
  const length = call(runtime.instance, "oxidevm_userspace_host_request_len"), pointer = call(runtime.instance, "oxidevm_userspace_host_request_ptr");
  const request = decodeUserspaceHostRequest(new Uint8Array(runtime.memory.buffer, pointer, length).slice());
  if (request.kind !== "command") throw new Error("Expected a JS process launch");
  expect(request.pid).toBe(pid);
  const submit = (sequence: number, operation: number, payload: Uint8Array = new Uint8Array(), identity: JSProcessIdentity = request) => {
    const bytes = encodeJSRequest(identity, sequence, operation, payload); stage(bytes); expect(call(runtime.instance, "oxidevm_userspace_js_submit", bytes.byteLength)).toBe(0);
    const result = readFileRecord(runtime); expect(result.byteLength).toBe(4); return new DataView(result.buffer).getUint32(0, true);
  };
  const completion = () => { expect(call(runtime.instance, "oxidevm_userspace_js_next")).toBe(0); const bytes = readFileRecord(runtime); return bytes.byteLength === 0 ? undefined : decodeJSCompletion(bytes); };
  /** Command operation 6: the next caught-signal notice (OXCS 2), or null. */
  const notice = () => { const take = encodeCommandNoticeRequest(); stage(take); expect(call(runtime.instance, "oxidevm_userspace_command", take.byteLength)).toBe(0); return decodeCommandNotice(readFileRecord(runtime)); };
  const waitStatus = () => decodeUserspaceWaitStatus(call(runtime.instance, "oxidevm_userspace_process_wait_status", pid));
  return { runtime, request, pid, stage, submit, completion, notice, waitStatus };
}

/** Runs requests through the production builders and decoders, so a wrong byte or a wrong reply shape fails here. */
export function operations(f: Awaited<ReturnType<typeof fixture>>) {
  let sequence = 0;
  /** Submits the next request and returns its raw completion, for a request whose effect matters more than its reply. */
  const complete = (request: LinuxOperation<unknown>) => {
    sequence += 1;
    expect(f.submit(sequence, request.number, request.payload)).toBe(0);
    return f.completion();
  };
  const send = <T>(request: LinuxOperation<T>): T => {
    const reply = complete(request); if (reply === undefined) throw new Error(`Operation ${String(request.number)} did not complete`);
    if (reply.errno !== 0) throw new LinuxError(reply.errno);
    return request.decode({ value: reply.value, bytes: reply.payload });
  };
  /** The errno of a request that fails; 0 when it succeeds. */
  const failure = (request: LinuxOperation<unknown>): number => { try { send(request); } catch (error: unknown) { return error instanceof LinuxError ? error.errno : -1; } return 0; };
  return { send, failure, complete };
}

