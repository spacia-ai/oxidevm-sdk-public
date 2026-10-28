import { ProcessScheduler } from "./process-scheduler.ts";
import { Buffer } from "buffer";
import { afterEach, expect, it, vi } from "vitest";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { createAsyncContext } from "./async-context.js";
import { createNodeSockets } from "./node-socket.js";

const schedulers: ProcessScheduler[] = [];
afterEach(() => { for (const scheduler of schedulers.splice(0)) scheduler.dispose(); });
function schedulerFor(context: ReturnType<typeof createAsyncContext>, enabled: boolean): ProcessScheduler | undefined {
  if (!enabled) return undefined;
  const scheduler = new ProcessScheduler(context, error => { throw error; });
  schedulers.push(scheduler);
  return scheduler;
}

const connected = { kind: "socket", fd: 7, local: { address: "127.0.0.1", port: 1234 },
  peer: { address: "127.0.0.1", port: 3000 } } as const;

it.each([false, true])("writes through a blocked read, handles partial writes and half-close, and preserves callback context (scheduler=%s)", async scheduled => {
  const context = createAsyncContext(); const store = new context.AsyncLocalStorage<string>();
  const read = Promise.withResolvers<AssistanceResult>();
  const operations: AssistanceOperation[] = []; const written: Uint8Array[] = [];
  let references = 0;
  const net = createNodeSockets({ callSync() { return connected; },
    retain() { references++; return () => { references--; }; },
    call(operation) {
      operations.push(operation);
      if (operation.kind === "socket-connect-local") return Promise.resolve(connected);
      if (operation.kind === "socket-read") return read.promise;
      if (operation.kind === "socket-write") {
        const count = Math.min(3, operation.bytes.length);
        written.push(operation.bytes.slice(0, count));
        return Promise.resolve({ kind: "written", count });
      }
      if (operation.kind === "socket-shutdown") read.resolve({ kind: "data", bytes: new Uint8Array() });
      return Promise.resolve({ kind: "unit" });
    },
  }, context, schedulerFor(context, scheduled));
  const socket = net.connect(3000, "127.0.0.1");
  const errors: unknown[] = []; socket.on("error", error => errors.push(error));
  const closed = new Promise(resolve => socket.once("close", resolve));
  const done = store.run("write", () => new Promise<string | undefined>((resolve, reject) => {
    socket.write("abcdefg", error => { if (error) reject(error); else resolve(store.getStore()); });
  }));
  store.enterWith("outside");
  expect(await done).toBe("write");
  expect(Buffer.concat(written).toString()).toBe("abcdefg");
  expect(socket.bytesWritten).toBe(7);
  expect(operations.filter(op => op.kind === "socket-read")).toHaveLength(1);
  expect(socket.address()).toEqual({ address: "127.0.0.1", port: 1234, family: "IPv4" });
  socket.end();
  await closed;
  expect(errors).toEqual([]);
  expect(operations.at(-1)?.kind).toBe("socket-close");
  expect(references).toBe(0);
});

it.each([false, true])("closes a connection acquired after destroy without emitting connect or leaking its reference (scheduler=%s)", async scheduled => {
  const context = createAsyncContext();
  const opening = Promise.withResolvers<AssistanceResult>();
  const operations: AssistanceOperation[] = []; let references = 0;
  const net = createNodeSockets({ callSync: () => connected,
    retain() { references++; return () => { references--; }; },
    call(operation) { operations.push(operation); return operation.kind === "socket-connect-local" ? opening.promise : Promise.resolve({ kind: "unit" }); },
  }, context, schedulerFor(context, scheduled));
  const socket = net.connect({ host: "127.0.0.1", port: 3000 });
  const connect = vi.fn(); socket.on("connect", connect);
  const closed = new Promise(resolve => socket.once("close", resolve));
  socket.destroy();
  expect(references).toBe(1);
  opening.resolve(connected);
  await closed;
  expect(connect).not.toHaveBeenCalled();
  expect(operations.map(op => op.kind)).toEqual(["socket-connect-local", "socket-close"]);
  expect(references).toBe(0);
});

