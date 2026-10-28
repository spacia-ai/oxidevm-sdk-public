import { expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { JS_MAILBOX_BYTES, JS_PROCESS_PROTOCOL_VERSION, LinuxError, Reader, Writer } from "../../js-process/codec.js";
import { LinuxClient } from "../../js-process/transport.js";
import { NativeProcessIO } from "./process-io.js";
import { createNativeChildren } from "../assistance/node-children.js";
import { createAsyncContext } from "../assistance/async-context.js";
import { createInputStream } from "../assistance/node-streams.js";

it("routes process.kill to Rust with the visible PID and preserves Linux errors", () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const io = new NativeProcessIO(client, { post() {}, failed(error) { throw error; }, externalPending: () => false });
  const signal = vi.spyOn(client, "sync").mockImplementation(operation => {
    expect(operation.number).toBe(62);
    const payload = new Reader(operation.payload);
    expect(payload.u32()).toBe(42); expect(payload.u8()).toBe(2); payload.end();
    return operation.decode({ value: 0n, bytes: new Uint8Array() });
  });
  try {
    io.signalProcess(42, 2);
    signal.mockImplementation(() => { throw new LinuxError(3); });
    assert.throws(() => io.signalProcess(99, 0), { code: "ESRCH", errno: -3, syscall: "kill" });
    assert.throws(() => io.signalProcess(-42, 2), { code: "FEATURE_NOT_AVAILABLE" });
    assert.throws(() => io.signalProcess(42, 65), { code: "EINVAL" });
  } finally { client.dispose(); channel.port2.close(); }
});

it("retains the actual native lookup failure stage without attempting a spawn", () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const io = new NativeProcessIO(client, { post() {}, failed(error) { throw error; }, externalPending: () => false }), operations: number[] = [];
  vi.spyOn(client, "sync").mockImplementation(operation => { operations.push(operation.number); throw new LinuxError(2); });
  try {
    let failure: unknown;
    try { io.captureSync({ kind: "spawn", command: "tool", args: [], cwd: ".", env: {} }, new Uint8Array(), 16, { runtime: "bun", path: "bin" }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ errno: -2, code: "ENOENT", syscall: "spawn-path-search" });
    expect(operations).toEqual([65548]);
  } finally { client.dispose(); channel.port2.close(); }
});

it("preserves post-launch Linux I/O errors after cleanup instead of labeling them as spawn errors", () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const io = new NativeProcessIO(client, { post() {}, failed(error) { throw error; }, externalPending: () => false }), failure = new LinuxError(5), closed: number[] = [], signals: number[] = [];
  vi.spyOn(client, "sync").mockImplementation(operation => {
    const reader = new Reader(operation.payload);
    if (operation.number === 65538) return operation.decode({ value: 9n, bytes: new Writer().u32(3).u32(4).u32(5).finish() });
    if (operation.number === 0) throw failure;
    if (operation.number === 3) closed.push(Number(reader.u64()));
    if (operation.number === 62) { expect(reader.u32()).toBe(9); signals.push(reader.u8()); }
    if (operation.number === 65549) {
      const count = reader.u32(), bytes = new Uint8Array(count * 8), view = new DataView(bytes.buffer);
      for (let index = 0; index < count; index++) { const fd = Number(reader.u64()), events = reader.u32(); view.setInt32(index * 8, fd, true); view.setUint16(index * 8 + 4, events, true); view.setUint16(index * 8 + 6, events, true); }
      return operation.decode({ value: BigInt(count), bytes });
    }
    return operation.decode({ value: 0n, bytes: new Uint8Array() });
  });
  try {
    let caught: unknown;
    try { io.captureSync({ kind: "spawn", command: "/bin/tool", args: [], cwd: ".", env: {} }, new Uint8Array(), 16); } catch (error) { caught = error; }
    expect(caught).toBe(failure); expect(closed.sort()).toEqual([3, 4, 5]); expect(signals).toEqual([9]);
  } finally { client.dispose(); channel.port2.close(); }
});

it.each(["manual", "data", "readable"] as const)("leaves unused stdin in Linux until %s consumption starts", async mode => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const failures: unknown[] = [], io = new NativeProcessIO(client, { post() {}, failed(error) { failures.push(error); }, externalPending: () => false });
  const input = createInputStream(createAsyncContext()), accepted = Promise.withResolvers<undefined>();
  const read = vi.spyOn(client, "call").mockImplementation(operation => {
    expect(operation.number).toBe(0);
    const payload = new Reader(operation.payload); expect(payload.u64()).toBe(0n); expect(payload.u64()).toBe(65536n); payload.end();
    return Promise.resolve(operation.decode({ value: 0n, bytes: new Uint8Array() }));
  });
  io.setInput(async bytes => { await input.receive(bytes); accepted.resolve(undefined); });
  try {
    io.ready(input.readRequested, input.closed);
    expect(read).not.toHaveBeenCalled(); expect(io.hasPending).toBe(false);
    if (mode === "manual") input.stream.read(0);
    else if (mode === "data") input.stream.on("data", () => {});
    else input.stream.on("readable", () => { input.stream.read(); });
    await accepted.promise;
    expect(read).toHaveBeenCalledTimes(1); expect(failures).toEqual([]); expect(io.hasPending).toBe(false);
  } finally { input.stream.destroy(); client.dispose(); channel.port2.close(); }
});

