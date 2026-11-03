import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { engineModulePath } from "../engine-wasm.test-support.js";
import { instantiateRuntime } from "../userspace-runtime.js";
import { callUserspaceU32 as call, callUserspaceU64 as call64 } from "../userspace-exports.js";
import { readFileRecord } from "../userspace-files.js";
import { admitJSProcess } from "./admission.js";
import { decodeUserspaceHostRequest } from "../../userspace-abi.js";
import { decodeJSCompletion, encodeJSRequest } from "../../js-process/native-abi.js";
import { JS_PROCESS_PROTOCOL_VERSION, LinuxError, operation, Writer, type LinuxOperation } from "../../js-process/codec.js";
import { files } from "../../js-process/file-operations.js";
import { decodeSpawn, spawnPayload } from "../../js-process/process.js";
import { encodeFilesystemRecord, type RootfsMetadataEntry } from "../../userspace-rootfs-record.js";
import type { NativeChildSpec } from "../../../js-process-types.js";
import { record } from "../../decode.js";
import { encodeLaunchArgument } from "../../../wasm/runner/descriptor.js";
import { JsProcessWorkers } from "./driver.js";
import { ModuleCopies } from "./module-copies.js";
import { ModuleCommands, nativeModuleCommandTable } from "./module-commands.js";
import { commandRelease, enableRequest, live, server } from "./module-commands.test-support.js";
import { enableModuleCommands } from "../../../wasm/commands.js";
import { pinsOf, relay } from "../../../wasm/commands.test-support.js";
import { moduleHandle } from "../../../wasm/handle.js";
import type { ModuleVM } from "../../../wasm/spawn.js";
import type { OwnedModuleCommands } from "../../../vm-adapter.js";
import { LinuxClient } from "../../js-process/transport.js";
import { dispositionOperation } from "../../js-process/signals.js";
import { ModuleBroker, type RunnerWorker } from "../module-frame/broker.js";

/** The page half of `enableModuleCommands`: the VMs it may reach, as the owner accessor knows them. */
const vms = vi.hoisted(() => new WeakMap<object, OwnedModuleCommands>());
vi.mock("../../../vm-adapter.js", () => ({
  ownedModuleCommands: (vm: object): OwnedModuleCommands => { const owned = vms.get(vm); if (owned === undefined) throw new Error("Not a test VM"); return owned; },
}));

afterEach(() => { vi.unstubAllGlobals(); });

const engine = WebAssembly.compile(new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm"))));
const ROOT = { uid: 0, gid: 0 } as const;
const encode = (path: string) => new TextEncoder().encode(path);
const directory = (path: string): RootfsMetadataEntry => ({ tag: 0, mode: 0o755, path: encode(path), pathText: path, payload: new Uint8Array(), ownership: ROOT });
const file = (path: string, payload: Uint8Array<ArrayBuffer>): RootfsMetadataEntry => ({ tag: 1, mode: 0o755, path: encode(path), pathText: path, payload, ownership: ROOT });
/** The line the engine's stub writes when it runs as an ordinary program (`runtime/module_commands/stub.rs`). */
const STUB_LINE = "oxidevm: this command runs a WebAssembly module that is not enabled for this process; the VM diagnostics name the reason\n";

/** JS operation 65538: an exec of `command` itself (no PATH lookup) in a new child process. */
const spawnChild = (command: string, args: readonly string[], stdio?: NativeChildSpec["stdio"]) => operation(65538, spawnPayload({ command, args, ...(stdio === undefined ? {} : { stdio }) }), decodeSpawn);
/** JS operation 61: the child's raw wait status once it exits. */
const waitStatus = (pid: number) => operation(61, new Writer().u32(pid), result => Number(result.value));

/** A runtime mounted from an image with `/usr/local/bin`, plus `entries`, its root files configured for persistence. */
async function mounted(entries: readonly RootfsMetadataEntry[] = []) {
  const runtime = await instantiateRuntime(await engine, "module-commands-core-test", { kind: "disabled" });
  const stage = (bytes: Uint8Array) => { expect(call(runtime.instance, "oxidevm_userspace_staging_resize", bytes.byteLength)).toBe(0); new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), bytes.byteLength).set(bytes); };
  const rootfs = encodeFilesystemRecord([directory("/usr"), directory("/usr/local"), directory("/usr/local/bin"), ...entries], "rootfs");
  stage(rootfs); expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", rootfs.byteLength, 1, 128)).toBe(0);
  stage(new Uint8Array(32)); expect(call(runtime.instance, "oxidevm_userspace_configure_root_persistence")).toBe(0);
  return { runtime, stage, revision: () => call64(runtime.instance, "oxidevm_userspace_root_revision") };
}