it.each([false, true])("stops reading at stream backpressure and supports ref/unref without dropping native ownership (scheduler=%s)", async scheduled => {
  const context = createAsyncContext();
  const reads: PromiseWithResolvers<AssistanceResult>[] = []; let references = 0;
  const net = createNodeSockets({ callSync: () => connected,
    retain() { references++; return () => { references--; }; },
    call(operation) {
      if (operation.kind === "socket-read") { const result = Promise.withResolvers<AssistanceResult>(); reads.push(result); return result.promise; }
      return Promise.resolve({ kind: "unit" });
    },
  }, context, schedulerFor(context, scheduled));
  const socket = new net.Socket({ fd: 7, highWaterMark: 4 });
  const closed = new Promise(resolve => socket.once("close", resolve));
  expect(references).toBe(1);
  socket.unref(); socket.unref(); expect(references).toBe(0);
  socket.ref(); socket.ref(); expect(references).toBe(1);
  socket.read(0);
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  reads[0]?.resolve({ kind: "data", bytes: Buffer.from("abcd") });
  await vi.waitFor(() => expect(socket.readableLength).toBe(4));
  expect(reads).toHaveLength(1);
  expect(socket.read(4)).toEqual(Buffer.from("abcd"));
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  socket.destroy(); reads[1]?.resolve({ kind: "data", bytes: new Uint8Array() });
  await closed;
  expect(references).toBe(0);
});

it.each([false, true])("retains distinct async contexts for writes queued behind another write (scheduler=%s)", async scheduled => {
  const context = createAsyncContext(); const store = new context.AsyncLocalStorage<string>();
  const read = Promise.withResolvers<AssistanceResult>();
  const firstWrite = Promise.withResolvers<AssistanceResult>(); let writes = 0;
  const net = createNodeSockets({ callSync: () => connected, retain: () => () => {},
    call(operation) {
      if (operation.kind === "socket-read") return read.promise;
      if (operation.kind === "socket-write") return ++writes === 1 ? firstWrite.promise : Promise.resolve({ kind: "written", count: operation.bytes.length });
      if (operation.kind === "socket-shutdown") read.resolve({ kind: "data", bytes: new Uint8Array() });
      return Promise.resolve({ kind: "unit" });
    },
  }, context, schedulerFor(context, scheduled));
  const socket = new net.Socket({ fd: 7 });
  const closed = new Promise(resolve => socket.once("close", resolve)); socket.resume();
  const pending = ["first", "second"].map(label => store.run(label, () => new Promise(resolve => {
    socket.write("x", () => resolve(store.getStore()));
  })));
  store.enterWith("outside");
  firstWrite.resolve({ kind: "written", count: 1 });
  expect(await Promise.all(pending)).toEqual(["first", "second"]);
  socket.end(); await closed;
});

it.each([false, true])("emits an inactivity timeout in listener context without closing the Linux socket (scheduler=%s)", async scheduled => {
  const context = createAsyncContext(); const store = new context.AsyncLocalStorage<string>();
  const operations: AssistanceOperation[] = [];
  const net = createNodeSockets({ callSync: () => connected, retain: () => () => {},
    call(operation) { operations.push(operation); return Promise.resolve({ kind: "unit" }); },
  }, context, schedulerFor(context, scheduled));
  const socket = new net.Socket({ fd: 7 });
  const timeout = store.run("timeout", () => new Promise(resolve => socket.setTimeout(5, () => resolve(store.getStore()))));
  store.enterWith("outside");
  expect(await timeout).toBe("timeout");
  expect(socket.destroyed).toBe(false); expect(operations).toEqual([]);
  const cancelled = vi.fn(); socket.setTimeout(5, cancelled); socket.setTimeout(0, cancelled);
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(cancelled).not.toHaveBeenCalled();
  for (const value of [-1, NaN, Infinity, "5"]) expect(() => socket.setTimeout(value)).toThrow();
  const overflow = vi.fn(); socket.setTimeout(0x8000_0000, overflow);
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(overflow).not.toHaveBeenCalled(); socket.setTimeout(0, overflow);
  const retired = vi.fn(); socket.setTimeout(5, retired);
  const close = new Promise(resolve => socket.once("close", resolve)); socket.destroy(); await close;
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(retired).not.toHaveBeenCalled();
});

