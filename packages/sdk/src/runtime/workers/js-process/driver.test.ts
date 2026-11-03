import { afterEach, expect, it, vi } from "vitest";
import { decodeJSIdentity } from "../../js-process/codec.js";
import { JsProcessWorkers } from "./driver.js";
import { record } from "../../decode.js";
import { JS_PROCESS_PROTOCOL_VERSION, jsMailboxAttention, Writer } from "../../js-process/codec.js";
import { HostAttention, postCounted } from "../../host-attention.js";
import { serveAttentionNotices } from "../attention-notices.js";
import type { UserspaceCommandHostRequest } from "../../userspace-command-abi.js";
import { MODULE_BROKER_VERSION } from "../../protocol/module-frame.js";
import { copyKey } from "../../protocol/userspace-module-files.js";
import { encodeLaunchArgument } from "../../../wasm/runner/descriptor.js";
import { buildRelease, COMMAND_DECLARATION } from "../../../wasm/runner/fixtures.test-support.js";
import { SIGNAL_BUFFER_BYTES } from "../../js-process/signals.js";

class TestWorker {
  static latest: TestWorker | undefined;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  port: MessagePort | undefined;
  mailbox: SharedArrayBuffer | undefined;
  signals: Int32Array<SharedArrayBuffer> | undefined;
  bootstrap: unknown;
  readonly url: string;
  constructor(url: string | URL = "") { this.url = String(url); TestWorker.latest = this; }
  postMessage(value: unknown): void {
    this.bootstrap = value;
    const bootstrap = record(value, "test bootstrap"), port = bootstrap["port"], mailbox = bootstrap["mailbox"], signals = bootstrap["signals"];
    if (port instanceof MessagePort) this.port = port;
    if (mailbox instanceof SharedArrayBuffer) this.mailbox = mailbox;
    if (signals instanceof SharedArrayBuffer) this.signals = new Int32Array(signals);
  }
  terminate(): void { this.terminated = true; this.port?.close(); }
}
afterEach(() => { vi.unstubAllGlobals(); TestWorker.latest = undefined; });

/** Rust's notice for a late failure: PID 3, session 1 and an empty record file. */
const NOTICE = Uint8Array.from([...new TextEncoder().encode("OXAF"), 1, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, ...new TextEncoder().encode("OXAK"), 1, 0, 0, 0, 0, 0, 0, 0]);

/** A fake engine. Operation 6 answers the queued signal notices, operation 7 records a signal exit, and
 * `oxidevm_userspace_js_next` answers the queued completions after calling `onNext`. */
function runtime({ deferExit = false, notices = [], completions = [], onNext }: { readonly deferExit?: boolean; readonly notices?: Uint8Array[]; readonly completions?: Uint8Array[]; readonly onNext?: () => void } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let active = true, exits = 0, length = 0, resultLength = 1;
  const submitted: number[] = [], written: string[] = [], reports: { readonly kind: number; readonly detail: string }[] = [], signalExits: { readonly id: bigint; readonly signal: number; readonly length: number }[] = [];
  const answer = (queue: Uint8Array[]) => { const next = queue.shift(); resultLength = next?.byteLength ?? 0; if (next !== undefined) new Uint8Array(memory.buffer).set(next); return 0; };
  const callbacks = [
    (size: number) => { length = size; return 0; }, () => 0,
    () => {
      const bytes = new Uint8Array(memory.buffer), operation = bytes[4];
      if (operation === 5) {
        reports.push({ kind: bytes[21] ?? 0, detail: new TextDecoder().decode(bytes.subarray(23, 23 + (bytes[22] ?? 0))) });
        bytes.set(NOTICE); resultLength = NOTICE.byteLength; return 0;
      }
      if (operation === 6) return answer(notices);
      if (operation === 7) {
        signalExits.push({ id: new DataView(memory.buffer).getBigUint64(13, true), signal: bytes[21] ?? 0, length });
        resultLength = 0; if (!deferExit) active = false; return 0;
      }
      resultLength = operation === 2 ? 8 : 1;
      if (operation === 2) new DataView(memory.buffer).setBigInt64(0, BigInt(length - 22), true);
      else bytes[0] = Number(active);
      return 0;
    },
    () => resultLength, () => { exits++; if (!deferExit) active = false; return 0; }, () => { onNext?.(); return answer(completions); },
    () => { submitted.push(new DataView(memory.buffer).getUint32(32, true)); written.push(new TextDecoder().decode(new Uint8Array(memory.buffer, 0, length))); resultLength = 4; new Uint8Array(memory.buffer, 0, 4).fill(0); return 0; },
  ];
  const exports = ["oxidevm_userspace_staging_resize", "oxidevm_userspace_staging_ptr", "oxidevm_userspace_command", "oxidevm_userspace_file_record_len", "oxidevm_userspace_host_complete", "oxidevm_userspace_js_next", "oxidevm_userspace_js_submit"];
  const leb = (value: number): number[] => { const bytes: number[] = []; do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value === 0 ? 0 : 128)); } while (value !== 0); return bytes; };
  const name = (value: string) => { const bytes = [...new TextEncoder().encode(value)]; return [...leb(bytes.length), ...bytes]; };
  const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
  const imports = [callbacks.length + 1, ...name("test"), ...name("memory"), 2, 0, 1,
    ...callbacks.flatMap((_, index) => [...name("test"), ...name(String(index)), 0, 0])];
  const module = new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [1, 96, 1, 127, 1, 127]), ...section(2, imports),
    ...section(7, [exports.length, ...exports.flatMap((value, index) => [...name(value), 0, index])]),
  ]));
  const values: WebAssembly.ModuleImports = { memory };
  for (const [index, callback] of callbacks.entries()) values[String(index)] = callback;
  const instance = new WebAssembly.Instance(module, { test: values });
  return { instance, memory, submitted, written, reports, signalExits, notices, completions, retire: () => { active = false; }, exits: () => exits };
}
const request: UserspaceCommandHostRequest = {
  kind: "command", ...decodeJSIdentity(1n, 1n), pid: 3, tty: false, cwd: "/workspace", program: { kind: "typescript", entry: "/workspace/node_modules/.bun/typescript@6.0.2/node_modules/typescript/bin/tsc", executable: "/usr/bin/node" }, args: ["--noEmit"], environment: [],
};

