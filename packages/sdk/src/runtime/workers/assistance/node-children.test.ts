import { ProcessScheduler } from "./process-scheduler.ts";
import { Buffer } from "buffer";
import { expect, it, vi } from "vitest";
import { createNativeChildren } from "./node-children.js";
import { createAsyncContext } from "./async-context.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import type { AssistanceEvent } from "../../protocol/assistance-event.js";
import { Readable, Writable } from "./node-streams.js";

function piped(child: { readonly stdin: unknown; readonly stdout: unknown; readonly stderr: unknown }) {
  const { stdin, stdout, stderr } = child;
  if (!(stdin instanceof Writable) || !(stdout instanceof Readable) || !(stderr instanceof Readable)) throw new Error("expected a piped child");
  return { stdin, stdout, stderr };
}

it("keeps inherited stdio in Rust and supports Node child references", async () => {
  const calls: unknown[] = [];
  const runtime = createNativeChildren({ setChildEvents() {},
    spawnSync(operation, stdio) { calls.push({ operation, stdio }); return { kind: "spawned", child: 1, pid: 42 }; },
    callSync() { throw new Error("Inherited descriptors must use the native spawn owner"); },
    call: () => Promise.resolve({ kind: "unit" }),
  }, createAsyncContext(), { PATH: "/bin" });
  const child = runtime.spawn("/bin/esbuild", ["--service"], { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
  expect(child.stdin).not.toBeNull(); expect(child.stdout).not.toBeNull(); expect(child.stderr).toBeNull();
  expect(calls).toEqual([{ operation: { kind: "spawn", command: "/bin/esbuild", args: ["--service"], cwd: ".", env: { PATH: "/bin" } }, stdio: { stdin: "pipe", stdout: "pipe", stderr: "inherit" } }]);
  await Promise.resolve(); await Promise.resolve();
  expect(runtime.hasPending).toBe(true); expect(child.unref()).toBe(child); await runtime.idle();
  expect(runtime.hasPending).toBe(false); expect(child.ref()).toBe(child); expect(runtime.hasPending).toBe(true);
  child.unref();
  expect(() => runtime.spawn("/bin/true", [], { windowsHide: "yes" })).toThrow();
});

it("reports native spawn errno and arguments before asynchronous close without emitting exit", async () => {
  const runtime = createNativeChildren({ setChildEvents() {},
    callSync: () => ({ kind: "error", errno: 2, code: "ENOENT", syscall: "spawn", path: "/missing", destination: null }),
    call: () => Promise.resolve({ kind: "unit" }),
  }, createAsyncContext(), {});
  const child = runtime.spawn("/missing", ["one"]);
  const order: string[] = [];
  let failure: unknown;
  child.on("error", error => {
    failure = error; order.push("error");
    expect(child.exitCode).toBe(-2);
    queueMicrotask(() => { order.push("microtask"); });
  });
  child.on("exit", () => { order.push("exit"); });
  const closed = Promise.withResolvers<unknown[]>();
  child.on("close", (code, signal) => { order.push("close"); closed.resolve([code, signal]); });
  expect(await closed.promise).toEqual([-2, null]);
  expect(failure).toMatchObject({ code: "ENOENT", errno: -2, syscall: "spawn /missing", path: "/missing", spawnargs: ["one"] });
  expect(order).toEqual(["error", "microtask", "close"]);
  await runtime.idle();
  expect(runtime.hasPending).toBe(false);
});

it("preserves native output, partial stdin, EOF, and exit/close ordering", async () => {
  let receive: ((event: AssistanceEvent) => void) | undefined;
  const operations: AssistanceOperation[] = [];
  const runtime = createNativeChildren({
    setChildEvents(callback) { receive = callback; },
    callSync(operation): AssistanceResult { operations.push(operation); return { kind: "spawned", child: 1, pid: 42 }; },
    call(operation): Promise<AssistanceResult> {
      operations.push(operation);
      if (operation.kind === "spawn") return Promise.resolve({ kind: "spawned", child: 1, pid: 42 });
      if (operation.kind === "stdin") return Promise.resolve({ kind: "written", count: Math.min(2, operation.bytes.length) });
      return Promise.resolve({ kind: "unit" });
    },
  }, createAsyncContext(), { PATH: "/bin" });
  const child = runtime.spawn("/bin/sh", ["-c", "cat"]);
  const streams = piped(child);
  const order: string[] = []; const chunks: unknown[] = [];
  child.on("exit", () => { order.push("exit"); });
  streams.stdout.on("end", () => { order.push("stdout-end"); });
  streams.stdout.on("close", () => { order.push("stdout-close"); });
  const closed = Promise.withResolvers<undefined>();
  child.on("close", () => { order.push("close"); closed.resolve(undefined); });
  streams.stdout.on("data", value => { chunks.push(value); });
  const written = Promise.withResolvers<undefined>();
  streams.stdin.write("abc", error => { if (error) written.reject(error); else written.resolve(undefined); });
  await written.promise;
  const finished = Promise.withResolvers<undefined>();
  streams.stdin.end(() => finished.resolve(undefined));
  await finished.promise;
  expect(operations.filter(op => op.kind === "stdin").map(op => op.bytes.length)).toEqual([3, 1]);
  expect(operations.at(-1)?.kind).toBe("close-stdin");
  const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 1 };
  const emit = (sequence: number, event: AssistanceEvent["event"]) => {
    if (receive === undefined) throw new Error("missing events");
    receive({ ...identity, sequence, event });
  };
  emit(1, { kind: "output", child: 1, stream: "stdout", bytes: Uint8Array.of(65) });
  emit(2, { kind: "exit", child: 1, code: 0, signal: null });
  expect(order).toEqual(["exit"]);
  emit(3, { kind: "eof", child: 1, stream: "stdout" });
  emit(4, { kind: "eof", child: 1, stream: "stderr" });
  await closed.promise;
  expect(order).toEqual(["exit", "stdout-end", "stdout-close", "close"]);
  expect(chunks).toEqual([Buffer.from([65])]);
  expect(runtime.hasPending).toBe(false);
});

it("returns flowing output credit before a synchronous data callback can request Linux I/O", async () => {
  let receive: ((event: AssistanceEvent) => void) | undefined;
  const operations: string[] = [];
  const runtime = createNativeChildren({ setChildEvents(callback) { receive = callback; },
    callSync(operation): AssistanceResult { operations.push(operation.kind); return { kind: "spawned", child: 1, pid: 42 }; },
    call(operation): Promise<AssistanceResult> {
      operations.push(operation.kind);
      return Promise.resolve(operation.kind === "spawn" ? { kind: "spawned", child: 1, pid: 42 } : { kind: "unit" });
    },
  }, createAsyncContext(), {});
  const child = runtime.spawn("/bin/sh", ["-c", "printf data"]);
  const streams = piped(child);
  const closed = new Promise(resolve => child.on("close", resolve));
  streams.stdout.on("data", () => { operations.push("callback-sync-read"); });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(streams.stdout.readableFlowing).toBe(true);
  const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 1 };
  const emit = (sequence: number, event: AssistanceEvent["event"]) => {
    if (receive === undefined) throw new Error("missing events");
    receive({ ...identity, sequence, event });
  };
  emit(1, { kind: "output", child: 1, stream: "stdout", bytes: new Uint8Array(65536) });
  const observed = operations.slice();
  emit(2, { kind: "exit", child: 1, code: 0, signal: null });
  emit(3, { kind: "eof", child: 1, stream: "stdout" });
  emit(4, { kind: "eof", child: 1, stream: "stderr" });
  await closed;
  expect(observed).toEqual(["spawn", "ack", "callback-sync-read"]);
});