it("does not begin a deferred stdin read after process retirement", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const failures: unknown[] = [], io = new NativeProcessIO(client, { post() {}, failed(error) { failures.push(error); }, externalPending: () => false });
  const requested = Promise.withResolvers<undefined>(), failure = new Error("retired");
  const read = vi.spyOn(client, "call").mockImplementation(operation => Promise.resolve(operation.decode({ value: 0n, bytes: new Uint8Array() })));
  io.setInput(async () => {});
  try {
    io.ready(requested.promise, new AbortController().signal); io.fail(failure); requested.resolve(undefined);
    await Promise.resolve(); await Promise.resolve();
    expect(read).not.toHaveBeenCalled(); expect(failures).toEqual([failure]);
  } finally { client.dispose(); channel.port2.close(); }
});

it("reports a demanded stdin failure once without another Linux read", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const failed = Promise.withResolvers<unknown>(), failure = new LinuxError(5);
  const io = new NativeProcessIO(client, { post() {}, failed(error) { failed.resolve(error); }, externalPending: () => false });
  const input = createInputStream(createAsyncContext()), read = vi.spyOn(client, "call").mockRejectedValue(failure);
  io.setInput(bytes => input.receive(bytes));
  try {
    io.ready(input.readRequested, input.closed); expect(read).not.toHaveBeenCalled();
    input.stream.resume(); await expect(failed.promise).resolves.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1); expect(io.hasPending).toBe(false);
  } finally { input.stream.destroy(); client.dispose(); channel.port2.close(); }
});

it("retains stdin backpressure after the first consumer request", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const failures: unknown[] = [], io = new NativeProcessIO(client, { post() {}, failed(error) { failures.push(error); }, externalPending: () => false });
  const input = createInputStream(createAsyncContext()), received = Promise.withResolvers<undefined>(), ended = Promise.withResolvers<undefined>();
  let reads = 0;
  const read = vi.spyOn(client, "call").mockImplementation(operation => {
    expect(operation.number).toBe(0); const bytes = ++reads === 1 ? new Uint8Array(65536).fill(65) : new Uint8Array();
    return Promise.resolve(operation.decode({ value: BigInt(bytes.length), bytes }));
  });
  io.setInput(async bytes => { received.resolve(undefined); await input.receive(bytes); if (bytes === null) ended.resolve(undefined); });
  try {
    io.ready(input.readRequested, input.closed); expect(read).not.toHaveBeenCalled();
    input.stream.read(0); await received.promise;
    expect(read).toHaveBeenCalledTimes(1); expect(input.stream.readableLength).toBe(65536);
    const chunks: Uint8Array[] = [];
    input.stream.on("data", (chunk: unknown) => { if (!(chunk instanceof Uint8Array)) throw new Error("Expected input bytes"); chunks.push(chunk); });
    await ended.promise;
    expect(read).toHaveBeenCalledTimes(2); expect(chunks.reduce((sum, bytes) => sum + bytes.length, 0)).toBe(65536);
    expect(chunks.every(bytes => bytes.every(byte => byte === 65))).toBe(true); expect(failures).toEqual([]);
  } finally { input.stream.destroy(); client.dispose(); channel.port2.close(); }
});

it("cancels a demanded stdin read on destruction without delivering late data or failing the process", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const input = createInputStream(createAsyncContext()), accepted = Promise.withResolvers<undefined>(), cancelled = Promise.withResolvers<undefined>();
  const failures: unknown[] = [], io = new NativeProcessIO(client, { post() {}, failed(error) { failures.push(error); }, externalPending: () => false });
  const received = vi.fn(async (bytes: Uint8Array | null) => { await input.receive(bytes); }); io.setInput(received);
  const read = vi.spyOn(client, "call").mockImplementation((operation, signal) => {
    expect(operation.number).toBe(0); accepted.resolve(undefined);
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => { cancelled.resolve(undefined); reject(new LinuxError(4)); }, { once: true }));
  });
  try {
    io.ready(input.readRequested, input.closed); input.stream.resume(); await accepted.promise;
    input.stream.destroy(); await cancelled.promise; await Promise.resolve(); await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1); expect(received).not.toHaveBeenCalled(); expect(failures).toEqual([]);
  } finally { input.stream.destroy(); client.dispose(); channel.port2.close(); }
});