it("forwards metadata, mask, PATH and signal-disposition operations, then rejects an unknown operation before Rust submission", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const native = runtime(), driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", active: () => true, wake: () => {} });
  const running = driver.run(request, new AbortController().signal);
  const port = TestWorker.latest?.port;
  if (port === undefined) throw new Error("Missing worker service port");
  try {
    port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence: 1, sync: false, operation: 65545, payload: new Writer().path("/workspace/a.js").finish() });
    await vi.waitFor(() => expect(native.submitted).toEqual([65545]));
    port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence: 2, sync: false, operation: 65547, payload: new Uint8Array([0]) });
    await vi.waitFor(() => expect(native.submitted).toEqual([65545, 65547]));
    port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence: 3, sync: false, operation: 65548, payload: new Writer().path("tool").path("/bin").finish() });
    await vi.waitFor(() => expect(native.submitted).toEqual([65545, 65547, 65548]));
    // OXJR 65550 (ADR 0027): SIGINT caught with the interrupt flag; Rust validates the record.
    port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence: 4, sync: false, operation: 65550, payload: new Uint8Array([2, 2, 2]) });
    await vi.waitFor(() => expect(native.submitted).toEqual([65545, 65547, 65548, 65550]));
    port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence: 5, sync: false, operation: 65551, payload: new Uint8Array() });
    await running;
    expect(native.submitted).toEqual([65545, 65547, 65548, 65550, 1]);
    expect(native.exits()).toBe(1);
  } finally { native.retire(); driver.reconcile(); await running; }
});

it("exits an admitted native command when its isolated execution capability is absent", async () => {
  const native = runtime(), driver = new JsProcessWorkers({ runtime: native, active: () => true, wake: () => {} });
  await expect(driver.run({ ...request, cwd: "/workspace/swc", program: { kind: "native-node", entry: "/workspace/swc/build.cjs", source: { kind: "file" }, input: 3, output: 4, context: { kind: "main" }, profile: { runtime: "node", executable: "/usr/bin/node", runtimeSHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", identity: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/swc/node_modules" }], basis: "no-addons", dependencyGeneration: 11n, artifacts: [], moduleSearchPaths: [], requiredCapabilities: 0, bridgeVersion: 16 } } }, new AbortController().signal)).resolves.toBeUndefined();
  expect(native.exits()).toBe(1); expect(TestWorker.latest).toBeUndefined();
});

it("retires a cancelled command without failing the VM when its worker reports a late failure", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const native = runtime();
  const driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", active: () => true, wake: () => {} });
  const running = driver.run(request, new AbortController().signal);
  const settled = expect(running).resolves.toBeUndefined();
  const worker = TestWorker.latest; expect(worker).toBeDefined();
  native.retire();
  worker?.onmessage?.(new MessageEvent("message", { data: { version: JS_PROCESS_PROTOCOL_VERSION, type: "failure", error: { code: "VM_FAULT", message: "late worker failure" } } }));
  await settled;
  expect(worker?.terminated).toBe(true); expect(native.exits()).toBe(0);
});