it("creates the native child before returning but emits spawn after listeners attach", async () => {
  const order: string[] = [];
  const runtime = createNativeChildren({ setChildEvents() {},
    callSync(operation): AssistanceResult {
      expect(operation.kind).toBe("spawn");
      order.push("Linux spawn");
      return { kind: "spawned", child: 1, pid: 42 };
    },
    call: () => Promise.resolve({ kind: "spawned", child: 1, pid: 42 }),
  }, createAsyncContext(), {});
  const child = runtime.spawn("/bin/sh", []);
  order.push("return");
  child.on("spawn", () => { order.push("spawn event"); });
  expect(child.pid).toBe(42);
  expect(order).toEqual(["Linux spawn", "return"]);
  await Promise.resolve();
  expect(order).toEqual(["Linux spawn", "return", "spawn event"]);
});

it("normalizes a spawn environment like Node before Linux admission", () => {
  const operations: AssistanceOperation[] = [];
  const runtime = createNativeChildren({ setChildEvents() {},
    callSync(operation) { operations.push(operation); return { kind: "spawned", child: 1, pid: 42 }; },
    call: () => Promise.resolve({ kind: "unit" }),
  }, createAsyncContext(), { INHERITED: "unused" });
  runtime.spawn("/bin/sh", [], { env: { UNSET: undefined, PORT: 3000, NAME: "next" } });
  const operation = operations[0];
  expect(operation?.kind === "spawn" ? operation.env : undefined).toEqual({ PORT: "3000", NAME: "next" });
  expect(() => runtime.spawn("/bin/sh", [], { env: { BAD: "a\0b" } })).toThrow(/null bytes/u);
});