/** A JS process of `runtime` sending Linux requests through the production builders, and the launches Rust publishes. */
function linux(fixture: Awaited<ReturnType<typeof mounted>>) {
  const { runtime, stage } = fixture;
  const next = () => {
    expect(call(runtime.instance, "oxidevm_userspace_host_request_next", 8)).toBe(0);
    const length = call(runtime.instance, "oxidevm_userspace_host_request_len"), pointer = call(runtime.instance, "oxidevm_userspace_host_request_ptr");
    return length === 0 ? undefined : decodeUserspaceHostRequest(new Uint8Array(runtime.memory.buffer, pointer, length).slice());
  };
  admitJSProcess(runtime, 1, [], [], "/workspace");
  const parent = next();
  if (parent?.kind !== "command") throw new Error("Expected the JS process's launch");
  let sequence = 0;
  const submit = (request: LinuxOperation<unknown>) => {
    const bytes = encodeJSRequest(parent, ++sequence, request.number, request.payload); stage(bytes);
    expect(call(runtime.instance, "oxidevm_userspace_js_submit", bytes.byteLength)).toBe(0);
    expect(new DataView(readFileRecord(runtime).buffer).getUint32(0, true)).toBe(0);
  };
  const completion = () => { expect(call(runtime.instance, "oxidevm_userspace_js_next")).toBe(0); const bytes = readFileRecord(runtime); return bytes.byteLength === 0 ? undefined : decodeJSCompletion(bytes); };
  const send = <T>(request: LinuxOperation<T>): T => {
    submit(request);
    for (let turn = 0; turn < 100; turn += 1) {
      const reply = completion();
      if (reply !== undefined) {
        if (reply.errno !== 0) throw new LinuxError(reply.errno);
        return request.decode({ value: reply.value, bytes: reply.payload });
      }
      expect(call(runtime.instance, "oxidevm_userspace_run", 10_000, 0)).toBe(0);
    }
    throw new Error(`Operation ${String(request.number)} did not complete`);
  };
  const errno = (request: LinuxOperation<unknown>): number => { try { send(request); return 0; } catch (error: unknown) { if (error instanceof LinuxError) return error.errno; throw error; } };
  return { send, errno, next };
}

it("places root-owned 0755 stubs, keeps the root revision on an identical re-apply and launches a stub exec as OXCR 19 tag 4", async () => {
  const fixture = await mounted(), release = await commandRelease(), changed = vi.fn();
  const commands = new ModuleCommands({ copies: new ModuleCopies(), runtime: () => nativeModuleCommandTable(fixture.runtime), environment: () => ({ crossOriginIsolated: true, initialUser: "user" }), changed });
  try {
    const before = fixture.revision();
    const enabled = await commands.request(enableRequest(release, ["alpha", "beta"], 2), live());
    expect(enabled).toEqual({ operation: "enable", registration: 1, commands: ["alpha", "beta"], skipped: [] });
    const placed = fixture.revision();
    expect(placed).toBeGreaterThan(before);
    expect(changed).toHaveBeenCalledOnce();
    const process = linux(fixture);
    for (const name of ["alpha", "beta"]) expect(process.send(files.stat(`/usr/local/bin/${name}`))).toMatchObject({ mode: 0o100755, uid: 0, gid: 0 });
    // The same table again changes nothing at all: no root revision, nothing to persist.
    commands.reapply(nativeModuleCommandTable(fixture.runtime));
    expect(fixture.revision()).toBe(placed);
    expect(changed).toHaveBeenCalledOnce();
    // Any program that executes the stub becomes the module command, as the same process with the caller's whole argv.
    const child = process.send(spawnChild("/usr/local/bin/alpha", ["x.py"]));
    const launch = process.next();
    expect(launch).toMatchObject({ kind: "command", pid: child.pid, args: ["/usr/local/bin/alpha", "x.py"], program: { kind: "module-command", registration: 1, name: "alpha", path: "/usr/local/bin/alpha", terminals: { stdin: false, stdout: false, stderr: false } } });
    if (launch?.kind !== "command" || launch.program.kind !== "module-command") throw new Error("Expected a module command launch");
    expect(commands.launch(launch.program)).toMatchObject({ kind: "module-command", invocation: { name: "alpha", path: "/usr/local/bin/alpha" } });
    // Turning the commands off removes the stubs Rust placed.
    await commands.request({ operation: "disable", registration: 1 }, live());
    expect(process.errno(files.stat("/usr/local/bin/alpha"))).toBe(2);
    expect(fixture.revision()).toBeGreaterThan(placed);
  } finally { await fixture.runtime.jitRuntime.dispose(); }
});