it("retires an inactive child without waiting for a host request or its parent terminal to exit", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const native = runtime(), driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", active: () => true, wake: () => {} });
  const running = driver.run(request, new AbortController().signal), worker = TestWorker.latest;
  try {
    native.retire(); driver.retireInactive(); await running;
    expect(worker?.terminated).toBe(true); expect(native.exits()).toBe(0);
  } finally { driver.dispose(); await running; }
});

it("ignores late worker errors while Rust defers exit for a stopped process", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const native = runtime({ deferExit: true }), driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", active: () => true, wake: () => {} });
  const running = driver.run(request, new AbortController().signal), worker = TestWorker.latest;
  try {
    worker?.onmessage?.(new MessageEvent("message", { data: { version: JS_PROCESS_PROTOCOL_VERSION, type: "exit", code: 0 } }));
    expect(native.exits()).toBe(1);
    worker?.onmessage?.(new MessageEvent("message", { data: { version: JS_PROCESS_PROTOCOL_VERSION, type: "failure", error: { code: "VM_FAULT", message: "late" } } }));
    expect(native.exits()).toBe(1);
  } finally { native.retire(); driver.reconcile(); await running; }
});

it.each(["constructor", "mailbox", "post-message"])("exits the admitted process when %s setup fails", async failure => {
  const native = runtime();
  class FailingWorker extends TestWorker {
    constructor() { super(); if (failure === "constructor") throw new Error("worker unavailable"); }
    override postMessage(value: unknown): void { if (failure === "post-message") throw new Error("start message failed"); super.postMessage(value); }
  }
  vi.stubGlobal("Worker", FailingWorker);
  if (failure === "mailbox") vi.stubGlobal("SharedArrayBuffer", function unavailableMailbox(): never { throw new Error("mailbox unavailable"); });
  const driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", active: () => true, wake: () => {} });
  await expect(driver.run(request, new AbortController().signal)).resolves.toBeUndefined();
  expect(native.exits()).toBe(1);
  if (failure === "post-message") expect(TestWorker.latest?.terminated).toBe(true);
});

it("starts the worker on the current JS process protocol and rejects a request from the previous one", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const native = runtime(), driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", active: () => true, wake: () => {} });
  const running = driver.run(request, new AbortController().signal);
  const worker = TestWorker.latest, port = worker?.port;
  if (worker === undefined || port === undefined) throw new Error("Missing worker service port");
  expect(record(worker.bootstrap, "bootstrap")["version"]).toBe(JS_PROCESS_PROTOCOL_VERSION);
  try {
    port.postMessage({ version: 1, type: "request", sequence: 1, sync: false, operation: 65545, payload: new Uint8Array() });
    await running;
    // The stale peer's request never reached Rust; the process exits 125 after its diagnostic write.
    expect(native.submitted).toEqual([1]);
    expect(native.exits()).toBe(1);
  } finally { native.retire(); driver.reconcile(); await running; }
});

it("holds host attention for a same-origin worker's posted request until the driver receives it", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const native = runtime(), attention = new HostAttention<"js-process">();
  const driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", attention: { watch: counter => attention.watch("js-process", counter) }, active: () => true, wake: () => {} });
  const running = driver.run(request, new AbortController().signal);
  const worker = TestWorker.latest, port = worker?.port, mailbox = worker?.mailbox;
  if (port === undefined || mailbox === undefined) throw new Error("Missing worker service port or mailbox");
  try {
    expect(attention.size).toBe(1);
    expect(attention.pending()).toBeUndefined();
    // What the worker's Linux client does for every request.
    postCounted(jsMailboxAttention(mailbox), () => {
      port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence: 1, sync: false, operation: 65545, payload: new Writer().path("/workspace/a.js").finish() });
    });
    expect(attention.pending()).toBe("js-process");
    await vi.waitFor(() => expect(native.submitted).toEqual([65545]));
    expect(attention.pending()).toBeUndefined();
  } finally { native.retire(); driver.reconcile(); await running; }
  // A retired process's channel no longer holds attention.
  expect(attention.size).toBe(0);
});