it("normalizes native spawn argument overloads before Linux admission", async () => {
  const options = { cwd: "/workspace/app", env: { TEST: "value" } };
  const calls: readonly (readonly unknown[])[] = [
    [options], [undefined, options], [null, options], [[], options],
    [options, { cwd: "/ignored" }],
  ];
  for (const args of calls) {
    const operations: AssistanceOperation[] = [];
    const runtime = createNativeChildren({ setChildEvents() {},
      callSync(operation) {
        operations.push(operation);
        return { kind: "error", errno: 2, code: "ENOENT", syscall: "spawn", path: "/missing", destination: null };
      },
      call: () => Promise.resolve({ kind: "unit" }),
    }, createAsyncContext(), { INHERITED: "unused" });
    const child = runtime.spawn("/missing", ...args);
    child.on("error", () => {});
    await new Promise(resolve => child.on("close", resolve));
    await runtime.idle();
    expect(operations).toEqual([{ kind: "spawn", command: "/missing", args: [], ...options }]);
  }
});

it("emits native spawn in the process tick queue before later ticks and promises", async () => {
  const context = createAsyncContext();
  const errors: unknown[] = [];
  const scheduler = new ProcessScheduler(context, error => errors.push(error));
  const runtime = createNativeChildren({
    setChildEvents() {},
    callSync: () => ({ kind: "spawned", child: 1, pid: 42 }),
    call: () => Promise.resolve({ kind: "unit" }),
  }, context, {}, scheduler);
  const order: string[] = [];
  try {
    scheduler.run(() => {
      const child = runtime.spawn("/bin/true");
      child.on("spawn", () => order.push("spawn"));
      scheduler.nextTick(() => order.push("later tick"));
      void Promise.resolve().then(() => order.push("promise"));
      order.push("returned");
    });
    await scheduler.idle();
    expect(order).toEqual(["returned", "spawn", "later tick", "promise"]);
    expect(errors).toEqual([]);
  } finally { scheduler.dispose(); }
});

it("keeps internal service children owned while their resource controls process lifetime", async () => {
  let receive: ((event: AssistanceEvent) => void) | undefined;
  const operations: AssistanceOperation[] = [];
  const runtime = createNativeChildren({ setChildEvents(callback) { receive = callback; },
    callSync: operation => { operations.push(operation); return operation.kind === "signal" ? { kind: "unit" } : { kind: "spawned", child: 1, pid: 42 }; },
    call: operation => { operations.push(operation); return Promise.resolve({ kind: "unit" }); },
  }, createAsyncContext(), {});
  const service = runtime.spawnService("/usr/bin/node", ["-e", "setInterval(()=>{},1000)"]);
  const output: unknown[] = []; const received = new Promise<void>(resolve => service.stdout.on("data", value => { output.push(value); resolve(); }));
  await runtime.idle(); expect(runtime.hasPending).toBe(false);
  const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 1 };
  const emit = (sequence: number, event: AssistanceEvent["event"]) => {
    if (receive === undefined) throw new Error("Missing service events");
    receive({ ...identity, sequence, event });
  };
  emit(1, { kind: "output", child: 1, stream: "stdout", bytes: Buffer.from("service") });
  await received; expect(output).toEqual([Buffer.from("service")]);
  expect(service.kill("SIGKILL")).toBe(true);
  const closed = new Promise(resolve => service.on("close", resolve));
  emit(2, { kind: "exit", child: 1, code: null, signal: 9 });
  emit(3, { kind: "eof", child: 1, stream: "stdout" }); emit(4, { kind: "eof", child: 1, stream: "stderr" });
  await closed;
  expect(operations).toContainEqual({ kind: "signal", child: 1, signal: "KILL" });
  expect(service.signalCode).toBe("SIGKILL"); expect(runtime.hasPending).toBe(false);
});