it.each(["before", "after"] as const)("leaves Linux stdin untouched when its consumer closes %s runtime readiness", async when => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const input = createInputStream(createAsyncContext()), failures: unknown[] = [];
  const io = new NativeProcessIO(client, { post() {}, failed(error) { failures.push(error); }, externalPending: () => false });
  const read = vi.spyOn(client, "call"); io.setInput(bytes => input.receive(bytes));
  try {
    if (when === "before") input.stream.destroy();
    io.ready(input.readRequested, input.closed);
    if (when === "after") input.stream.destroy();
    await Promise.resolve(); await Promise.resolve();
    expect(read).not.toHaveBeenCalled(); expect(failures).toEqual([]); expect(io.hasPending).toBe(false);
  } finally { input.stream.destroy(); client.dispose(); channel.port2.close(); }
});

it.each([new Uint8Array(), Uint8Array.of(1)])("discards an admitted stdin completion after consumer destruction: %j", async bytes => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const input = createInputStream(createAsyncContext()), accepted = Promise.withResolvers<undefined>(), completion = Promise.withResolvers<Uint8Array>();
  const failures: unknown[] = [], io = new NativeProcessIO(client, { post() {}, failed(error) { failures.push(error); }, externalPending: () => false });
  const received = vi.fn(async () => {}); io.setInput(received);
  const read = vi.spyOn(client, "call").mockImplementation(operation => {
    accepted.resolve(undefined); return completion.promise.then(data => operation.decode({ value: BigInt(data.length), bytes: data }));
  });
  try {
    io.ready(input.readRequested, input.closed); input.stream.resume(); await accepted.promise;
    input.stream.destroy(); completion.resolve(bytes); await completion.promise; await Promise.resolve(); await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1); expect(received).not.toHaveBeenCalled(); expect(failures).toEqual([]);
  } finally { input.stream.destroy(); client.dispose(); channel.port2.close(); }
});

it("does not turn an unrelated stdin failure into successful cancellation after close", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const abort = new AbortController(), started = Promise.withResolvers<undefined>(), completion = Promise.withResolvers<never>(), failed = Promise.withResolvers<unknown>();
  const failure = new LinuxError(5), io = new NativeProcessIO(client, { post() {}, failed(error) { failed.resolve(error); }, externalPending: () => false });
  vi.spyOn(client, "call").mockImplementation(() => { started.resolve(undefined); return completion.promise; }); io.setInput(async () => {});
  try {
    io.ready(Promise.resolve(undefined), abort.signal); await started.promise; abort.abort(); completion.reject(failure);
    await expect(failed.promise).resolves.toBe(failure);
  } finally { client.dispose(); channel.port2.close(); }
});

it("forwards connect cancellation and rejects unsupported cancellation before Linux effects", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const io = new NativeProcessIO(client, { post() {}, failed(error) { throw error; }, externalPending: () => false });
  const abort = new AbortController();
  const call = vi.spyOn(client, "call").mockImplementation((operation, signal) => {
    expect(operation.number).toBe(41); expect(signal).toBe(abort.signal); return Promise.reject(new LinuxError(125));
  });
  try {
    await expect(io.call({ kind: "close", fd: 8 }, true, abort.signal)).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
    expect(call).not.toHaveBeenCalled(); expect(io.hasPending).toBe(false);
    await expect(io.call({ kind: "socket-connect-local", address: { address: "::1", port: 8080 } }, true, abort.signal)).resolves.toMatchObject({ kind: "error", errno: 125, code: "ECANCELED" });
    expect(call).toHaveBeenCalledTimes(1); expect(io.hasPending).toBe(false);
  } finally { client.dispose(); channel.port2.close(); }
});

it("passes the application status to native retirement before posting exit", () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const exiting = vi.fn(), post = vi.fn(), halted = new Error("halted");
  const io = new NativeProcessIO(client, { exiting, post, failed(error) { throw error; }, externalPending: () => false });
  vi.spyOn(io, "halt").mockImplementation(() => { throw halted; });
  try {
    expect(() => io.terminate(23)).toThrow(halted);
    expect(exiting).toHaveBeenCalledWith(23);
    expect(post).toHaveBeenCalledWith({ version: JS_PROCESS_PROTOCOL_VERSION, type: "exit", code: 23 });
    expect(exiting.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0] ?? 0);
  } finally { client.dispose(); channel.port2.close(); }
});