const NATIVE_PROGRAM = { kind: "native-node", entry: "/workspace/swc/build.cjs", source: { kind: "file" }, input: 3, output: 4, context: { kind: "main" }, profile: { runtime: "node", executable: "/usr/bin/node", runtimeSHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", identity: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/swc/node_modules" }], basis: "no-addons", dependencyGeneration: 11n, artifacts: [], moduleSearchPaths: [], requiredCapabilities: 0, bridgeVersion: 16 } } as const;

it("holds host attention for a native process's request from its broker's notice until the driver receives it", async () => {
  vi.stubGlobal("crossOriginIsolated", true);
  const broker = new MessageChannel(), native = runtime(), attention = new HostAttention<"js-process">();
  const noticesScope: { onmessage: ((event: MessageEvent<unknown>) => void) | null } = { onmessage: null };
  serveAttentionNotices(noticesScope);
  let noticesStarted = 0, noticesTerminated = 0;
  const startNotices = () => {
    noticesStarted += 1;
    return {
      postMessage: (message: unknown, transfer: Transferable[]) => { noticesScope.onmessage?.(new MessageEvent("message", { data: structuredClone(message, { transfer }) })); },
      terminate: () => { noticesTerminated += 1; }, addEventListener: () => {},
    };
  };
  const driver = new JsProcessWorkers({ runtime: native, nativeExecution: broker.port1, startNotices,
    attention: { watch: counter => attention.watch("js-process", counter) }, active: () => true, wake: () => {} });
  // The isolated broker's side of the launch.
  const spawn = new Promise<MessagePort>(accept => { broker.port2.onmessage = (event: MessageEvent<unknown>) => { const port = record(event.data, "spawn")["port"]; if (port instanceof MessagePort) accept(port); }; broker.port2.start(); });
  const running = driver.run({ ...request, cwd: "/workspace/swc", program: NATIVE_PROGRAM }, new AbortController().signal);
  const connection = await spawn;
  const start = await new Promise<Readonly<Record<string, unknown>>>(accept => { connection.onmessage = (event: MessageEvent<unknown>) => { accept(record(event.data, "start")); }; connection.start(); });
  const upstream = start["port"], notice = start["attention"];
  if (!(upstream instanceof MessagePort) || !(notice instanceof MessagePort)) throw new Error("The native launch carries no service or notice port");
  // A native process runs its own guest handlers: its start message carries no signal words and no mailbox.
  expect(Object.keys(record(start["value"], "native start")).sort()).toEqual(["generation", "id", "port", "program", "type", "version"]);
  try {
    expect(noticesStarted).toBe(1);
    expect(attention.size).toBe(1);
    // What the broker does for every forwarded request: a notice, then the request itself.
    notice.postMessage(null);
    await vi.waitFor(() => expect(attention.pending()).toBe("js-process"));
    upstream.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence: 1, sync: false, operation: 65545, payload: new Writer().path("/workspace/swc/a.js").finish() });
    await vi.waitFor(() => expect(native.submitted).toEqual([65545]));
    expect(attention.pending()).toBeUndefined();
  } finally { native.retire(); driver.reconcile(); await running; notice.close(); upstream.close(); connection.close(); broker.port2.close(); }
  expect(attention.size).toBe(0);
  driver.dispose();
  expect(noticesTerminated).toBe(1);
});

it("reports a classified failure to Rust, remembers it and explains the next run in one sentence", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const native = runtime(), remembered: unknown[] = [];
  const driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", knowledge: { remember: (notice, failure) => { remembered.push({ notice, failure }); } }, active: () => true, wake: () => {} });
  const running = driver.run(request, new AbortController().signal), worker = TestWorker.latest;
  worker?.onmessage?.(new MessageEvent("message", { data: { version: JS_PROCESS_PROTOCOL_VERSION, type: "failure", error: { code: "FEATURE_NOT_AVAILABLE", message: "Unsupported Node-API operation: napi_run_script", detail: { lateFailure: "unsupported-node-api", subject: "napi_run_script" } } } }));
  await running;
  expect(native.reports).toEqual([{ kind: 3, detail: "napi_run_script" }]);
  expect(remembered).toEqual([{ notice: { pid: 3, session: 1, record: NOTICE.slice(16) }, failure: { kind: "unsupported-node-api", detail: "napi_run_script" } }]);
  expect(native.written.join("")).toContain("This program's add-on called napi_run_script, which the fast path does not provide yet; its next run uses full Linux.");
  expect(native.exits()).toBe(1);
});

