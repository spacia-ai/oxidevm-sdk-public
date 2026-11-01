import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { engineModulePath } from "../engine-wasm.test-support.js";
import { instantiateRuntime } from "../userspace-runtime.js";
import { callUserspaceU32 as call } from "../userspace-exports.js";
import { readFileRecord } from "../userspace-files.js";
import { admitJSProcess } from "./admission.js";
import { UserspaceHostService } from "../userspace-host-service.js";
import { decodeUserspaceHostRequest, decodeUserspacePendingWork, decodeUserspaceWaitStatus } from "../../userspace-abi.js";
import { decodeJSCompletion, encodeJSRequest, type JSProcessIdentity } from "../../js-process/native-abi.js";
import { VMError } from "../../errors.js";
import { JS_PROCESS_PROTOCOL_VERSION, LinuxError, Writer, decodeJSIdentity, descriptor, noValue, operation, value, type LinuxOperation } from "../../js-process/codec.js";
import { files } from "../../js-process/file-operations.js";
import { encodeAddress } from "../../js-process/sockets.js";
import type { FileDescriptor } from "../../../js-process-types.js";
import { decodeCommandNotice, encodeCommandExit, encodeCommandNoticeRequest, encodeCommandSignalExit } from "../../userspace-command-abi.js";
import { dispositionOperation } from "../../js-process/signals.js";
import { decodeSpawn, spawnPayload } from "../../js-process/process.js";
import { traceRingElf } from "../userspace-tier2.test-support.js";
import { record } from "../../decode.js";
import type { PipeJSProcessSpec, ProcessHandle } from "../../../contracts.js";
import { decodeProcessId } from "../../../values.js";
import type { RunnerHostLaunch } from "../../js-process/launch.js";
import { JsProcessWorkers } from "./driver.js";
import { moduleHandle } from "../../../wasm/handle.js";
import { spawnModule } from "../../../wasm/spawn.js";
import { parseLaunchArgument } from "../../../wasm/runner/descriptor.js";
import { buildRelease, COMMAND_DECLARATION } from "../../../wasm/runner/fixtures.test-support.js";

/** spawnModule's start as the VM's owner record receives it: the process spec and the runner's launch. */
const owner = vi.hoisted(() => ({ start: vi.fn<(vm: object, spec: PipeJSProcessSpec, launch: RunnerHostLaunch) => Promise<ProcessHandle>>() }));
vi.mock("../../../vm-adapter.js", () => ({ spawnOwnedModuleProcess: owner.start }));
afterEach(() => { vi.unstubAllGlobals(); owner.start.mockReset(); });

/** A dedicated worker that records the start message the driver sends it. */
class StartedWorker {
  static latest: StartedWorker | undefined;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  bootstrap: Readonly<Record<string, unknown>> = {};
  port: MessagePort | undefined;
  constructor() { StartedWorker.latest = this; }
  postMessage(value: unknown): void { this.bootstrap = record(value, "start message"); const port = this.bootstrap["port"]; if (port instanceof MessagePort) this.port = port; }
  terminate(): void { this.terminated = true; this.port?.close(); }
}

async function fixture(args: readonly string[] = []) {
  const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
  const module = await WebAssembly.compile(bytes.buffer);
  const runtime = await instantiateRuntime(module, "js-bridge-core-test", { kind: "disabled" });
  const stage = (bytes: Uint8Array) => { expect(call(runtime.instance, "oxidevm_userspace_staging_resize", bytes.byteLength)).toBe(0); new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), bytes.byteLength).set(bytes); };
  stage(new Uint8Array()); expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", 0, 1, 128)).toBe(0);
  const pid = admitJSProcess(runtime, 1, args, [], "/workspace");
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
  /** Command operation 6: the next caught-signal notice (OXCS 1), or null. */
  const notice = () => { const take = encodeCommandNoticeRequest(); stage(take); expect(call(runtime.instance, "oxidevm_userspace_command", take.byteLength)).toBe(0); return decodeCommandNotice(readFileRecord(runtime)); };
  const waitStatus = () => decodeUserspaceWaitStatus(call(runtime.instance, "oxidevm_userspace_process_wait_status", pid));
  return { runtime, request, pid, stage, submit, completion, notice, waitStatus };
}

