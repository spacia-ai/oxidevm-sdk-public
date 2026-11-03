import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { engineModulePath } from "../engine-wasm.test-support.js";
import { instantiateRuntime } from "../userspace-runtime.js";
import { callUserspaceU32 as call } from "../userspace-exports.js";
import { readFileRecord } from "../userspace-files.js";
import { admitJSProcess } from "./admission.js";
import { UserspaceHostService } from "../userspace-host-service.js";
import { decodeUserspaceHostRequest, decodeUserspacePendingWork } from "../../userspace-abi.js";
import { encodeJSRequest } from "../../js-process/native-abi.js";
import { VMError } from "../../errors.js";
import { JS_PROCESS_PROTOCOL_VERSION, Writer, decodeJSIdentity, descriptor, noValue, operation, value } from "../../js-process/codec.js";
import { files } from "../../js-process/file-operations.js";
import { datagram, encodeAddress } from "../../js-process/sockets.js";
import type { FileDescriptor } from "../../../js-process-types.js";
import { encodeCommandExit, encodeCommandSignalExit } from "../../userspace-command-abi.js";
import { dispositionOperation, SIGNAL_BUFFER_BYTES } from "../../js-process/signals.js";
import { decodeSpawn, spawnPayload } from "../../js-process/process.js";
import { traceRingElf } from "../userspace-tier2.test-support.js";
import { record } from "../../decode.js";
import type { ProcessHandle } from "../../../contracts.js";
import { decodeProcessId } from "../../../values.js";
import type { ModuleStart } from "../../vm-types.js";
import type { ModuleSpawnSpec, OwnedModules } from "../../../vm-adapter.js";
import { prepareModuleStart } from "./module-artifacts.js";
import { ModuleCopies } from "./module-copies.js";
import { ModuleBroker } from "../module-frame/broker.js";
import { JsProcessWorkers } from "./driver.js";
import { moduleHandle } from "../../../wasm/handle.js";
import { spawnModule } from "../../../wasm/spawn.js";
import { parseLaunchArgument } from "../../../wasm/runner/descriptor.js";
import { buildRelease, COMMAND_DECLARATION } from "../../../wasm/runner/fixtures.test-support.js";
import { fixture, operations } from "./bridge-fixture.test-support.js";
import { decodeJSProcessTrace } from "../../../js-process-diagnostics.js";

/** spawnModule's start as the VM's owner record receives it (ADR 0028): the process spec, the description and the files. */
const owner = vi.hoisted(() => ({ modules: vi.fn<(vm: object) => OwnedModules>() }));
vi.mock("../../../vm-adapter.js", () => ({ ownedModules: owner.modules }));
afterEach(() => { vi.unstubAllGlobals(); owner.modules.mockReset(); });

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
    // OXCS 2 carries the arrival's siginfo: a host signal arrives as SI_USER (0) from pid 1 as uid 1000, without a value.
    expect(f.notice()).toEqual({ generation: f.request.generation, id: f.request.id, pid: f.pid, signal: 2, restart: false, interrupt: true, code: 0, sender: 1, uid: 1000, value: 0n });
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
    expect(words instanceof SharedArrayBuffer ? words.byteLength : 0).toBe(SIGNAL_BUFFER_BYTES);
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
  const starts: { readonly spec: ModuleSpawnSpec; readonly start: ModuleStart }[] = [], copies = new ModuleCopies();
  owner.modules.mockImplementation(() => ({ missing: pins => Promise.resolve(copies.missing(pins)), spawn: async (spec, start) => { await prepareModuleStart(start.descriptor, start.files, { copies, locks: undefined }, new AbortController().signal); starts.push({ spec, start }); return process; } }));
  vi.stubGlobal("fetch", (url: string) => { const bytes = release.served.get(url); return Promise.resolve(bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice())); });
  await spawnModule({ spawnJS: () => Promise.reject(new Error("spawnModule must not use the public spawnJS")) }, moduleHandle(release.manifest, { release: release.descriptor.release, adapter: release.descriptor.adapter, artifacts: release.descriptor.artifacts }), { args: ["in.md", "out.html"], options: { mode: "private-choice" } });
  const started = starts[0];
  if (started === undefined) throw new Error("spawnModule started nothing");
  vi.unstubAllGlobals();
  const { launch } = await prepareModuleStart(started.start.descriptor, {}, { copies, locks: undefined }, new AbortController().signal);
  // The real engine admits the process with the arguments spawnModule gave it, and the driver starts the runner.
  const f = await fixture(started.spec.args ?? []);
  vi.stubGlobal("self", { location: new URL("https://app.test/"), crossOriginIsolated: true });
  // ADR 0028: the runner starts in the module frame, behind its broker; this test's broker starts it in this thread.
  const frame = new MessageChannel(), runnerStart = Promise.withResolvers<Readonly<Record<string, unknown>>>();
  new ModuleBroker({ startRunner: () => ({ onmessage: null, onerror: null, onmessageerror: null, postMessage: (message: unknown) => { runnerStart.resolve(record(message, "runner start")); }, terminate: () => undefined }) }).attach(frame.port2);
  const workers = new JsProcessWorkers({ runtime: f.runtime, moduleFrame: () => frame.port1, active: () => true, wake: () => {} });
  try {
    if (f.request.program.kind !== "worker") throw new Error("Expected a worker launch");
    expect(workers.registerModule(launch)).toBe(Number(f.request.program.token));
    const running = workers.run(f.request, new AbortController().signal);
    expect(record((await runnerStart.promise)["launch"], "runner launch")).toMatchObject({ kind: "host", descriptor: launch.descriptor });
    expect(parseLaunchArgument(launch.descriptor).options).toEqual({ mode: "private-choice" });
    // What any guest program reads: the launcher and the caller's arguments, nothing of the description or its options.
    const { send } = operations(f);
    const cmdline = new TextDecoder().decode(send(files.read(send(files.open(`/proc/${String(f.pid)}/cmdline`, 0, 0)), 4096)));
    expect(cmdline.split("\0")).toEqual(["js-process", "in.md", "out.html", ""]);
    for (const secret of ["private-choice", release.descriptor.adapter.sha256, "manifest"]) expect(cmdline).not.toContain(secret);
    workers.dispose(); await running;
  } finally { workers.dispose(); frame.port1.close(); await f.runtime.jitRuntime.dispose(); }
});