it("runs a stub no registration names, such as one an earlier session left in persistent system files, as an ordinary program that exits 126", async () => {
  // The stub's bytes, as this engine writes them.
  const first = await mounted(), release = await commandRelease();
  const enabled = new ModuleCommands({ copies: new ModuleCopies(), runtime: () => nativeModuleCommandTable(first.runtime), environment: () => ({ crossOriginIsolated: true, initialUser: "user" }), changed: () => {} });
  let stub: Uint8Array<ArrayBuffer>;
  try {
    await enabled.request(enableRequest(release, ["alpha"]), live());
    const process = linux(first), fd = process.send(files.open("/usr/local/bin/alpha"));
    stub = Uint8Array.from(process.send(files.read(fd, 65536)));
    expect(Array.from(stub.subarray(0, 4))).toEqual([0x7f, 0x45, 0x4c, 0x46]);
  } finally { await first.runtime.jitRuntime.dispose(); }
  // A new session whose persisted system files hold that stub, before the application turns its commands on.
  const later = await mounted([file("/usr/local/bin/alpha", stub)]);
  const fresh = new ModuleCommands({ copies: new ModuleCopies(), runtime: () => nativeModuleCommandTable(later.runtime), environment: () => ({ crossOriginIsolated: true, initialUser: "user" }), changed: () => {} });
  try {
    fresh.reapply(nativeModuleCommandTable(later.runtime));
    const process = linux(later);
    const child = process.send(spawnChild("/usr/local/bin/alpha", ["x.py"], { stderr: "pipe" }));
    expect(process.next()).toBeUndefined();
    expect(process.send(waitStatus(child.pid))).toBe(126 << 8);
    if (child.stderr === null) throw new Error("Expected the child's standard error");
    expect(new TextDecoder().decode(process.send(files.read(child.stderr, 4096)))).toBe(STUB_LINE);
    expect(process.send(files.stat("/usr/local/bin/alpha"))).toMatchObject({ mode: 0o100755, uid: 0, gid: 0 });
  } finally { await later.runtime.jitRuntime.dispose(); }
});

/** A runner the module frame's broker starts, which records the start message the broker hands it. */
class RecordedRunner implements RunnerWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly started = Promise.withResolvers<Readonly<Record<string, unknown>>>();
  postMessage(message: unknown): void { this.started.resolve(record(message, "runner start")); }
  terminate(): void { /* the driver ends the process */ }
}

