import { spawn } from "node:child_process";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { Buffer } from "buffer";
import { expect, it, onTestFinished, vi } from "vitest";
import { createAsyncContext } from "./async-context.ts";
import { createNodeBrotli } from "./node-brotli.ts";
import { EventEmitter, Readable, Writable, createNodeStreamModule } from "./node-streams.ts";
import type { PipedChildHandle } from "./node-children.ts";
import { ProcessScheduler } from "./process-scheduler.ts";

function fixture() {
  const context = createAsyncContext(); const failures: unknown[] = []; let references = 0;
  const scheduler = new ProcessScheduler(context, error => { failures.push(error); });
  const retain = () => { references++; return () => { references--; }; };
  const streams = createNodeStreamModule(context, retain, scheduler.nextTick);
  onTestFinished(() => { streams.restore(); scheduler.dispose(); expect(failures).toEqual([]); });
  const spawnService = (...values: unknown[]): PipedChildHandle => {
    const [command, args] = values;
    if (command !== "/usr/bin/node" || !Array.isArray(args)) throw Error("Invalid service request");
    const argv = args.map((value: unknown) => { if (typeof value !== "string") throw Error("Argument"); return value; });
    const native = spawn(process.env["OXIDEVM_TEST_NODE"] ?? process.execPath, argv);
    onTestFinished(() => { native.kill("SIGKILL"); });
    const stdin = new Writable({
      write(bytes, _encoding, done) { if (!(bytes instanceof Uint8Array)) throw Error("bytes"); native.stdin.write(bytes, done); },
      final(done) { native.stdin.end(done); },
    });
    const stdout = Readable.from(native.stdout, { objectMode: false }); const stderr = Readable.from(native.stderr, { objectMode: false });
    const child: PipedChildHandle = Object.assign(new EventEmitter(), {
      ref() { native.ref(); return child; }, unref() { native.unref(); return child; },
      get pid() { return native.pid; }, get exitCode() { return native.exitCode; }, get signalCode() { return native.signalCode; }, get killed() { return native.killed; },
      stdin, stdout, stderr, stdio: [stdin, stdout, stderr] as const,
      kill(signal: unknown = "SIGTERM") { if (signal !== "SIGTERM" && signal !== "SIGKILL") throw Error("Signal"); return native.kill(signal); },
    });
    native.on("error", error => { child.emit("error", error); }); native.stdin.on("error", error => { stdin.destroy(error); });
    native.on("close", (code, signal) => { child.emit("close", code, signal); });
    return child;
  };
  return { brotli: createNodeBrotli({ spawnService }, context, retain, scheduler), get references() { return references; } };
}

it("streams actual Webpack Brotli options and verifies flush output before callback", async () => {
  const f = fixture(); const input = Buffer.from("webpack cached module 世界 ".repeat(15000));
  const stream = f.brotli.createBrotliCompress({ chunkSize: 100 * 1024 * 1024, params: { 0: 1, 1: 2, 4: true, 5: input.length } });
  const output: Uint8Array[] = []; const errors: unknown[] = [];
  stream.on("error", error => { errors.push(error); });
  stream.on("data", (bytes: unknown) => { if (!(bytes instanceof Uint8Array)) throw Error("bytes"); output.push(bytes); });
  const closed = new Promise<void>(resolve => stream.once("close", () => resolve()));
  stream.write(input);
  await new Promise<void>((resolve, reject) => stream.flush(1, error => error ? reject(error) : resolve()));
  expect(Buffer.from(brotliDecompressSync(Buffer.concat(output), { finishFlush: 1 })).equals(input)).toBe(true);
  stream.end(); await closed;
  expect(errors).toEqual([]); expect(Buffer.from(brotliDecompressSync(Buffer.concat(output))).equals(input)).toBe(true);
  expect(stream.bytesWritten).toBe(input.length);
  await vi.waitFor(() => expect(f.references).toBe(0));
}, 20000);

it("backpressures real decompression and retires codec errors and cancellation", async () => {
  const f = fixture(); const bytes = Buffer.alloc(400000, 65); const stream = f.brotli.createBrotliDecompress({ highWaterMark: 64 });
  const output: Uint8Array[] = []; const errors: unknown[] = []; let finished = false;
  stream.on("error", error => { errors.push(error); });
  const closed = new Promise<void>(resolve => stream.once("close", () => resolve()));
  stream.end(brotliCompressSync(bytes), () => { finished = true; });
  await vi.waitFor(() => expect(stream.readableLength).toBeGreaterThan(0));
  expect(stream.readableLength).toBeLessThanOrEqual(65536); expect(finished).toBe(false);
  stream.on("data", (value: unknown) => { if (!(value instanceof Uint8Array)) throw Error("bytes"); output.push(value); });
  await closed; expect(errors).toEqual([]); expect(Buffer.concat(output).equals(bytes)).toBe(true);
  for (const cancel of [false, true]) {
    const decoder = f.brotli.createBrotliDecompress(); const failures: unknown[] = [];
    decoder.on("error", error => { failures.push(error); });
    const retired = new Promise<void>(resolve => decoder.once("close", () => resolve()));
    decoder.end(Buffer.from("invalid")); if (cancel) decoder.destroy(new Error("cancel"));
    await retired; expect(failures).toHaveLength(1);
    if (cancel) expect(failures[0]).toMatchObject({ message: "cancel" });
    else expect(failures[0]).toMatchObject({ code: "ERR__ERROR_FORMAT_PADDING_1" });
  }
  await vi.waitFor(() => expect(f.references).toBe(0));
}, 20000);