it.each([false, true])("refreshes inactivity deadlines when Linux acknowledges socket traffic (scheduler=%s)", async scheduled => {
  const context = createAsyncContext();
  const net = createNodeSockets({ callSync: () => connected, retain: () => () => {},
    call(operation) {
      return Promise.resolve(operation.kind === "socket-write" ? { kind: "written", count: operation.bytes.length } : { kind: "unit" });
    },
  }, context, schedulerFor(context, scheduled));
  const socket = new net.Socket({ fd: 7 }); let expired = false;
  const timeout = new Promise(resolve => socket.setTimeout(30, () => { expired = true; resolve(undefined); }));
  await new Promise(resolve => setTimeout(resolve, 20));
  await new Promise<void>((resolve, reject) => socket.write("x", error => { if (error) reject(error); else resolve(); }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(expired).toBe(false); await timeout;
  const closed = new Promise(resolve => socket.once("close", resolve)); socket.destroy(); await closed;
});

it("does not adopt application thenables when destroying a socket after read failure", async () => {
  const context = createAsyncContext();
  const scheduler = schedulerFor(context, true);
  const net = createNodeSockets({ callSync: () => connected, retain: () => () => {},
    call(operation) {
      return Promise.resolve(operation.kind === "socket-read"
        ? { kind: "error", errno: 9, code: "EBADF", syscall: "read", path: null, destination: null }
        : { kind: "unit" });
    },
  }, context, scheduler);
  const socket = new net.Socket({ fd: 7 });
  const then = vi.fn(() => { throw new Error("socket return was adopted"); });
  Object.defineProperty(socket, "then", { get: then });
  const errors: unknown[] = [];
  socket.on("error", error => errors.push(error));
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  socket.resume();
  await closed;
  expect(errors).toMatchObject([{ code: "EBADF" }]);
  expect(then).not.toHaveBeenCalled();
});

it("applies keepalive before connect and synchronously updates the connected Linux socket", async () => {
  const controls: AssistanceOperation[] = [];
  const read = Promise.withResolvers<AssistanceResult>();
  const net = createNodeSockets({ retain: () => () => {},
    callSync(operation) {
      controls.push(operation);
      return { kind: "error", errno: 22, code: "EINVAL", syscall: "setsockopt", path: null, destination: null };
    },
    call(operation) {
      if (operation.kind === "socket-connect-local") return Promise.resolve(connected);
      if (operation.kind === "socket-read") return read.promise;
      return Promise.resolve({ kind: "unit" });
    },
  }, createAsyncContext());
  const socket = new net.Socket();
  expect(socket.setKeepAlive(true, 2500)).toBe(socket);
  expect(controls).toEqual([]);
  const opened = new Promise<void>(resolve => socket.once("connect", () => {
    expect(controls).toEqual([{ kind: "socket-keepalive", fd: 7, enabled: true, delaySeconds: 2 }]);
    resolve();
  }));
  socket.connect(3000, "127.0.0.1");
  await opened;
  socket.setKeepAlive(true, 2999);
  expect(controls).toHaveLength(1);
  socket.setKeepAlive(true, 0);
  expect(controls.at(-1)).toEqual({ kind: "socket-keepalive", fd: 7, enabled: true, delaySeconds: 0 });
  socket.setKeepAlive(false);
  expect(controls.at(-1)).toEqual({ kind: "socket-keepalive", fd: 7, enabled: false, delaySeconds: 0 });
  socket.setKeepAlive(true, -1000);
  expect(controls.at(-1)).toEqual({ kind: "socket-keepalive", fd: 7, enabled: true, delaySeconds: 0xffff_ffff });
  Reflect.apply(socket.setKeepAlive.bind(socket), socket, [true, "3500"]);
  expect(controls.at(-1)).toEqual({ kind: "socket-keepalive", fd: 7, enabled: true, delaySeconds: 3 });
  expect(() => { Reflect.apply(socket.setKeepAlive.bind(socket), socket, [true, 1n]); }).toThrow(TypeError);
  const closed = new Promise(resolve => socket.once("close", resolve));
  socket.destroy(); read.resolve({ kind: "data", bytes: new Uint8Array() });
  await closed;
});

it.each([false, true])("keeps NODELAY errno distinct from transport failure (transport=%s)", async transportFailure => {
  const failure = new Error("socket transport failed"), errors: unknown[] = [];
  const net = createNodeSockets({ retain: () => () => {}, callSync: () => connected,
    call(operation) {
      if (operation.kind === "socket-nodelay") return transportFailure ? Promise.reject(failure)
        : Promise.resolve({ kind: "error", errno: 93, code: "EPROTONOSUPPORT", syscall: "setsockopt", path: null, destination: null });
      return Promise.resolve({ kind: "unit" });
    },
  }, createAsyncContext());
  const socket = new net.Socket({ fd: 7 }); socket.on("error", error => errors.push(error));
  expect(socket.setNoDelay()).toBe(socket);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(socket.destroyed).toBe(transportFailure);
  expect(errors).toEqual(transportFailure ? [failure] : []);
  socket.destroy();
});