it("admits a spawnModule process with its module's reach (Userspace API 146): a reach of none refuses even a VM connection with EACCES, traced in OXJT 18", async () => {
  for (const reach of ["vm", "none"] as const) {
    const f = await fixture([], reach);
    try {
      const { send, failure } = operations(f);
      const open = () => send(operation(41, new Writer().u32(1), result => descriptor(value(result))));
      const listener = open(), address = encodeAddress({ family: "unix", path: `/tmp/reach-${reach}` });
      // The runner's own listeners are not checked: a service with no reach still serves VM clients.
      send(operation(49, new Writer().u64(listener).blob(address), noValue));
      send(operation(50, new Writer().u64(listener).u32(4), noValue));
      expect(failure(operation(42, new Writer().u64(open()).blob(address), noValue))).toBe(reach === "vm" ? 0 : 13);
      expect(call(f.runtime.instance, "oxidevm_userspace_js_trace")).toBe(0);
      const refusals = decodeJSProcessTrace(readFileRecord(f.runtime)).refusals;
      expect(refusals).toEqual(reach === "vm" ? [] : [expect.objectContaining({ pid: f.pid, generation: f.request.generation, incarnationId: f.request.id, reason: "module-network-reach", declared: "none", attempted: "vm", destination: { family: "unix" } })]);
    } finally { await f.runtime.jitRuntime.dispose(); }
  }
});

it("opens a datagram socket for the runner's resolver; while the VM is local-only a datagram to port 53 is refused with EPERM (Userspace API 146)", async () => {
  const f = await fixture();
  try {
    const { send, failure } = operations(f);
    const socket = send(datagram.socket("ipv4"));
    expect(failure(datagram.sendTo(socket, Uint8Array.of(0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0), { family: "ipv4", address: "192.0.2.1", port: 53 }))).toBe(1);
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("answers a non-blocking read of a stream socket (recvfrom with MSG_DONTWAIT, 45): EAGAIN before bytes, then the bytes, then the end of stream", async () => {
  const f = await fixture();
  try {
    const { send, failure } = operations(f);
    const open = (family: number) => send(operation(41, new Writer().u32(family), result => descriptor(value(result))));
    // A Unix stream pair, and a loopback TCP pair in the VM: the synchronous module network reads both this way.
    const unix = connectedPair(send, "/workspace/timed.sock");
    const listener = open(2), loopback = encodeAddress({ family: "ipv4", address: "127.0.0.1", port: 40123 });
    send(operation(49, new Writer().u64(listener).blob(loopback), noValue));
    send(operation(50, new Writer().u64(listener).u32(4), noValue));
    const client = open(2);
    send(operation(42, new Writer().u64(client).blob(loopback), noValue));
    const server = send(operation(43, new Writer().u64(listener), result => descriptor(value(result))));
    for (const pair of [unix, { client, server }]) {
      expect(failure(datagram.receiveFrom(pair.client, 16, { dontWait: true }))).toBe(11);
      expect(send(files.write(pair.server, new TextEncoder().encode("ping"), true))).toBe(4);
      const received = send(datagram.receiveFrom(pair.client, 16, { dontWait: true }));
      expect(new TextDecoder().decode(received.bytes)).toBe("ping");
      send(files.close(pair.server));
      expect(send(datagram.receiveFrom(pair.client, 16, { dontWait: true })).bytes).toHaveLength(0);
    }
  } finally { await f.runtime.jitRuntime.dispose(); }
});
