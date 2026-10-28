import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { engineModulePath } from "../engine-wasm.test-support.js";
import { instantiateRuntime } from "../userspace-runtime.js";
import { callUserspaceU32 as call } from "../userspace-exports.js";
import { readFileRecord } from "../userspace-files.js";
import { admitJSProcess } from "./admission.js";
import { decodeUserspaceHostRequest, decodeUserspacePendingWork } from "../../userspace-abi.js";
import { decodeJSCompletion, encodeJSRequest, type JSProcessIdentity } from "../../js-process/native-abi.js";
import { VMError } from "../../errors.js";
import { Writer, decodeJSIdentity } from "../../js-process/codec.js";
import { encodeCommandExit } from "../../userspace-command-abi.js";
import { decodeSpawn, spawnPayload } from "../../js-process/process.js";
import { traceRingElf } from "../userspace-tier2.test-support.js";

async function fixture() {
  const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
  const module = await WebAssembly.compile(bytes.buffer);
  const runtime = await instantiateRuntime(module, "js-bridge-core-test", { kind: "disabled" });
  const stage = (bytes: Uint8Array) => { expect(call(runtime.instance, "oxidevm_userspace_staging_resize", bytes.byteLength)).toBe(0); new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), bytes.byteLength).set(bytes); };
  stage(new Uint8Array()); expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", 0, 1, 128)).toBe(0);
  const pid = admitJSProcess(runtime, 1, [], [], "/workspace");
  expect(call(runtime.instance, "oxidevm_userspace_host_request_next", 8)).toBe(0);
  const length = call(runtime.instance, "oxidevm_userspace_host_request_len"), pointer = call(runtime.instance, "oxidevm_userspace_host_request_ptr");
  const request = decodeUserspaceHostRequest(new Uint8Array(runtime.memory.buffer, pointer, length).slice());
  if (request.kind !== "command") throw new Error("Expected a JS process launch");
  expect(request.pid).toBe(pid);
  const submit = (sequence: number, operation: number, payload = new Uint8Array(), identity: JSProcessIdentity = request) => {
    const bytes = encodeJSRequest(identity, sequence, operation, payload); stage(bytes); expect(call(runtime.instance, "oxidevm_userspace_js_submit", bytes.byteLength)).toBe(0);
    const result = readFileRecord(runtime); expect(result.byteLength).toBe(4); return new DataView(result.buffer).getUint32(0, true);
  };
  const completion = () => { expect(call(runtime.instance, "oxidevm_userspace_js_next")).toBe(0); const bytes = readFileRecord(runtime); return bytes.byteLength === 0 ? undefined : decodeJSCompletion(bytes); };
  return { runtime, request, pid, stage, submit, completion };
}

it("uses the live Rust umask for JS mask queries and native file creation", async () => {
  const f = await fixture();
  try {
    expect(f.submit(1, 65547, new Writer().u8(0).finish())).toBe(0);
    expect(f.completion()?.value).toBe(0o022n);
    const malformed = encodeJSRequest(f.request, 2, 65547, new Uint8Array([2])); f.stage(malformed);
    expect(call(f.runtime.instance, "oxidevm_userspace_js_submit", malformed.byteLength)).toBe(1);
    expect(f.submit(2, 65547, new Writer().u8(1).u32(0xffff_ffff).finish())).toBe(0);
    expect(f.completion()?.value).toBe(0o022n);
    expect(f.submit(3, 65547, new Writer().u8(0).finish())).toBe(0);
    expect(f.completion()?.value).toBe(0o777n);
    expect(f.submit(4, 65547, new Writer().u8(1).u32(0o027).finish())).toBe(0);
    expect(f.completion()?.value).toBe(0o777n);
    expect(f.submit(5, 2, new Writer().path("/workspace/mask").u64(0o102).u64(0o666).finish())).toBe(0);
    const opened = f.completion(); if (opened === undefined) throw new Error("Missing open completion");
    expect(opened.errno).toBe(0);
    expect(f.submit(6, 5, new Writer().u64(opened.value).finish())).toBe(0);
    const stat = f.completion(); if (stat === undefined) throw new Error("Missing file stat");
    expect(stat.errno).toBe(0); expect(new DataView(stat.payload.buffer, stat.payload.byteOffset, stat.payload.byteLength).getUint32(24, true) & 0o777).toBe(0o640);
  } finally { await f.runtime.jitRuntime.dispose(); }
});

