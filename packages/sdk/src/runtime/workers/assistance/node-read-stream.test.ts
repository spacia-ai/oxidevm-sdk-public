import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeReadStreams } from "./node-read-stream.js";

it("uses one public ReadStream identity and bounded descriptor reads with backpressure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-read-stream-")), path = join(directory, "input");
  await writeFile(path, "abcdefghij");
  let reads = 0, closed = 0;
  const module = createNodeReadStreams(async (path, flags) => {
    if (typeof path !== "string" || typeof flags !== "string") throw new Error("Invalid open");
    const handle = await open(path, flags);
    return { fd: handle.fd, read: (bytes, offset, length, position) => { reads++; return handle.read(bytes, offset, Math.min(2, length), position); },
      close: async () => { closed++; await handle.close(); } };
  }, createAsyncContext());
  try {
    const stream = module.createReadStream(path, { start: 1, end: 6, highWaterMark: 2 });
    expect(stream).toBeInstanceOf(module.ReadStream);
    stream.read(0); await vi.waitFor(() => expect(stream.readableLength).toBe(2));
    expect(reads).toBe(1); expect(closed).toBe(0);
    const parts: Uint8Array[] = [];
    for await (const part of stream) { if (!(part instanceof Uint8Array)) throw new Error("Expected bytes"); parts.push(part); }
    await vi.waitFor(() => expect(closed).toBe(1));
    expect(Buffer.concat(parts).toString()).toBe("bcdefg"); expect(stream.bytesRead).toBe(6); expect(stream.fd).toBeNull();
    expect(() => module.createReadStream(path, { highWaterMark: -1 })).toThrow();
  } finally { await rm(directory, { force: true, recursive: true }); }
});

it("closes an explicitly retired stream after its pending open completes", async () => {
  const pending = Promise.withResolvers<{ fd: number; read(): Promise<{ bytesRead: number }>; close(): Promise<void> }>();
  let closed = 0;
  const module = createNodeReadStreams(() => pending.promise, createAsyncContext());
  const stream = new module.ReadStream("input");
  const done = new Promise(resolve => { stream.once("close", resolve); });
  stream.destroy();
  pending.resolve({ fd: 10, read: () => Promise.resolve({ bytesRead: 0 }), close: () => { closed++; return Promise.resolve(); } });
  await done; expect(closed).toBe(1); expect(stream.fd).toBeNull();
});

it("retains autoClose:false descriptors until explicit close and waits for in-flight reads", async () => {
  let closed = 0, reads = 0;
  const reading = Promise.withResolvers<{ bytesRead: number }>();
  const module = createNodeReadStreams(() => Promise.resolve({ fd: 10,
    read: () => { reads++; return reading.promise; }, close: () => { closed++; return Promise.resolve(); } }), createAsyncContext());
  const stream = module.createReadStream("input", { autoClose: false });
  stream.read(0); await vi.waitFor(() => expect(reads).toBe(1));
  const done = new Promise<void>(resolve => { stream.close(resolve); });
  expect(closed).toBe(0); reading.resolve({ bytesRead: 0 });
  await done; expect(closed).toBe(1); expect(stream.fd).toBeNull();
  const finished = module.createReadStream("input", { autoClose: false });
  await new Promise<void>(resolve => { finished.once("end", () => resolve()); finished.resume(); });
  expect(finished.fd).toBe(10); expect(closed).toBe(1);
  await new Promise<void>(resolve => { finished.close(resolve); });
  expect(finished.fd).toBeNull(); expect(closed).toBe(2);
});