it("remembers a limitation the process reported before it exits on its own", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const native = runtime(), remembered: unknown[] = [];
  const driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", knowledge: { remember: (_, failure) => { remembered.push(failure); } }, active: () => true, wake: () => {} });
  const running = driver.run(request, new AbortController().signal), worker = TestWorker.latest;
  worker?.onmessage?.(new MessageEvent("message", { data: { version: JS_PROCESS_PROTOCOL_VERSION, type: "late-failure", failure: { kind: "unavailable-builtin", detail: "node:sqlite" } } }));
  expect(native.exits()).toBe(0);
  worker?.onmessage?.(new MessageEvent("message", { data: { version: JS_PROCESS_PROTOCOL_VERSION, type: "exit", code: 1 } }));
  await running;
  expect(native.reports).toEqual([{ kind: 1, detail: "node:sqlite" }]);
  expect(remembered).toEqual([{ kind: "unavailable-builtin", detail: "node:sqlite" }]);
  expect(native.exits()).toBe(1);
});

it("never remembers an unclassified failure or a malformed late-failure message", async () => {
  vi.stubGlobal("Worker", TestWorker);
  for (const data of [
    { version: JS_PROCESS_PROTOCOL_VERSION, type: "failure", error: { code: "VM_FAULT", message: "worker crashed" } },
    { version: JS_PROCESS_PROTOCOL_VERSION, type: "late-failure", failure: { kind: "other", detail: "x" } },
    { version: JS_PROCESS_PROTOCOL_VERSION, type: "late-failure", failure: { kind: "unavailable-builtin", detail: "line\nbreak" } },
  ]) {
    const native = runtime(), remembered: unknown[] = [];
    const driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", knowledge: { remember: (_, failure) => { remembered.push(failure); } }, active: () => true, wake: () => {} });
    const running = driver.run(request, new AbortController().signal);
    TestWorker.latest?.onmessage?.(new MessageEvent("message", { data }));
    await running;
    expect(native.reports).toEqual([]);
    expect(remembered).toEqual([]);
    expect(native.exits()).toBe(1);
  }
});

/** OXCS 2 for the test request (generation 1, id 1, pid 3), or for another generation, incarnation or process; sent by pid 2 as uid 1000 (SI_USER). */
function signalNotice(signal: number, flags: number, { generation = 1n, id = 1n, pid = 3 } = {}): Uint8Array {
  return new Writer().raw(new TextEncoder().encode("OXCS")).u32(2).u64(generation).u64(id).u32(pid).u8(signal).u8(flags).u32(0).u32(2).u32(1000).u64(0n).finish();
}
/** OXJP 1: Rust's completion of request `sequence` of the test request. */
function completion(sequence: number, errno: number): Uint8Array {
  return new Writer().raw(new TextEncoder().encode("OXJP")).u32(1).u64(1n).u64(1n).u64(BigInt(sequence)).u32(3).u32(errno).u64(0n).blob(new Uint8Array()).finish();
}
const NUDGE = { version: JS_PROCESS_PROTOCOL_VERSION, type: "signal" } as const;
function isNudge(message: unknown): boolean { return typeof message === "object" && message !== null && Reflect.get(message, "type") === "signal"; }
function started() {
  const worker = TestWorker.latest, words = worker?.signals, port = worker?.port, mailbox = worker?.mailbox;
  if (worker === undefined || words === undefined || port === undefined || mailbox === undefined) throw new Error("Missing worker, signal words, service port or mailbox");
  return { worker, words, port, mailbox };
}

it("starts each local worker with a protocol-5 signal buffer of its own and no launch", async () => {
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("self", { location: new URL("https://example.test/app"), crossOriginIsolated: true });
  const native = runtime(), driver = new JsProcessWorkers({ runtime: native, active: () => true, wake: () => {} });
  const tokens = [driver.register("https://example.test/one.worker.js"), driver.register("https://example.test/two.worker.js")];
  const bootstraps: Readonly<Record<string, unknown>>[] = [], runs: Promise<void>[] = [], urls: string[] = [];
  try {
    for (const [index, token] of tokens.entries()) {
      runs.push(driver.run({ ...request, ...decodeJSIdentity(1n, BigInt(index + 1)), program: { kind: "worker", token: BigInt(token) } }, new AbortController().signal));
      bootstraps.push(record(TestWorker.latest?.bootstrap, "bootstrap"));
      urls.push(TestWorker.latest?.url ?? "");
    }
    expect(urls).toEqual(["https://example.test/one.worker.js", "https://example.test/two.worker.js"]);
    for (const bootstrap of bootstraps) {
      expect(Object.keys(bootstrap).sort()).toEqual(["mailbox", "port", "signals", "type", "version"]);
      const words = bootstrap["signals"]; expect(words instanceof SharedArrayBuffer ? words.byteLength : 0).toBe(SIGNAL_BUFFER_BYTES);
    }
    expect(bootstraps[0]?.["signals"]).not.toBe(bootstraps[1]?.["signals"]);
  } finally { native.retire(); driver.reconcile(); await Promise.all(runs); }
});