it("inherits stderr through Rust spawn and closes a mixed-stdio child after its piped EOF", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const failures: unknown[] = [], io = new NativeProcessIO(client, { post() {}, failed(error) { failures.push(error); }, externalPending: () => false });
  vi.spyOn(client, "sync").mockImplementation(operation => {
    expect(operation.number).toBe(65538); expect(operation.payload.at(-1)).toBe(3);
    return operation.decode({ value: 10n, bytes: new Writer().u32(20).u32(21).u32(0xffff_ffff).finish() });
  });
  vi.spyOn(client, "call").mockImplementation(operation => Promise.resolve(operation.decode({ value: 0n, bytes: new Uint8Array() })));
  const runtime = createNativeChildren(io, createAsyncContext(), {});
  try {
    const child = runtime.spawn("/bin/true", [], { stdio: ["pipe", "pipe", "inherit"] });
    const closed = new Promise<unknown[]>(resolve => child.on("close", (...args: unknown[]) => resolve(args)));
    expect(await closed).toEqual([0, null]); await runtime.idle();
    expect(runtime.hasPending).toBe(false); expect(failures).toEqual([]);
  } finally { client.dispose(); channel.port2.close(); }
});

it("preserves rejection promise identity through scheduled process delivery", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const io = new NativeProcessIO(client, { post() {}, failed(error) { throw error; }, externalPending: () => false });
  const promise = Promise.resolve(), error = new Error("rejected"), delivered = Promise.withResolvers<undefined>();
  io.setExceptionHandler((reason, origin, rejected) => {
    expect(reason).toBe(error); expect(origin).toBe("unhandledRejection"); expect(rejected).toBe(promise); delivered.resolve(undefined); return true;
  });
  try { io.applicationException(error, "unhandledRejection", promise); await delivered.promise; }
  finally { client.dispose(); channel.port2.close(); }
});

it("drains short writes before exit and bounds runtime activity without duplicate release", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const chunks: string[] = [], io = new NativeProcessIO(client, { post: () => { throw new Error("Unexpected worker event"); }, failed: () => { throw new Error("Unexpected worker failure"); }, externalPending: () => false });
  vi.spyOn(client, "sync").mockImplementation(operation => {
    if (operation.number !== 1) throw new Error("Unexpected write request");
    const reader = new Reader(operation.payload); expect(reader.u64()).toBe(1n);
    const bytes = reader.blob(); reader.end(); chunks.push(new TextDecoder().decode(bytes));
    return operation.decode({ value: BigInt(Math.min(bytes.length, 2)), bytes: new Uint8Array() });
  });
  try {
    io.output("stdout", new TextEncoder().encode("abc"));
    expect(chunks).toEqual(["abc", "c"]); await io.drain(); expect(io.hasPending).toBe(false);
    const retained = Array.from({ length: 256 }, () => io.retain());
    expect(() => io.retain()).toThrow(/capacity/u); retained.forEach(release => release());
    expect(() => retained[0]?.()).toThrow(/twice/u); expect(io.hasPending).toBe(false);
  } finally { client.dispose(); channel.port2.close(); }
});

it("forks through Rust spawn and connects the shared IPC owner to its admitted child", async () => {
  const channel = new MessageChannel(), control = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const io = new NativeProcessIO(client, { post() {}, failed(error) { throw error; }, externalPending: () => false, fork: { control: control.port1, executable: "/usr/bin/node" } });
  vi.spyOn(client, "sync").mockImplementation(operation => {
    if (operation.number !== 65538) throw new Error("Unexpected fork request");
    const bytes = operation.payload; expect(bytes.at(-1)).toBe(15);
    return operation.decode({ value: 10n, bytes: new Writer().u32(20).u32(21).u32(22).u64(42n).finish() });
  });
  vi.spyOn(client, "call").mockImplementation(operation => Promise.resolve(operation.decode({ value: 0n, bytes: new Uint8Array() })));
  const connected = Promise.withResolvers<MessagePort>(), exited = Promise.withResolvers<undefined>();
  io.setForkEvents({ channel(child, port) { expect(child).toBe(10); connected.resolve(port); }, output() { throw new Error("Unexpected output"); }, exit(child, termination) { expect(child).toBe(10); expect(termination).toEqual({ kind: "exit", code: 0 }); exited.resolve(undefined); } });
  const routing = new Promise<unknown>(resolve => { control.port2.onmessage = event => { const data: unknown = event.data; resolve(data); }; control.port2.start(); });
  try {
    expect(io.forkSync({ entry: "/workspace/child.cjs", cwd: "/workspace", env: {}, args: [], execArgv: [], silent: true })).toEqual({ kind: "spawned", process: 10, pid: 10 });
    expect(await routing).toMatchObject({ type: "prepare", child: 42n });
    (await connected.promise).close(); await exited.promise;
  } finally { client.dispose(); channel.port2.close(); control.port1.close(); control.port2.close(); }
});
