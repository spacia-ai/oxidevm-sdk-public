import { expect, it } from "vitest";
import { PassThrough } from "readable-stream";
import { Buffer } from "buffer";
import { encodeNativeFrame } from "./native-frames.ts";
import { readBrotliFrame } from "./node-brotli-wire.ts";

it("decodes bounded Brotli acknowledgements and native error identities", async () => {
  for (const value of [{ kind: "ready" }, { kind: "written", count: 65536, outputBytes: 0 }, { kind: "flushed", outputBytes: 1024 }, { kind: "error", code: "ERR_PADDING_1", errno: -14, message: "decode" }, { kind: "close", hadError: true }]) {
    const stream = new PassThrough(); const frame = readBrotliFrame(stream);
    stream.end(encodeNativeFrame(1, Buffer.from(JSON.stringify(value)))); expect(await frame).toEqual(value);
  }
});

it("rejects unrecognized and malformed Brotli control fields", async () => {
  for (const value of [{ kind: "ready", extra: 1 }, { kind: "written", count: 0, outputBytes: 0 }, { kind: "written", count: 65537, outputBytes: 0 }, { kind: "flushed", outputBytes: -1 }, { kind: "flushed" }, { kind: "close", hadError: "false" }, { kind: "error", code: "x", message: "y", errno: 0.5 }, { kind: "connect" }]) {
    const stream = new PassThrough(); const frame = readBrotliFrame(stream);
    stream.end(encodeNativeFrame(1, Buffer.from(JSON.stringify(value)))); await expect(frame).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  }
});