it("starts the SDK's module runner in the module frame with the registration's verified copies for an exec of a stub, and ends one whose registration was turned off with 125", async () => {
  const fixture = await mounted(), release = await commandRelease(), frame = new MessageChannel(), runners: RecordedRunner[] = [];
  new ModuleBroker({ startRunner: () => { const runner = new RecordedRunner(); runners.push(runner); return runner; } }).attach(frame.port2);
  const commands = new ModuleCommands({ copies: new ModuleCopies(), runtime: () => nativeModuleCommandTable(fixture.runtime), environment: () => ({ crossOriginIsolated: true, initialUser: "user" }), changed: () => {} });
  const workers = new JsProcessWorkers({ runtime: fixture.runtime, commands, moduleFrame: () => frame.port1, active: () => true, wake: () => {} });
  try {
    const enabled = await commands.request(enableRequest(release), live());
    if (enabled.operation !== "enable") throw new Error("not an enable result");
    const process = linux(fixture), child = process.send(spawnChild("/usr/local/bin/alpha", ["x.py"]));
    const launch = process.next();
    if (launch?.kind !== "command") throw new Error("Expected a module command launch");
    const running = workers.run(launch, new AbortController().signal);
    await vi.waitFor(() => { expect(runners).toHaveLength(1); });
    const runner = runners[0];
    if (runner === undefined) throw new Error("The broker started no runner");
    const start = await runner.started.promise, started = record(start["launch"], "runner launch"), copies = record(started["artifacts"], "verified copies");
    expect(started).toMatchObject({ kind: "module-command", invocation: { name: "alpha", path: "/usr/local/bin/alpha" }, terminals: { stdin: false, stdout: false, stderr: false }, descriptor: encodeLaunchArgument(release.descriptor) });
    expect(started["adapter"]).toBeInstanceOf(Blob);
    // The broker compiled the core module inside the frame; the Userspace worker sent only bytes.
    expect(record(copies["tool.wasm"], "tool.wasm")["module"]).toBeInstanceOf(WebAssembly.Module);
    // The runner's exit ends the process like any JS process's.
    runner.onmessage?.(new MessageEvent("message", { data: { version: JS_PROCESS_PROTOCOL_VERSION, type: "exit", code: 7 } }));
    await running;
    expect(process.send(waitStatus(child.pid))).toBe(7 << 8);
    // Rust admitted this exec before the commands were turned off; by the time the driver serves it, nothing is left to run.
    const late = process.send(spawnChild("/usr/local/bin/beta", [], { stderr: "pipe" }));
    const admitted = process.next();
    if (admitted?.kind !== "command" || late.stderr === null) throw new Error("Expected a module command launch with a standard error pipe");
    await commands.request({ operation: "disable", registration: enabled.registration }, live());
    await workers.run(admitted, new AbortController().signal);
    expect(runners).toHaveLength(1);
    expect(process.send(waitStatus(late.pid))).toBe(125 << 8);
    expect(new TextDecoder().decode(process.send(files.read(late.stderr, 4096)))).toBe("JS process failed: beta is no longer turned on in this VM\n");
  } finally { workers.dispose(); frame.port1.close(); await fixture.runtime.jitRuntime.dispose(); }
});

it("turns commands on and off from the page's enableModuleCommands through the worker protocol, and runs a stub exec as the registration the page got", async () => {
  const fixture = await mounted(), release = await commandRelease();
  const copies = new ModuleCopies(), served = server(release);
  const registrations = new ModuleCommands({ copies, runtime: () => nativeModuleCommandTable(fixture.runtime), environment: () => ({ crossOriginIsolated: true, initialUser: "user" }), changed: () => {} });
  // The page reads the files the VM's store lacks with its own fetch (ADR 0028).
  vi.stubGlobal("fetch", (url: string, init?: { readonly signal?: AbortSignal | null }) => served.fetch(url, { signal: init?.signal ?? new AbortController().signal }));
  const link = relay(registrations, copies), vm: ModuleVM = { spawnJS: () => Promise.reject(new Error("module commands start no JS process of their own")) };
  vms.set(vm, link.owned);
  try {
    const commands = await enableModuleCommands(vm, moduleHandle(release.manifest, pinsOf(release)), { commands: ["beta"], concurrency: 2 });
    expect([commands.commands, commands.paths]).toEqual([["beta"], { beta: "/usr/local/bin/beta" }]);
    const process = linux(fixture);
    expect(process.send(files.stat("/usr/local/bin/beta"))).toMatchObject({ mode: 0o100755, uid: 0, gid: 0 });
    // A declared command the call did not name gets no stub.
    expect(process.errno(files.stat("/usr/local/bin/alpha"))).toBe(2);
    const child = process.send(spawnChild("/usr/local/bin/beta", ["x.py"])), launch = process.next();
    expect(launch).toMatchObject({ kind: "command", pid: child.pid, args: ["/usr/local/bin/beta", "x.py"], program: { kind: "module-command", registration: 1, name: "beta", path: "/usr/local/bin/beta" } });
    if (launch?.kind !== "command" || launch.program.kind !== "module-command") throw new Error("Expected a module command launch");
    // The run starts from the description the page built, options resolved, and from nothing the guest supplied.
    expect(registrations.launch(launch.program)?.descriptor).toBe(encodeLaunchArgument(release.descriptor));
    await expect(commands.status()).resolves.toEqual({ enabled: true, skipped: [] });
    await commands.disable();
    expect(process.errno(files.stat("/usr/local/bin/beta"))).toBe(2);
    await expect(commands.status()).resolves.toEqual({ enabled: false, skipped: [] });
    await commands.disable();
  } finally { await fixture.runtime.jitRuntime.dispose(); }
});

