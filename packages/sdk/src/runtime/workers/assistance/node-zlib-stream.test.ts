import { expect, it, onTestFinished, vi } from "vitest";
import * as native from "node:zlib";
import { Buffer } from "buffer";
import { createAsyncContext } from "./async-context.ts";
import { createNodeZlib } from "./node-zlib-stream.ts";
import { createNodeStreamModule } from "./node-streams.ts";
import { ProcessScheduler } from "./process-scheduler.ts";

function fixture() {
  const context = createAsyncContext();
  const failures: unknown[] = [];
  const scheduler = new ProcessScheduler(context, error => { failures.push(error); });
  const streams = createNodeStreamModule(context, () => () => {}, scheduler.nextTick);
  onTestFinished(() => { streams.restore(); scheduler.dispose(); expect(failures).toEqual([]); });
  return { context, zlib: createNodeZlib(context, scheduler) };
}

it("streams gzip through bounded readable backpressure without collecting the input", async () => {
  const { zlib } = fixture();
  const input = Buffer.alloc(300_000); for (let i = 0; i < input.length; i++) input[i] = (i * 73 + Math.floor(i / 17)) & 255;
  const stream = zlib.createGunzip({ highWaterMark: 64, chunkSize: 128 });
  let completed = false; const output: Buffer[] = [];
  const end = new Promise<void>((resolve, reject) => { stream.on("end", () => resolve()); stream.on("error", reject); });
  stream.end(native.gzipSync(input), () => { completed = true; });
  await vi.waitFor(() => expect(stream.readableLength).toBe(128));
  expect(completed).toBe(false); expect(stream.readableLength).toBeLessThanOrEqual(128);
  stream.on("data", (value: unknown) => { if (!(value instanceof Uint8Array)) throw Error("bytes"); output.push(Buffer.from(value)); });
  await end;
  expect(Buffer.concat(output).equals(input)).toBe(true);
});

it("flushes raw WebSocket blocks in order and resets between messages", async () => {
  const { zlib } = fixture(); const stream = zlib.createDeflateRaw(); const output: Buffer[] = [];
  stream.on("data", (value: unknown) => { if (!(value instanceof Uint8Array)) throw Error("bytes"); output.push(Buffer.from(value)); });
  for (const text of ["first message", "second message"]) {
    stream.write(text);
    await new Promise<void>((resolve, reject) => stream.flush(zlib.constants.Z_SYNC_FLUSH, error => error ? reject(error) : resolve()));
    expect(native.inflateRawSync(Buffer.concat(output), { finishFlush: native.constants.Z_SYNC_FLUSH }).toString()).toBe(text);
    output.length = 0; stream.reset();
  }
  await new Promise<void>(resolve => stream.close(resolve));
  expect(stream.destroyed).toBe(true);
});

it("delivers asynchronous results in creation context and rejects bombs once", async () => {
  const { context, zlib } = fixture(); const store = new context.AsyncLocalStorage<string>();
  const input = native.deflateSync(Buffer.alloc(10000, 65));
  let synchronous = true;
  const done = new Promise<void>((resolve, reject) => store.run("request", () => {
    zlib.inflate(input, { maxOutputLength: 200 }, (error: unknown, value: unknown) => {
      try { expect(synchronous).toBe(false); expect(store.getStore()).toBe("request"); expect(error).toMatchObject({ code: "ERR_BUFFER_TOO_LARGE" }); expect(value).toBeUndefined(); resolve(); }
      catch (failure) { reject(failure instanceof Error ? failure : new Error(String(failure))); }
    });
  }));
  synchronous = false; await done;
});

it("accepts split gzip members and settles a cancelled queued write once", async () => {
  const { zlib } = fixture(); const stream = zlib.createUnzip(); const output: Buffer[] = [];
  const data = Buffer.concat([native.gzipSync("one"), native.gzipSync("two")]);
  stream.on("data", (value: unknown) => { if (!(value instanceof Uint8Array)) throw Error("bytes"); output.push(Buffer.from(value)); });
  const end = new Promise<void>((resolve, reject) => { stream.on("end", () => resolve()); stream.on("error", reject); });
  for (const byte of data) stream.write(Buffer.from([byte]));
  stream.end(); await end;
  expect(Buffer.concat(output).toString()).toBe("onetwo"); expect(stream.bytesWritten).toBe(data.length);
  const cancelled = zlib.createGzip(); const errors: unknown[] = []; let callbacks = 0;
  cancelled.on("error", error => { errors.push(error); });
  const closed = new Promise<void>(resolve => cancelled.on("close", () => resolve()));
  cancelled.write("queued", error => { callbacks++; expect(error?.message).toBe("stop"); });
  cancelled.destroy(new Error("stop")); await closed;
  expect(callbacks).toBe(1); expect(errors).toHaveLength(1);
});

it("allows the WebSocket payload-limit handler to reset during a data callback", async () => {
  const { zlib } = fixture(); const stream = zlib.createInflateRaw({ chunkSize: 64 });
  const events: string[] = []; let size = 0;
  stream.on("data", (bytes: unknown) => {
    if (!(bytes instanceof Uint8Array)) throw Error("bytes");
    size += bytes.length;
    if (size === 64) { stream.reset(); events.push("reset"); }
  });
  stream.on("error", (error: unknown) => { if (!(error instanceof Error) || !("code" in error)) throw Error("error identity"); events.push(`error:${String(error.code)}`); });
  const close = new Promise<void>(resolve => stream.on("close", () => resolve()));
  stream.end(native.deflateRawSync(Buffer.alloc(10000, 65))); await close;
  expect({ events, size }).toEqual({ events: ["reset", "error:Z_DATA_ERROR"], size: 64 });
});
