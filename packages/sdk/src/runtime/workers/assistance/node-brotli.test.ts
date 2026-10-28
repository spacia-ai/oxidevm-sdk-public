import { Buffer } from "buffer";
import { expect, it, onTestFinished, vi } from "vitest";
import { EventEmitter, Readable, Writable, createNodeStreamModule } from "./node-streams.ts";
import type { PipedChildHandle } from "./node-children.ts";
import { createAsyncContext } from "./async-context.ts";
import { ProcessScheduler } from "./process-scheduler.ts";
import { encodeNativeFrame } from "./native-frames.ts";
import { createNodeBrotli } from "./node-brotli.ts";

function fixture() {
  const context = createAsyncContext(); const failures: unknown[] = []; let references = 0;
  const scheduler = new ProcessScheduler(context, error => { failures.push(error); });
  const retain = () => { references++; return () => { references--; }; };
  const streams = createNodeStreamModule(context, retain, scheduler.nextTick);
  const writes: Uint8Array[] = [];
  const stdout = new Readable({ read() {} }); const stderr = new Readable({ read() {} });
  const stdin = new Writable({ write(value, _encoding, done) {
    if (!(value instanceof Uint8Array)) throw Error("bytes"); writes.push(value); done();
  } });
  const kill = vi.fn(() => { queueMicrotask(() => { child.emit("close", null, "SIGKILL"); }); return true; });
  const child: PipedChildHandle = Object.assign(new EventEmitter(), {
    ref: () => child, unref: () => child,
    pid: 42, exitCode: null, signalCode: null, killed: false, stdin, stdout, stderr, stdio: [stdin, stdout, stderr] as const,
    kill,
  });
  const spawnService = vi.fn(() => child);
  onTestFinished(() => { streams.restore(); scheduler.dispose(); expect(failures).toEqual([]); });
  return { context, brotli: createNodeBrotli({ spawnService }, context, retain, scheduler), child, writes, spawnService, kill,
    control: (event: object) => stderr.push(encodeNativeFrame(1, Buffer.from(JSON.stringify(event)))),
    data: (value: string) => stdout.push(encodeNativeFrame(0, Buffer.from(value))),
    get references() { return references; },
  };
}

it("waits for causally identified output before write and flush callbacks", async () => {
  const f = fixture(); const storage = new f.context.AsyncLocalStorage<string>();
  const stream = storage.run("creator", () => f.brotli.createBrotliCompress());
  expect(f.spawnService).not.toHaveBeenCalled(); expect(f.references).toBe(0);
  const events: string[] = [];
  storage.run("listener", () => stream.on("data", () => { events.push(`data:${storage.getStore()}`); }));
  stream.on("error", error => { throw error; });
  stream.write("hello", () => { events.push(`write:${storage.getStore()}`); });
  f.control({ kind: "ready" });
  await vi.waitFor(() => expect(f.writes).toHaveLength(1));
  f.control({ kind: "written", count: 5, outputBytes: 3 });
  await Promise.resolve(); expect(events).toEqual([]);
  f.data("abc"); await vi.waitFor(() => expect(events).toEqual(["data:creator", "write:creator"]));
  stream.flush(1, () => { events.push("flush"); });
  await vi.waitFor(() => expect(f.writes).toHaveLength(2));
  f.control({ kind: "flushed", outputBytes: 6 });
  await Promise.resolve(); expect(events).not.toContain("flush");
  f.data("def"); await vi.waitFor(() => expect(events.at(-1)).toBe("flush"));
  const closed = new Promise<void>(resolve => stream.once("close", () => resolve()));
  stream.destroy(); await closed;
  expect(f.kill).toHaveBeenCalledWith("SIGKILL");
  let repeatedClose = false;
  stream.close(() => { repeatedClose = true; }); expect(repeatedClose).toBe(false);
  await vi.waitFor(() => expect(repeatedClose).toBe(true));
  await vi.waitFor(() => expect(f.references).toBe(0));
});

it("rejects duplicate acknowledgements and truncated output instead of hanging", async () => {
  for (const duplicate of [false, true]) {
    const f = fixture(); const stream = f.brotli.createBrotliCompress(); const errors: unknown[] = [];
    stream.on("error", error => { errors.push(error); });
    const closed = new Promise<void>(resolve => stream.once("close", () => resolve()));
    stream.write("hello"); f.control({ kind: "ready" });
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    f.control({ kind: "written", count: 5, outputBytes: 9 });
    if (duplicate) f.control({ kind: "written", count: 5, outputBytes: 9 });
    else f.child.stdout.push(null);
    await closed; expect(errors).toHaveLength(1); expect(errors[0]).toMatchObject({ code: "PROTOCOL_ERROR" });
    await vi.waitFor(() => expect(f.references).toBe(0));
  }
});

it("keeps finalization referenced until validated helper close and native retirement", async () => {
  const f = fixture(); const stream = f.brotli.createBrotliCompress(); const events: string[] = [];
  stream.on("error", error => { throw error; }); stream.on("data", () => { events.push("data"); });
  const closed = new Promise<void>(resolve => stream.once("close", () => resolve()));
  stream.end(() => { events.push("finish"); }); f.control({ kind: "ready" });
  await vi.waitFor(() => expect(f.writes).toHaveLength(1));
  f.control({ kind: "end" }); f.control({ kind: "finished", outputBytes: 1 });
  f.control({ kind: "close", hadError: false }); f.child.stderr.push(null);
  f.data("x"); f.child.stdout.push(null);
  await vi.waitFor(() => expect(events).toEqual(["data"])); expect(f.references).toBeGreaterThan(0);
  f.child.emit("close", 0, null); await closed;
  expect(events).toEqual(["data", "finish"]); expect(f.kill).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(f.references).toBe(0));
});
