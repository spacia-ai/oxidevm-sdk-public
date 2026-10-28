import { spawn } from "node:child_process";
import { once } from "node:events";
import { brotliDecompressSync, brotliCompressSync } from "node:zlib";
import { Buffer } from "buffer";
import { Readable } from "readable-stream";
import { expect, it } from "vitest";
import { encodeNativeFrame, readNativeFrame } from "./native-frames.ts";
import { brotliGuestArguments } from "./node-brotli-guest.ts";
import { decodeAssistanceOperation } from "../../protocol/assistance.ts";

async function run(mode: "compress" | "decompress", frames: Uint8Array[], options: Readonly<Record<string, unknown>> = {}) {
  const args = brotliGuestArguments(mode, options);
  decodeAssistanceOperation({ kind: "spawn", command: "/usr/bin/node", args, cwd: ".", env: {} });
  const child = spawn(process.env["OXIDEVM_TEST_NODE"] ?? process.execPath, args);
  const closed = once(child, "close"); const events: unknown[] = []; const output: Uint8Array[] = [];
  const inputErrors: Error[] = []; child.stdin.on("error", (error: Error) => { inputErrors.push(error); });
  async function consume(source: typeof child.stdout, tag: 0 | 1): Promise<void> {
    const stream = Readable.from(source, { objectMode: false });
    for (;;) {
      const frame = await readNativeFrame(stream); if (frame === null) return;
      expect(frame.tag).toBe(tag);
      if (tag === 0) output.push(frame.bytes); else { const value: unknown = JSON.parse(frame.bytes.toString()); events.push(value); }
    }
  }
  try {
    const received = Promise.all([consume(child.stdout, 0), consume(child.stderr, 1)]);
    for (const frame of frames) child.stdin.write(frame);
    child.stdin.end(); await received; expect(await closed).toEqual([0, null]);
    return { events, output: Buffer.concat(output), inputErrors };
  } finally { child.kill("SIGKILL"); }
}
function control(value: object): Buffer { return encodeNativeFrame(1, Buffer.from(JSON.stringify(value))); }

it("runs real Brotli with bounded data frames, acknowledged writes and flush", async () => {
  const bytes = Buffer.from("Webpack cache 世界 ".repeat(10000));
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) frames.push(encodeNativeFrame(0, bytes.subarray(offset, offset + 32768)));
  frames.push(control({ kind: "flush", operation: 1 }), control({ kind: "end" }));
  const compressed = await run("compress", frames, { chunkSize: 100 * 1024 * 1024, params: { 0: 1, 1: 2, 4: true, 5: bytes.length } });
  expect(Buffer.from(brotliDecompressSync(compressed.output))).toEqual(bytes);
  expect(compressed.inputErrors).toEqual([]);
  expect(compressed.events[0]).toEqual({ kind: "ready" });
  const flushed = compressed.events.find(value => typeof value === "object" && value !== null && "kind" in value && value.kind === "flushed");
  if (typeof flushed !== "object" || flushed === null || !("outputBytes" in flushed) || typeof flushed.outputBytes !== "number") throw Error("Missing flush output identity");
  expect(flushed.outputBytes).toBeGreaterThan(0); expect(flushed.outputBytes).toBeLessThanOrEqual(compressed.output.length);
  expect(Buffer.from(brotliDecompressSync(compressed.output.subarray(0, flushed.outputBytes), { finishFlush: 1 }))).toEqual(bytes);
  expect(compressed.events).toContainEqual({ kind: "finished", outputBytes: compressed.output.length });
  expect(compressed.events).toContainEqual({ kind: "end" });
  expect(compressed.events.at(-1)).toEqual({ kind: "close", hadError: false });
  const decompressed = await run("decompress", [encodeNativeFrame(0, brotliCompressSync(bytes)), control({ kind: "end" })]);
  expect(decompressed.output).toEqual(bytes);
}, 20000);

it("retires malformed input and codec failures with structured errors", async () => {
  for (const frames of [[Buffer.from([0, 0, 1, 0, 1])], [control({ kind: "end", extra: true })], [encodeNativeFrame(0, Buffer.from("bad")), control({ kind: "end" })], [encodeNativeFrame(0, Buffer.from("invalid"))]]) {
    const result = await run("decompress", frames);
    expect(result.events.at(-1)).toEqual({ kind: "close", hadError: true });
    expect(result.events.some(value => typeof value === "object" && value !== null && "kind" in value && value.kind === "error")).toBe(true);
    for (const error of result.inputErrors) expect(error).toMatchObject({ code: "EPIPE" });
  }
}, 20000);
