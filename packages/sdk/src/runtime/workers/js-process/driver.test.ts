import { afterEach, expect, it, vi } from "vitest";
import { decodeJSIdentity } from "../../js-process/codec.js";
import { JsProcessWorkers } from "./driver.js";
import { record } from "../../decode.js";
import { JS_PROCESS_PROTOCOL_VERSION, jsMailboxAttention, Writer } from "../../js-process/codec.js";
import { HostAttention, postCounted } from "../../host-attention.js";
import { serveAttentionNotices } from "../attention-notices.js";
import type { UserspaceCommandHostRequest } from "../../userspace-command-abi.js";

class TestWorker {
  static latest: TestWorker | undefined;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  port: MessagePort | undefined;
  mailbox: SharedArrayBuffer | undefined;
  bootstrap: unknown;
  constructor() { TestWorker.latest = this; }
  postMessage(value: unknown): void {
    this.bootstrap = value;
    const bootstrap = record(value, "test bootstrap"), port = bootstrap["port"], mailbox = bootstrap["mailbox"];
    if (port instanceof MessagePort) this.port = port;
    if (mailbox instanceof SharedArrayBuffer) this.mailbox = mailbox;
  }
  terminate(): void { this.terminated = true; this.port?.close(); }
}
afterEach(() => { vi.unstubAllGlobals(); TestWorker.latest = undefined; });

/** Rust's notice for a late failure: PID 3, session 1 and an empty record file. */
const NOTICE = Uint8Array.from([...new TextEncoder().encode("OXAF"), 1, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, ...new TextEncoder().encode("OXAK"), 1, 0, 0, 0, 0, 0, 0, 0]);

function runtime(deferExit = false) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let active = true, exits = 0, length = 0, resultLength = 1;
  const submitted: number[] = [], written: string[] = [], reports: { readonly kind: number; readonly detail: string }[] = [];
  const callbacks = [
    (size: number) => { length = size; return 0; }, () => 0,
    () => {
      const bytes = new Uint8Array(memory.buffer), operation = bytes[4];
      if (operation === 5) {
        reports.push({ kind: bytes[21] ?? 0, detail: new TextDecoder().decode(bytes.subarray(23, 23 + (bytes[22] ?? 0))) });
        bytes.set(NOTICE); resultLength = NOTICE.byteLength; return 0;
      }
      resultLength = operation === 2 ? 8 : 1;
      if (operation === 2) new DataView(memory.buffer).setBigInt64(0, BigInt(length - 22), true);
      else bytes[0] = Number(active);
      return 0;
    },
    () => resultLength, () => { exits++; if (!deferExit) active = false; return 0; }, () => { resultLength = 0; return 0; },
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
  return { instance, memory, submitted, written, reports, retire: () => { active = false; }, exits: () => exits };
}
const request: UserspaceCommandHostRequest = {
  kind: "command", ...decodeJSIdentity(1n, 1n), pid: 3, tty: false, cwd: "/workspace", program: { kind: "typescript", entry: "/workspace/node_modules/.bun/typescript@6.0.2/node_modules/typescript/bin/tsc", executable: "/usr/bin/node" }, args: ["--noEmit"], environment: [],
};

it("forwards metadata, mask and PATH operations, then rejects an unknown operation before Rust submission", async () => {
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
    port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence: 4, sync: false, operation: 65550, payload: new Uint8Array() });
    await running;
    expect(native.submitted).toEqual([65545, 65547, 65548, 1]);
    expect(native.exits()).toBe(1);
  } finally { native.retire(); driver.reconcile(); await running; }
});

it("exits an admitted native command when its isolated execution capability is absent", async () => {
  const native = runtime(), driver = new JsProcessWorkers({ runtime: native, active: () => true, wake: () => {} });
  await expect(driver.run({ ...request, cwd: "/workspace/swc", program: { kind: "native-node", entry: "/workspace/swc/build.cjs", source: { kind: "file" }, input: 3, output: 4, context: { kind: "main" }, profile: { runtime: "node", executable: "/usr/bin/node", runtimeSHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", identity: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/swc/node_modules" }], basis: "no-addons", dependencyGeneration: 11n, artifacts: [], moduleSearchPaths: [], requiredCapabilities: 0 } } }, new AbortController().signal)).resolves.toBeUndefined();
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
  const native = runtime(true), driver = new JsProcessWorkers({ runtime: native, interceptor: "https://example.test/tsc.js", active: () => true, wake: () => {} });
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

const NATIVE_PROGRAM = { kind: "native-node", entry: "/workspace/swc/build.cjs", source: { kind: "file" }, input: 3, output: 4, context: { kind: "main" }, profile: { runtime: "node", executable: "/usr/bin/node", runtimeSHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", identity: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/swc/node_modules" }], basis: "no-addons", dependencyGeneration: 11n, artifacts: [], moduleSearchPaths: [], requiredCapabilities: 0 } } as const;

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