it("turns Rust's caught-signal notices into pending bits, the interrupt word and one nudge per reconcile", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const native = runtime(), driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", active: () => true, wake: () => {} });
  const running = driver.run(request, new AbortController().signal), { words, port } = started();
  const delivered: unknown[] = []; port.onmessage = (event: MessageEvent<unknown>) => { delivered.push(event.data); };
  const posts = vi.spyOn(MessagePort.prototype, "postMessage"), nudges = () => posts.mock.calls.filter(([message]) => isNudge(message)).length;
  try {
    native.notices.push(signalNotice(2, 0b10), signalNotice(15, 0));
    driver.reconcile();
    // SIGINT asked for the interrupt word; SIGTERM only for its bit. One nudge covers both.
    expect(Atomics.load(words, 0)).toBe((1 << 1) | (1 << 14));
    expect(Atomics.load(words, 2)).toBe(2);
    expect(nudges()).toBe(1);
    await vi.waitFor(() => expect(delivered).toEqual([NUDGE]));
    // A notice for another incarnation or runtime generation is not this worker's, and no notice means no nudge.
    native.notices.push(signalNotice(10, 0, { id: 7n }), signalNotice(10, 0, { generation: 2n })); driver.reconcile(); driver.reconcile();
    expect(Atomics.load(words, 0)).toBe((1 << 1) | (1 << 14));
    expect(nudges()).toBe(1);
    native.notices.push(signalNotice(2, 0, { pid: 4 }));
    expect(() => { driver.reconcile(); }).toThrow("Signal notice process mismatch");
  } finally { posts.mockRestore(); native.retire(); driver.reconcile(); await running; }
});

it("stores an interrupting signal only while the interrupt word reads 0 and retries on later reconciles, lowest first", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const native = runtime(), driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", active: () => true, wake: () => {} });
  const running = driver.run(request, new AbortController().signal), { words } = started();
  try {
    // The module has not taken an earlier SIGTERM yet.
    Atomics.store(words, 2, 15);
    native.notices.push(signalNotice(2, 0b10)); driver.reconcile();
    expect([Atomics.load(words, 0), Atomics.load(words, 2)]).toEqual([1 << 1, 15]);
    driver.reconcile(); expect(Atomics.load(words, 2)).toBe(15);
    Atomics.store(words, 2, 0); driver.reconcile(); expect(Atomics.load(words, 2)).toBe(2);
    // Stored once: after the module takes it there is no second copy.
    Atomics.store(words, 2, 0); driver.reconcile(); expect(Atomics.load(words, 2)).toBe(0);
    // Without the interrupt flag a notice leaves the word alone.
    native.notices.push(signalNotice(10, 0b01)); driver.reconcile();
    expect([Atomics.load(words, 0) & (1 << 9), Atomics.load(words, 2)]).toEqual([1 << 9, 0]);
    // Two interrupting signals while the word is busy: the lowest goes first, then the next.
    Atomics.store(words, 2, 3); native.notices.push(signalNotice(15, 0b10), signalNotice(1, 0b10)); driver.reconcile();
    expect(Atomics.load(words, 2)).toBe(3);
    Atomics.store(words, 2, 0); driver.reconcile(); expect(Atomics.load(words, 2)).toBe(1);
    Atomics.store(words, 2, 0); driver.reconcile(); expect(Atomics.load(words, 2)).toBe(15);
  } finally { native.retire(); driver.reconcile(); await running; }
});

it("hands over Rust's notices before its completions, so a synchronous wait it interrupted reads EINTR with the signal already pending", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const notices: Uint8Array[] = [], completions: Uint8Array[] = [];
  const observed: { words?: Int32Array; seen?: readonly [number, number] } = {};
  const native = runtime({ notices, completions, onNext: () => { const { words } = observed; if (completions.length > 0 && words !== undefined) observed.seen = [Atomics.load(words, 0), Atomics.load(words, 2)]; } });
  const driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", active: () => true, wake: () => {} });
  const running = driver.run(request, new AbortController().signal), worker = started();
  observed.words = worker.words;
  try {
    // Rust: a SIGINT caught without restart interrupts the pending read, so its notice and the EINTR completion wait together.
    notices.push(signalNotice(2, 0b10)); completions.push(completion(1, 4));
    worker.port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence: 1, sync: true, operation: 0, payload: new Writer().u64(0).u64(16).finish() });
    const header = new Int32Array(worker.mailbox, 0, 4), body = new DataView(worker.mailbox, 16);
    await vi.waitFor(() => expect(Atomics.load(header, 0)).toBe(1));
    expect([Atomics.load(header, 2), body.getUint32(0, true)]).toEqual([1, 4]);
    expect(observed.seen).toEqual([1 << 1, 2]);
  } finally { native.retire(); driver.reconcile(); await running; }
});

