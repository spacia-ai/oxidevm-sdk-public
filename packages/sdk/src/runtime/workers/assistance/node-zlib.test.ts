import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import * as native from "node:zlib";
import { Buffer } from "buffer";
import { nodeZlibSync } from "./node-zlib.js";

describe("synchronous Node compression", () => {
  it("exchanges zlib, gzip and raw data with Node", () => {
    const input = Buffer.from("Next resume data: 世界\n".repeat(1000));
    for (const [encode, decode] of [
      ["deflateSync", "inflateSync"], ["gzipSync", "gunzipSync"], ["deflateRawSync", "inflateRawSync"],
    ] as const) {
      expect(Buffer.from(native[decode](nodeZlibSync[encode](input))).equals(input)).toBe(true);
      expect(Buffer.from(nodeZlibSync[decode](native[encode](input))).equals(input)).toBe(true);
    }
    expect(Buffer.from(nodeZlibSync.unzipSync(native.gzipSync(input))).equals(input)).toBe(true);
    expect(Buffer.from(nodeZlibSync.unzipSync(native.deflateSync(input))).equals(input)).toBe(true);
  });

  it("enforces output limits while inflating and preserves Node failure codes", () => {
    const compressed = native.deflateSync(Buffer.alloc(100_000, 65));
    assert.throws(() => nodeZlibSync.inflateSync(compressed, { maxOutputLength: 99999 }), { code: "ERR_BUFFER_TOO_LARGE" });
    expect(nodeZlibSync.inflateSync(compressed, { maxOutputLength: 100_000 }).length).toBe(100_000);
    assert.throws(() => nodeZlibSync.inflateSync(compressed.subarray(0, -2)), { code: "Z_BUF_ERROR" });
    assert.throws(() => nodeZlibSync.inflateSync(Buffer.from("bad")), { code: "Z_DATA_ERROR" });
    assert.throws(() => nodeZlibSync.inflateSync(native.gzipSync("gzip")), { code: "Z_DATA_ERROR" });
  });

  it("supports dictionaries, byte views, concatenated gzip and partial flush", () => {
    const dictionary = Buffer.from("workspace source module");
    const input = Buffer.from("workspace source module source module");
    const compressed = nodeZlibSync.deflateSync(new DataView(input.buffer, input.byteOffset, input.byteLength), { dictionary });
    expect(Buffer.from(native.inflateSync(compressed, { dictionary }))).toEqual(input);
    expect(nodeZlibSync.inflateSync(compressed, { dictionary })).toEqual(input);
    assert.throws(() => nodeZlibSync.inflateSync(compressed), { code: "Z_NEED_DICT" });
    expect(nodeZlibSync.gunzipSync(Buffer.concat([native.gzipSync("a"), native.gzipSync("b")])).toString()).toBe("ab");
    const partial = native.deflateSync(input, { finishFlush: native.constants.Z_SYNC_FLUSH });
    expect(nodeZlibSync.inflateSync(partial, { finishFlush: native.constants.Z_SYNC_FLUSH })).toEqual(input);
  });

  it("reports unsupported block flushing and engine introspection explicitly", () => {
    assert.throws(() => nodeZlibSync.deflateSync("hello", { finishFlush: native.constants.Z_BLOCK }), { code: "FEATURE_NOT_AVAILABLE", message: /zlib.deflateSync finishFlush Z_BLOCK/u });
    assert.throws(() => nodeZlibSync.gzipSync("hello", { info: true }), { code: "FEATURE_NOT_AVAILABLE" });
  });

  it("validates decoding windows and retains wrong-dictionary identity", () => {
    const compressed = native.deflateSync("dictionary content", { dictionary: Buffer.from("dictionary") });
    assert.throws(() => nodeZlibSync.inflateSync(compressed, { dictionary: Buffer.from("wrong") }), { code: "Z_NEED_DICT" });
    for (const decode of ["inflateSync", "inflateRawSync", "gunzipSync", "unzipSync"] as const) {
      assert.throws(() => nodeZlibSync[decode](compressed, { windowBits: 7 }), { code: "ERR_OUT_OF_RANGE" });
    }
    assert.throws(() => nodeZlibSync.inflateRawSync(compressed, { windowBits: 0 }), { code: "ERR_OUT_OF_RANGE" });
    assert.throws(() => nodeZlibSync.gzipSync("input", { windowBits: 8 }), { code: "ERR_OUT_OF_RANGE" });
  });
});