for (const signal of [15, 9]) it(`publishes a completed native child wait after signal ${String(signal)} before browser reconciliation`, async () => {
  const f = await fixture();
  try {
    const elf = traceRingElf(1); elf.set([0xeb, 0xfe], 120);
    expect(f.submit(1, 2, new Writer().path("/workspace/tool").u64(0o102).u64(0o700).finish())).toBe(0);
    const opened = f.completion(); if (opened === undefined) throw new Error("Missing executable descriptor");
    expect(opened.errno).toBe(0);
    expect(f.submit(2, 1, new Writer().u64(opened.value).blob(elf).finish())).toBe(0);
    expect(f.completion()?.value).toBe(BigInt(elf.byteLength));
    expect(f.submit(3, 3, new Writer().u64(opened.value).finish())).toBe(0);
    expect(f.completion()?.errno).toBe(0);
    expect(call(f.runtime.instance, "oxidevm_userspace_run", 100, 0)).toBe(0);
    expect(f.submit(4, 65538, spawnPayload({ command: "/workspace/tool", args: [] }).finish())).toBe(0);
    const spawned = f.completion(); if (spawned === undefined) throw new Error("Missing child admission");
    expect(spawned.errno).toBe(0); const child = decodeSpawn({ value: spawned.value, bytes: spawned.payload }).pid;
    expect(f.submit(5, 61, new Writer().u32(child).finish())).toBe(0);
    expect(f.completion()).toBeUndefined();
    expect(f.submit(6, 62, new Writer().u32(child).u8(signal).finish())).toBe(0);
    expect(f.completion()?.errno).toBe(0);
    expect(call(f.runtime.instance, "oxidevm_userspace_run", 1000, 0)).toBe(0);
    const pending = decodeUserspacePendingWork(call(f.runtime.instance, "oxidevm_userspace_pending_work"));
    expect(pending.hostRequest).toBe(true);
    const waited = f.completion(); if (waited === undefined) throw new Error("Missing completed child wait");
    expect(waited.sequence).toBe(5); expect(waited.errno).toBe(0); expect(waited.value).toBe(BigInt(signal));
    expect(waited.payload.byteLength).toBe(0);
    expect(decodeUserspacePendingWork(call(f.runtime.instance, "oxidevm_userspace_pending_work")).hostRequest).toBe(false);
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("uses the real Wasm bridge for file offsets, errno, stale identities and malformed records", async () => {
  const f = await fixture();
  try {
    expect(f.submit(1, 2, new Writer().path("/workspace/bridge").u64(0o102).u64(0o600).finish())).toBe(0);
    const opened = f.completion(); expect(opened?.errno).toBe(0); if (opened === undefined) throw new Error("Missing open completion"); const fd = opened.value;
    const invalid = encodeJSRequest(f.request, 2, 1, new Writer().u64(fd).blob(new TextEncoder().encode("wrong")).finish()); new DataView(invalid.buffer).setUint32(4, 99, true); f.stage(invalid);
    expect(call(f.runtime.instance, "oxidevm_userspace_js_submit", invalid.byteLength)).toBe(1);
    expect(f.submit(2, 1, new Writer().u64(fd).blob(new TextEncoder().encode("hello")).finish())).toBe(0); expect(f.completion()?.value).toBe(5n);
    expect(f.submit(2, 1, new Writer().u64(fd).blob(new TextEncoder().encode("replay")).finish())).toBe(22);
    expect(f.submit(3, 8, new Writer().u64(fd).u64(0).u8(0).finish(), decodeJSIdentity(f.request.generation + 1n, f.request.id))).toBe(3);
    expect(f.submit(3, 8, new Writer().u64(fd).u64(0).u8(0).finish())).toBe(0); expect(f.completion()?.value).toBe(0n);
    expect(f.submit(4, 0, new Writer().u64(fd).u64(10).finish())).toBe(0); const read = f.completion(); expect(read?.errno).toBe(0); expect(new TextDecoder().decode(read?.payload)).toBe("hello");
    expect(f.submit(5, 0, new Writer().u64(999).u64(1).finish())).toBe(0); expect(f.completion()?.errno).toBe(9);
    expect(() => f.runtime.checkpoints.beginCapture(new Uint8Array(32))).toThrow();
    const exit = encodeCommandExit(f.request, 125); f.stage(exit); expect(call(f.runtime.instance, "oxidevm_userspace_host_complete", exit.byteLength)).toBe(0);
    expect(call(f.runtime.instance, "oxidevm_userspace_process_wait_status", f.pid)).toBe(125 << 8);
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("revokes an admitted external connection through the same Rust network owner", async () => {
  const f = await fixture();
  try {
    expect(call(f.runtime.instance, "oxidevm_userspace_network_enable")).toBe(0);
    expect(f.submit(1, 41, new Writer().u32(2).finish())).toBe(0); const socket = f.completion(); if (socket === undefined) throw new Error("Missing socket");
    const address = Uint8Array.from([2, 0, 1, 187, 93, 184, 216, 34, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(f.submit(2, 42, new Writer().u64(socket.value).blob(address).finish())).toBe(0); expect(f.completion()).toBeUndefined();
    expect(call(f.runtime.instance, "oxidevm_userspace_host_request_next", 2)).toBe(0); expect(call(f.runtime.instance, "oxidevm_userspace_host_request_len")).toBeGreaterThan(0);
    expect(call(f.runtime.instance, "oxidevm_userspace_network_revoke")).toBe(0);
    expect(f.completion()?.errno).toBe(104);
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("counts JS leaders in native process limits without publishing failed launches", async () => {
  const f = await fixture();
  try {
    expect(call(f.runtime.instance, "oxidevm_userspace_process_limit", 1)).toBe(0);
    try { admitJSProcess(f.runtime, 2, [], [], "/workspace"); throw new Error("Unexpected native process admission"); }
    catch (error) { if (!(error instanceof VMError)) throw error; expect(error.code).toBe("QUOTA_EXCEEDED"); expect(error.detail?.["errno"]).toBe(11); }
    expect(call(f.runtime.instance, "oxidevm_userspace_live_process_count")).toBe(1);
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("delivers live workspace edits to a blocked inotify read through production Wasm", async () => {
  const f = await fixture();
  try {
    expect(f.submit(1, 294, new Writer().u64(0).finish())).toBe(0);
    const opened = f.completion(); if (opened === undefined) throw new Error("Missing inotify descriptor");
    expect(opened.errno).toBe(0);
    expect(f.submit(2, 254, new Writer().u64(opened.value).path("/workspace").u32(0xfc6).finish())).toBe(0);
    expect(f.completion()?.errno).toBe(0);
    expect(f.submit(3, 0, new Writer().u64(opened.value).u64(4096).finish())).toBe(0);
    expect(f.completion()).toBeUndefined();
    const edit = new Writer().u32(1).u8(4).path("/watched.txt").u8(0).blob(new TextEncoder().encode("live edit")).finish(); f.stage(edit);
    expect(call(f.runtime.instance, "oxidevm_userspace_files", edit.length)).toBe(0);
    const event = f.completion(); expect(event?.errno).toBe(0);
    expect(new TextDecoder().decode(event?.payload)).toContain("watched.txt");
    const exit = encodeCommandExit(f.request, 0); f.stage(exit);
    expect(call(f.runtime.instance, "oxidevm_userspace_host_complete", exit.length)).toBe(0);
    expect(f.submit(4, 255, new Writer().u64(opened.value).u32(1).finish())).toBe(3);
  } finally { await f.runtime.jitRuntime.dispose(); }
});