it("ends the process killed by the signal its worker reports, through operation 7, and reports no exit afterwards", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const native = runtime(), driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", active: () => true, wake: () => {} });
  const running = driver.run(request, new AbortController().signal), { worker, port } = started();
  port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signaled", signal: 2 });
  await running;
  expect(native.signalExits).toEqual([{ id: 1n, signal: 2, length: 22 }]);
  expect(worker.terminated).toBe(true);
  worker.onmessage?.(new MessageEvent("message", { data: { version: JS_PROCESS_PROTOCOL_VERSION, type: "exit", code: 0 } }));
  expect(native.exits()).toBe(0);
});

it.each([
  ["an untrappable signal", { version: JS_PROCESS_PROTOCOL_VERSION, type: "signaled", signal: 9 }],
  ["an extra field", { version: JS_PROCESS_PROTOCOL_VERSION, type: "signaled", signal: 2, code: 0 }],
  ["no signal", { version: JS_PROCESS_PROTOCOL_VERSION, type: "signaled" }],
  ["the previous protocol", { version: JS_PROCESS_PROTOCOL_VERSION - 1, type: "signaled", signal: 2 }],
])("refuses a signal exit with %s and ends the process with status 125", async (_case, message) => {
  vi.stubGlobal("Worker", TestWorker);
  const native = runtime(), driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", active: () => true, wake: () => {} });
  const running = driver.run(request, new AbortController().signal), { port } = started();
  port.postMessage(message);
  await running;
  expect(native.signalExits).toEqual([]);
  expect(native.exits()).toBe(1);
});

// Engine ADR 0027: Rust admitted an exec of an enabled command's stub (OXCR 19 tag 4).
const COMMAND = { kind: "module-command", registration: 4, name: "typst", path: "/usr/local/bin/typst", terminals: { stdin: true, stdout: true, stderr: false } } as const;
const commandRequest: UserspaceCommandHostRequest = { ...request, tty: true, program: COMMAND, args: ["typst", "compile", "a.typ"] };

const WASM = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
/** A module command's launch as its registration resolves it: copies without compiled modules, which stay in the frame. */
async function moduleLaunch() {
  const release = await buildRelease({ adapter: "export default () => ({ main: () => 0 });", artifacts: { "tool.wasm": WASM }, declaration: { ...COMMAND_DECLARATION, commands: ["typst"] } });
  const launch = { kind: "module-command", invocation: { name: "typst", path: "/usr/local/bin/typst" }, terminals: COMMAND.terminals, descriptor: encodeLaunchArgument(release.descriptor), adapter: new Blob([]), artifacts: { "tool.wasm": { blob: new Blob([WASM]), module: null } }, tls: null } as const;
  return { release, launch, key: copyKey(release.descriptor.artifacts["tool.wasm"] ?? { sha256: "", bytes: 0 }) };
}

/** The module frame's broker as the driver sees it: each spawn's channel, the start on it and the service port. */
function moduleFrame() {
  const channel = new MessageChannel(), spawns: { readonly pid: unknown; readonly connection: MessagePort; readonly start: Promise<Readonly<Record<string, unknown>>> }[] = [];
  channel.port2.onmessage = (event: MessageEvent<unknown>) => {
    const spawn = record(event.data, "spawn"), connection = spawn["port"];
    if (spawn["version"] !== MODULE_BROKER_VERSION || spawn["type"] !== "spawn" || !(connection instanceof MessagePort)) throw new Error("not a spawn");
    const start = new Promise<Readonly<Record<string, unknown>>>(resolve => { connection.onmessage = message => { resolve(record(message.data, "start")); }; });
    spawns.push({ pid: spawn["pid"], connection, start });
  };
  return { port: channel.port1, spawns };
}