it("does not emit a child error when a concurrent group signal has already retired the PID", async () => {
  const errors: unknown[] = [];
  const io = { setChildEvents() {},
    callSync: (operation: AssistanceOperation): AssistanceResult => operation.kind === "spawn" ? { kind: "spawned", child: 1, pid: 42 }
      : { kind: "error", errno: 3, code: "ESRCH", syscall: "signal", path: null, destination: null },
    call: (): Promise<AssistanceResult> => Promise.resolve({ kind: "error", errno: 3, code: "ESRCH", syscall: "signal", path: null, destination: null }),
  };
  const child = createNativeChildren(io, createAsyncContext(), {}).spawn("tool");
  child.on("error", error => { errors.push(error); });
  await Promise.resolve(); await Promise.resolve();
  expect(child.kill("SIGINT")).toBe(false);
  expect(child.killed).toBe(false);
  await Promise.resolve();
  expect(errors).toEqual([]);
});

it("admits detached and ignored-stdio native children by acknowledging their output for them", async () => {
  let receive: ((event: AssistanceEvent) => void) | undefined;
  const operations: AssistanceOperation[] = [];
  const runtime = createNativeChildren({
    setChildEvents(callback) { receive = callback; },
    callSync(operation): AssistanceResult { operations.push(operation); return { kind: "spawned", child: 1, pid: 42 }; },
    call(operation): Promise<AssistanceResult> { operations.push(operation); return Promise.resolve({ kind: "unit" }); },
  }, createAsyncContext(), { PATH: "/bin" });
  const child = runtime.spawn("/usr/bin/node", ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  expect(child.stdin).toBeNull(); expect(child.stdout).toBeNull(); expect(child.stderr).toBeNull();
  expect(child.stdio).toEqual([null, null, null]);
  const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 1 };
  const emit = (sequence: number, event: AssistanceEvent["event"]) => {
    if (receive === undefined) throw new Error("missing events");
    receive({ ...identity, sequence, event });
  };
  emit(1, { kind: "output", child: 1, stream: "stdout", bytes: Uint8Array.of(65) });
  await vi.waitFor(() => expect(operations.filter(op => op.kind === "ack")).toEqual([{ kind: "ack", child: 1, stream: "stdout", sequence: 1, bytes: 1 }]));
  const closed = Promise.withResolvers<unknown[]>();
  child.on("close", (code, signal) => closed.resolve([code, signal]));
  emit(2, { kind: "exit", child: 1, code: 0, signal: null });
  emit(3, { kind: "eof", child: 1, stream: "stdout" });
  emit(4, { kind: "eof", child: 1, stream: "stderr" });
  expect(await closed.promise).toEqual([0, null]);
  const mixed = runtime.spawn("/bin/true", [], { stdio: ["ignore", "pipe", "ignore"] });
  expect(mixed.stdin).toBeNull(); expect(mixed.stdout).not.toBeNull(); expect(mixed.stderr).toBeNull();
  expect(() => runtime.spawn("/bin/true", [], { stdio: "inherit" })).toThrow();
  expect(() => runtime.spawn("/bin/true", [], { stdio: ["ignore", "pipe", "ipc"] })).toThrow();
  expect(() => runtime.spawn("/bin/true", [], { detached: "yes" })).toThrow();
});
