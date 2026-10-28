import { expect, it } from "vitest";
import { PassThrough } from "readable-stream";
import { Buffer } from "buffer";
import { encodeNativeFrame, readNativeFrame } from "./native-frames.ts";

it("reads fragmented bounded helper frames and clean EOF", async () => {
  const stream = new PassThrough(); const data = encodeNativeFrame(0, Buffer.from([1, 2, 3]));
  const pending = readNativeFrame(stream);
  for (const byte of data) stream.write(Buffer.from([byte]));
  expect(await pending).toEqual({ tag: 0, bytes: Buffer.from([1, 2, 3]) });
  stream.end(); expect(await readNativeFrame(stream)).toBe(null);
});

it("rejects oversized control frames and truncated payloads", async () => {
  for (const frame of [Buffer.from([1, 0, 0, 64, 1]), Buffer.from([0, 0, 0, 0, 2, 1])]) {
    const stream = new PassThrough(); const pending = readNativeFrame(stream); stream.end(frame);
    await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  }
  expect(() => encodeNativeFrame(0, new Uint8Array())).toThrow();
});
