import { expect, it, vi } from "vitest";
import { NATIVE_LOGICAL_CHECKPOINT_VERSION } from "../../protocol/native-capture.ts";
import { CHUNK_BYTES, ChunkSink, checkHeader } from "./stream.js";

it("accepts native85 through native93 stream headers and rejects future or malformed headers", () => {
  const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXUC"));
  for (const version of [85, 86, 87, 88, 89, 90, 91, 92, 93]) {
    view.setUint16(4, version, true);
    expect(() => checkHeader(bytes, "OXUC")).not.toThrow();
  }
  view.setUint16(4, NATIVE_LOGICAL_CHECKPOINT_VERSION + 1, true);
  expect(() => checkHeader(bytes, "OXUC")).toThrow("format is unsupported");
  view.setUint16(4, 86, true); view.setUint16(6, 1, true);
  expect(() => checkHeader(bytes, "OXUC")).toThrow("format is unsupported");
  expect(() => checkHeader(bytes.subarray(0, 7), "OXUC")).toThrow("format is unsupported");
});

it("forwards complete immutable chunks only at aligned boundaries", async () => {
  const bytes = vi.fn(() => Promise.resolve()), reference = vi.fn(() => Promise.resolve());
  const writer = new ChunkSink("payloads", bytes);
  await writer.forwardChunk(reference);
  expect(reference).toHaveBeenCalledWith(0);
  await writer.write(new Uint8Array([1]));
  await expect(writer.forwardChunk(reference)).rejects.toThrow("not aligned");
  expect(await writer.finish()).toBe(CHUNK_BYTES + 1);
  expect(bytes.mock.calls).toHaveLength(1);
});

it("does not advance after a rejected reference or admit references after cancellation", async () => {
  const controller = new AbortController(), writer = new ChunkSink("payloads", () => Promise.resolve(), controller.signal);
  await expect(writer.forwardChunk(() => Promise.reject(new Error("quota")))).rejects.toThrow("quota");
  expect(await writer.finish()).toBe(0);
  controller.abort();
  const reference = vi.fn(() => Promise.resolve());
  await expect(writer.forwardChunk(reference)).rejects.toMatchObject({ code: "ABORTED" });
  expect(reference).not.toHaveBeenCalled();
});