it("starts every module process through the module frame's broker, never as a local worker (ADR 0028)", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const native = runtime(), frame = moduleFrame(), { launch, key } = await moduleLaunch(), resolved: unknown[] = [];
  const driver = new JsProcessWorkers({ runtime: native, commands: { launch: program => { resolved.push(program); return launch; } }, moduleFrame: () => frame.port, active: () => true, wake: () => {} });
  const running = driver.run(commandRequest, new AbortController().signal);
  try {
    await vi.waitFor(() => { expect(frame.spawns).toHaveLength(1); });
    const start = await frame.spawns[0]?.start;
    expect(frame.spawns[0]?.pid).toBe(3);
    // The launch crosses as copies with each artifact's key, so the broker compiles once per copy; no shared memory crosses.
    expect(start).toMatchObject({ version: MODULE_BROKER_VERSION, type: "start", value: { version: JS_PROCESS_PROTOCOL_VERSION, type: "start", launch, keys: { "tool.wasm": key } } });
    expect(start?.["port"]).toBeInstanceOf(MessagePort);
    expect(TestWorker.latest).toBeUndefined();
    expect(resolved).toEqual([COMMAND]);
  } finally { native.retire(); driver.reconcile(); await running; }
});

it("ends a module process with status 125 when no module frame is attached, and never starts it in the page's origin", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const native = runtime(), { launch } = await moduleLaunch();
  const driver = new JsProcessWorkers({ runtime: native, commands: { launch: () => launch }, moduleFrame: () => undefined, active: () => true, wake: () => {} });
  await expect(driver.run(commandRequest, new AbortController().signal)).resolves.toBeUndefined();
  expect(native.exits()).toBe(1);
  expect(native.written.join("")).toContain("JS process failed: The module frame is gone");
  expect(TestWorker.latest).toBeUndefined();
});

it("forwards a signal before the completion it interrupted, on the module process's service port", async () => {
  const notices: Uint8Array[] = [], completions: Uint8Array[] = [];
  const native = runtime({ notices, completions }), frame = moduleFrame(), { launch } = await moduleLaunch();
  const driver = new JsProcessWorkers({ runtime: native, commands: { launch: () => launch }, moduleFrame: () => frame.port, active: () => true, wake: () => {} });
  const running = driver.run(commandRequest, new AbortController().signal);
  try {
    await vi.waitFor(() => { expect(frame.spawns).toHaveLength(1); });
    const service = (await frame.spawns[0]?.start)?.["port"];
    if (!(service instanceof MessagePort)) throw new Error("no service port");
    const received: unknown[] = [];
    service.onmessage = event => { received.push(event.data); };
    // Rust: SIGINT caught without restart interrupts the relayed read; its notice and the EINTR completion wait together.
    notices.push(signalNotice(2, 0b10)); completions.push(completion(1, 4));
    service.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence: 1, sync: false, operation: 0, payload: new Writer().u64(0).u64(16).finish() });
    await vi.waitFor(() => { expect(received).toHaveLength(2); });
    expect(received).toEqual([
      { version: JS_PROCESS_PROTOCOL_VERSION, type: "signal-notice", signal: 2, interrupt: true, code: 0, sender: 2, uid: 1000, value: 0n },
      { version: JS_PROCESS_PROTOCOL_VERSION, type: "reply", sequence: 1, errno: 4, value: 0n, payload: new Uint8Array() },
    ]);
  } finally { native.retire(); driver.reconcile(); await running; }
});

it("ends a module process whose broker relays a synchronous request: its shared memory must stay in the frame", async () => {
  const native = runtime(), frame = moduleFrame(), { launch } = await moduleLaunch();
  const driver = new JsProcessWorkers({ runtime: native, commands: { launch: () => launch }, moduleFrame: () => frame.port, active: () => true, wake: () => {} });
  const running = driver.run(commandRequest, new AbortController().signal);
  await vi.waitFor(() => { expect(frame.spawns).toHaveLength(1); });
  const service = (await frame.spawns[0]?.start)?.["port"];
  if (!(service instanceof MessagePort)) throw new Error("no service port");
  service.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence: 1, sync: true, operation: 0, payload: new Uint8Array() });
  await running;
  expect([native.exits(), native.submitted]).toEqual([1, [1]]);
});

it("ends a module command whose registration was turned off with status 125 and a diagnostic line", async () => {
  vi.stubGlobal("Worker", TestWorker);
  for (const ports of [{ commands: { launch: () => undefined } }, {}]) {
    const native = runtime(), driver = new JsProcessWorkers({ runtime: native, ...ports, active: () => true, wake: () => {} });
    await expect(driver.run(commandRequest, new AbortController().signal)).resolves.toBeUndefined();
    expect(native.exits()).toBe(1);
    expect(native.written.join("")).toContain("JS process failed: typst is no longer turned on in this VM");
    expect(TestWorker.latest).toBeUndefined();
  }
});