/** Runs requests through the production builders and decoders, so a wrong byte or a wrong reply shape fails here. */
function operations(f: Awaited<ReturnType<typeof fixture>>) {
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

/** A connected unix stream pair inside one JS process: the connecting end and the accepted end. */
function connectedPair(send: ReturnType<typeof operations>["send"], path: string): { readonly client: FileDescriptor; readonly server: FileDescriptor } {
  const address = encodeAddress({ family: "unix", path });
  const open = () => send(operation(41, new Writer().u32(1), result => descriptor(value(result))));
  const listener = open();
  send(operation(49, new Writer().u64(listener).blob(address), noValue));
  send(operation(50, new Writer().u64(listener).u32(4), noValue));
  const client = open();
  send(operation(42, new Writer().u64(client).blob(address), noValue));
  const server = send(operation(43, new Writer().u64(listener), result => descriptor(value(result))));
  return { client, server };
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

it("serves the SDK's metadata requests (chmod, fchmod, truncate, ftruncate, link, symlink, readlink) to a worker-kind JS process", async () => {
  const f = await fixture();
  try {
    const { send, failure } = operations(f);
    const file = "/workspace/metadata.txt", hard = "/workspace/metadata.link", soft = "/workspace/metadata.sym";
    const fd = send(files.open(file, 0o102, 0o600));
    expect(send(files.write(fd, new TextEncoder().encode("hello world")))).toBe(11);

    send(files.chmod(file, 0o640)); expect(send(files.stat(file)).mode & 0o7777).toBe(0o640);
    send(files.fchmod(fd, 0o604)); expect(send(files.fstat(fd)).mode & 0o7777).toBe(0o604);
    // A mode that still carries the file-type bits is masked, exactly as chmod(2) does.
    send(files.chmod(file, send(files.stat(file)).mode)); expect(send(files.stat(file)).mode & 0o7777).toBe(0o604);
    send(files.truncate(file, 5)); expect(send(files.stat(file)).size).toBe(5n);
    send(files.ftruncate(fd, 3n)); expect(send(files.fstat(fd)).size).toBe(3n);
    send(files.ftruncate(fd, 4096)); expect(send(files.fstat(fd)).size).toBe(4096n);

    send(files.link(file, hard)); expect(send(files.stat(file)).links).toBe(2n);
    expect(send(files.stat(hard)).inode).toBe(send(files.stat(file)).inode);
    send(files.symlink("metadata.txt", soft));
    expect(send(files.readlink(soft))).toBe("metadata.txt");
    expect(send(files.stat(soft, false)).mode & 0o170000).toBe(0o120000);
    expect(send(files.stat(soft)).inode).toBe(send(files.stat(file)).inode);

    expect(failure(files.chmod("/workspace/absent", 0o600))).toBe(2);
    expect(failure(files.truncate("/workspace/absent", 1))).toBe(2);
    expect(failure(files.readlink(file))).toBe(22);
    expect(failure(files.fchmod(999, 0o600))).toBe(9);
    expect(failure(files.link(file, hard))).toBe(17);
    expect(failure(files.symlink("x", soft))).toBe(17);
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("serves utimes (utimensat, 280) to a worker-kind JS process and reads the times back through stat", async () => {
  const f = await fixture();
  try {
    const { send, failure } = operations(f);
    const file = "/workspace/times.txt", soft = "/workspace/times.sym";
    const at = (seconds: number, milliseconds = 0) => new Date(seconds * 1000 + milliseconds);
    const times = (path: string, follow = true) => { const { accessedNs, modifiedNs } = send(files.stat(path, follow)); return { accessedNs, modifiedNs }; };
    send(files.close(send(files.open(file, 0o102, 0o600))));
    send(files.symlink("times.txt", soft));

    send(files.utimes(file, at(10, 5), at(20, 7)));
    expect(times(file)).toEqual({ accessedNs: 10_005_000_000n, modifiedNs: 20_007_000_000n });
    // Setting a time is a change of the inode, so its change time is the moment of the call, not either requested time.
    expect(send(files.stat(file)).changedNs).not.toBe(20_007_000_000n);
    // "omit" leaves exactly that one time alone.
    send(files.utimes(file, "omit", at(30)));
    expect(times(file)).toEqual({ accessedNs: 10_005_000_000n, modifiedNs: 30_000_000_000n });
    send(files.utimes(file, at(40), "omit"));
    expect(times(file)).toEqual({ accessedNs: 40_000_000_000n, modifiedNs: 30_000_000_000n });
    // "now" is the guest clock's current time, which is neither of the earlier values.
    send(files.utimes(file, "now", "now"));
    expect(times(file).accessedNs).not.toBe(40_000_000_000n);
    expect(times(file).modifiedNs).not.toBe(30_000_000_000n);

    // The final link is followed by default and changed itself when asked not to.
    send(files.utimes(soft, at(50), at(60), false));
    expect(times(soft, false)).toEqual({ accessedNs: 50_000_000_000n, modifiedNs: 60_000_000_000n });
    expect(times(file).modifiedNs).not.toBe(60_000_000_000n);
    send(files.utimes(soft, at(70), at(80)));
    expect(times(file)).toEqual({ accessedNs: 70_000_000_000n, modifiedNs: 80_000_000_000n });

    expect(failure(files.utimes("/workspace/absent", at(1), at(1)))).toBe(2);
    expect(failure(files.utimes(file, at(1), at(1), true))).toBe(0);
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("sends with MSG_NOSIGNAL (sendto, 44) so a closed peer is EPIPE and the worker survives, where a plain write ends it with SIGPIPE", async () => {
  const bytes = new TextEncoder().encode("ping");
  for (const noSignal of [true, false]) {
    const f = await fixture();
    try {
      const { send, failure, complete } = operations(f);
      const { client, server } = connectedPair(send, "/workspace/peer.sock");
      // While the peer is there both forms deliver the bytes.
      expect(send(files.write(server, bytes, noSignal))).toBe(4);
      expect(new TextDecoder().decode(send(files.read(client, 16)))).toBe("ping");
      if (noSignal) {
        // MSG_NOSIGNAL only exists for sockets: a regular file says so instead of silently writing.
        const plain = send(files.open("/workspace/plain.txt", 0o102, 0o600));
        expect(failure(files.write(plain, bytes, true))).toBe(88);
      }
      send(files.close(client));
      if (noSignal) {
        expect(failure(files.write(server, bytes, true))).toBe(32);
        expect(failure(files.write(server, bytes, true))).toBe(32);
        expect(send(files.stat("/workspace")).mode & 0o170000).toBe(0o040000);
        expect(call(f.runtime.instance, "oxidevm_userspace_run", 1000, 0)).toBe(0);
        expect(call(f.runtime.instance, "oxidevm_userspace_process_wait_status", f.pid)).toBe(0xffff_ffff);
      } else {
        // The plain write is answered with EPIPE too, and then the pending SIGPIPE ends the worker.
        expect(complete(files.write(server, bytes, false))?.errno).toBe(32);
        expect(call(f.runtime.instance, "oxidevm_userspace_run", 100, 0)).toBe(0);
        expect(call(f.runtime.instance, "oxidevm_userspace_process_wait_status", f.pid)).toBe(13);
      }
    } finally { await f.runtime.jitRuntime.dispose(); }
  }
});

// The documentation states this number (docs/js-process.md, docs/wasm-modules.md and `oxidevm wasm doctor`), so it is measured here:
// JS processes, worker threads, esbuild runs, command interceptors and native addons all draw on one host command lane.
it("admits 32 JS processes at once and refuses the 33rd as a quota error, because the host command lane holds 32 requests", async () => {
  const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
  const runtime = await instantiateRuntime(await WebAssembly.compile(bytes.buffer), "js-lane-core-test", { kind: "disabled" });
  try {
    expect(call(runtime.instance, "oxidevm_userspace_staging_resize", 0)).toBe(0);
    expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", 0, 1, 128)).toBe(0);
    for (let token = 1; token <= 32; token += 1) admitJSProcess(runtime, token, [], [], "/workspace");
    let refusal: unknown;
    try { admitJSProcess(runtime, 33, [], [], "/workspace"); } catch (error: unknown) { refusal = error; }
    expect(refusal).toMatchObject({ code: "QUOTA_EXCEEDED" });
  } finally { await runtime.jitRuntime.dispose(); }
});

it("starts every JS process Rust admitted instead of holding them behind an SDK lane", async () => {
  const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
  const runtime = await instantiateRuntime(await WebAssembly.compile(bytes.buffer), "js-lane-start-core-test", { kind: "disabled" });
  const running = Promise.withResolvers<undefined>();
  try {
    expect(call(runtime.instance, "oxidevm_userspace_staging_resize", 0)).toBe(0);
    expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", 0, 1, 128)).toBe(0);
    for (let token = 1; token <= 8; token += 1) admitJSProcess(runtime, token, [], [], "/workspace");
    const started: bigint[] = [];
    const host = new UserspaceHostService({
      active: () => true,
      take: mask => {
        expect(call(runtime.instance, "oxidevm_userspace_host_request_next", mask)).toBe(0);
        const length = call(runtime.instance, "oxidevm_userspace_host_request_len");
        if (length === 0) return undefined;
        const pointer = call(runtime.instance, "oxidevm_userspace_host_request_ptr");
        return decodeUserspaceHostRequest(new Uint8Array(runtime.memory.buffer, pointer, length).slice());
      },
      // Each process stays running: its request is held until the test ends, as a live JS process holds it until exit.
      service: request => {
        if (request.kind !== "command" || request.program.kind !== "worker") throw new Error("Expected a JS process launch");
        started.push(request.program.token);
        return running.promise;
      },
      settled() {}, failed(error) { throw error; },
    });
    host.pump();
    expect(started).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
    host.cancel();
  } finally { running.resolve(undefined); await runtime.jitRuntime.dispose(); }
});

// Engine ADR 0027: a caught signal reaches the worker as a notice instead of its default action.
it("turns a caught SIGINT into one OXCS notice for its worker and interrupts a pending read with EINTR instead of killing the process", async () => {
  const f = await fixture();
  try {
    // OXJR 65550: SIGINT caught with the interrupt flag and without restart; the previous disposition was the default.
    expect(f.submit(1, 65550, Uint8Array.of(2, 2, 0b10))).toBe(0);
    expect(f.completion()).toMatchObject({ sequence: 1, errno: 0, value: 0n });
    expect(f.submit(2, 0, new Writer().u64(0).u64(1).finish())).toBe(0);
    expect(f.completion()).toBeUndefined();
    expect(call(f.runtime.instance, "oxidevm_userspace_process_signal", f.pid, 2)).toBe(0);
    expect(call(f.runtime.instance, "oxidevm_userspace_run", 10_000, 0)).toBe(0);
    expect(decodeUserspacePendingWork(call(f.runtime.instance, "oxidevm_userspace_pending_work")).hostRequest).toBe(true);
    expect(f.notice()).toEqual({ generation: f.request.generation, id: f.request.id, pid: f.pid, signal: 2, restart: false, interrupt: true });
    expect(f.notice()).toBeNull();
    expect(f.completion()).toMatchObject({ sequence: 2, errno: 4 });
    expect(f.waitStatus()).toBeUndefined();
    // Restoring the default answers the caught disposition it replaces.
    expect(f.submit(3, 65550, Uint8Array.of(2, 0, 0))).toBe(0);
    expect(f.completion()).toMatchObject({ sequence: 3, errno: 0, value: 2n });
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("answers the runner's OXJR 65550 with the previous disposition, and interrupts a pending read of a trapped signal with EINTR", async () => {
  const f = await fixture();
  try {
    const { send, complete } = operations(f);
    // What host.process.signals sends: caught with the interrupt flag and no restart, ignore, and the default.
    expect(send(dispositionOperation(2, "caught"))).toBe("default");
    expect(send(dispositionOperation(2, "ignore"))).toBe("caught");
    expect(send(dispositionOperation(2, "caught"))).toBe("ignore");
    expect(complete(files.read(0, 16))).toBeUndefined();
    expect(call(f.runtime.instance, "oxidevm_userspace_process_signal", f.pid, 2)).toBe(0);
    expect(call(f.runtime.instance, "oxidevm_userspace_run", 10_000, 0)).toBe(0);
    expect(f.notice()).toMatchObject({ pid: f.pid, signal: 2, restart: false, interrupt: true });
    expect(f.completion()).toMatchObject({ errno: 4 });
    expect(send(dispositionOperation(2, "default"))).toBe("caught");
    expect(f.waitStatus()).toBeUndefined();
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("reaps a JS process its worker ended by a signal (operation 7 through the driver) as signaled, with no exit after it", async () => {
  vi.stubGlobal("self", { location: new URL("https://app.test/"), crossOriginIsolated: true });
  vi.stubGlobal("Worker", StartedWorker);
  const f = await fixture();
  const workers = new JsProcessWorkers({ runtime: f.runtime, active: () => true, wake: () => { call(f.runtime.instance, "oxidevm_userspace_run", 10_000, 0); } });
  try {
    // The fixture admitted the process for launch token 1, the first token a fresh driver registers.
    expect(workers.register("https://app.test/process.worker.js")).toBe(1);
    const running = workers.run(f.request, new AbortController().signal), worker = StartedWorker.latest, port = worker?.port;
    if (worker === undefined || port === undefined) throw new Error("The driver started no worker");
    const words = worker.bootstrap["signals"];
    expect(words instanceof SharedArrayBuffer ? words.byteLength : 0).toBe(8);
    port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signaled", signal: 15 });
    await vi.waitFor(() => expect(f.waitStatus()).toEqual({ kind: "signal", signal: 15 }));
    // A late exit from the worker changes nothing: the process ended killed by SIGTERM.
    worker.onmessage?.(new MessageEvent("message", { data: { version: JS_PROCESS_PROTOCOL_VERSION, type: "exit", code: 0 } }));
    workers.reconcile(); await running;
    expect(worker.terminated).toBe(true);
    expect(f.waitStatus()).toEqual({ kind: "signal", signal: 15 });
    const again = encodeCommandSignalExit(f.request, 15); f.stage(again);
    expect(call(f.runtime.instance, "oxidevm_userspace_command", again.byteLength)).not.toBe(0);
  } finally { workers.dispose(); await f.runtime.jitRuntime.dispose(); }
});

it("starts spawnModule's runner with its launch description in the start message and leaves none of it in /proc/<pid>/cmdline", async () => {
  const release = await buildRelease({ adapter: "export default () => ({ main: () => 0 });", declaration: { ...COMMAND_DECLARATION, options: { mode: { type: "enum", values: ["fast", "private-choice"], default: "fast" } } } });
  const process: ProcessHandle = { kind: "process", pid: decodeProcessId(1), stdin: new WritableStream(), stdout: new ReadableStream(), stderr: new ReadableStream(), exit: new Promise(() => undefined), kill: () => Promise.resolve() };
  const starts: { readonly spec: PipeJSProcessSpec; readonly launch: RunnerHostLaunch }[] = [];
  owner.start.mockImplementation((_vm, spec, launch) => { starts.push({ spec, launch }); return Promise.resolve(process); });
  await spawnModule({ spawnJS: () => Promise.reject(new Error("spawnModule must not use the public spawnJS")) }, moduleHandle(release.manifest, { release: release.descriptor.release, adapter: release.descriptor.adapter, artifacts: release.descriptor.artifacts }), { args: ["in.md", "out.html"], options: { mode: "private-choice" } });
  const start = starts[0];
  if (start === undefined) throw new Error("spawnModule started nothing");
  // The real engine admits the process with the arguments spawnModule gave it, and the driver starts the runner.
  const f = await fixture(start.spec.args ?? []);
  vi.stubGlobal("self", { location: new URL("https://app.test/"), crossOriginIsolated: true });
  vi.stubGlobal("Worker", StartedWorker);
  const workers = new JsProcessWorkers({ runtime: f.runtime, active: () => true, wake: () => {} });
  try {
    if (f.request.program.kind !== "worker") throw new Error("Expected a worker launch");
    expect(workers.register("https://app.test/assets/module-runner/runner.worker.js", start.launch)).toBe(Number(f.request.program.token));
    const running = workers.run(f.request, new AbortController().signal);
    expect(StartedWorker.latest?.bootstrap["launch"]).toEqual(start.launch);
    expect(parseLaunchArgument(start.launch.descriptor).options).toEqual({ mode: "private-choice" });
    // What any guest program reads: the launcher and the caller's arguments, nothing of the description or its options.
    const { send } = operations(f);
    const cmdline = new TextDecoder().decode(send(files.read(send(files.open(`/proc/${String(f.pid)}/cmdline`, 0, 0)), 4096)));
    expect(cmdline.split("\0")).toEqual(["js-process", "in.md", "out.html", ""]);
    for (const secret of ["private-choice", release.descriptor.adapter.sha256, "manifest"]) expect(cmdline).not.toContain(secret);
    workers.dispose(); await running;
  } finally { workers.dispose(); await f.runtime.jitRuntime.dispose(); }
});