/**
 * A runner the module frame's broker starts, run in this thread instead of a nested worker: it catches SIGINT (OXJR
 * 65550), blocks in an asynchronous read of its standard input, which the broker relays to the driver, and ends killed
 * by the signal once the read is interrupted, as the SDK's runner does for a module that traps no signal.
 */
class InterruptedRunner implements RunnerWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly state: { reading: boolean; errno: number | undefined; signals: number[] } = { reading: false, errno: undefined, signals: [] };
  postMessage(message: unknown): void {
    const start = record(message, "runner start"), port = start["port"], mailbox = start["mailbox"], words = start["signals"];
    if (!(port instanceof MessagePort) || !(mailbox instanceof SharedArrayBuffer) || !(words instanceof SharedArrayBuffer)) throw new Error("bad runner start");
    const client = new LinuxClient(port, mailbox, words);
    void (async () => {
      expect(await client.call(dispositionOperation(2, "caught"))).toBe("default");
      client.listenForSignals(arrivals => { this.state.signals.push(...arrivals.map(arrival => arrival.signal)); });
      this.state.reading = true;
      try { await client.call(files.read(0, 16)); } catch (error: unknown) { this.state.errno = error instanceof LinuxError ? error.errno : -1; }
      client.signaled(2);
    })();
  }
  terminate(): void { /* the driver ends the process */ }
}

it("relays a module command through the module frame's broker: a read reads EINTR after SIGINT and the command ends WIFSIGNALED", async () => {
  vi.stubGlobal("self", { location: new URL("https://app.test/"), crossOriginIsolated: true });
  const fixture = await mounted(), release = await commandRelease(), frame = new MessageChannel(), runner = new InterruptedRunner();
  new ModuleBroker({ startRunner: () => runner }).attach(frame.port2);
  const commands = new ModuleCommands({ copies: new ModuleCopies(), runtime: () => nativeModuleCommandTable(fixture.runtime), environment: () => ({ crossOriginIsolated: true, initialUser: "user" }), changed: () => {} });
  const pump = (): void => { expect(call(fixture.runtime.instance, "oxidevm_userspace_run", 10_000, 0)).toBe(0); };
  const workers = new JsProcessWorkers({ runtime: fixture.runtime, commands, moduleFrame: () => frame.port1, active: () => true, wake: pump });
  try {
    await commands.request(enableRequest(release), live());
    const process = linux(fixture), child = process.send(spawnChild("/usr/local/bin/alpha", [], { stdin: "pipe" })), launch = process.next();
    if (launch?.kind !== "command") throw new Error("Expected a module command launch");
    let ended = false;
    const running = workers.run(launch, new AbortController().signal).then(() => { ended = true; });
    await vi.waitFor(() => { workers.reconcile(); expect(runner.state.reading).toBe(true); });
    // The read is in Rust now; SIGINT interrupts it. Its notice reaches the broker ahead of the EINTR completion.
    expect(call(fixture.runtime.instance, "oxidevm_userspace_process_signal", child.pid, 2)).toBe(0);
    pump();
    await vi.waitFor(() => { workers.reconcile(); expect(runner.state.errno).toBe(4); });
    expect(runner.state.signals).toEqual([2]);
    await vi.waitFor(() => { workers.reconcile(); pump(); expect(ended).toBe(true); });
    await running;
    // WIFSIGNALED with SIGINT: the raw wait status is the signal number, and no exit status follows.
    expect(process.send(waitStatus(child.pid))).toBe(2);
  } finally { workers.dispose(); frame.port1.close(); await fixture.runtime.jitRuntime.dispose(); }
});
