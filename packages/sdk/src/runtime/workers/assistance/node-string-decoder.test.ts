import { describe, expect, it } from "vitest";
import { StringDecoder } from "./node-string-decoder.js";

describe("node string_decoder builtin", () => {
  it("keeps incomplete UTF-8 sequences across writes and flushes them at end", () => {
    const decoder = new StringDecoder("utf8");
    const euro = new TextEncoder().encode("€");
    expect(decoder.write(euro.subarray(0, 1))).toBe("");
    expect(decoder.write(euro.subarray(1, 2))).toBe("");
    expect(decoder.write(euro.subarray(2))).toBe("€");
    expect(decoder.write(euro.subarray(0, 2))).toBe("");
    expect(decoder.end()).toBe("�");
    expect(decoder.encoding).toBe("utf8");
  });

  it("decodes utf16le, latin1, hex, ascii and base64 with Node's carry semantics", () => {
    const utf16 = new StringDecoder("ucs2");
    expect(utf16.write(new Uint8Array([0x41]))).toBe("");
    expect(utf16.write(new Uint8Array([0x00, 0x42, 0x00]))).toBe("AB");
    expect(utf16.encoding).toBe("utf16le");
    const latin1 = new StringDecoder("binary");
    expect(latin1.write(new Uint8Array([0x80, 0xe9]))).toBe("\u0080é");
    expect(new StringDecoder("hex").write(new Uint8Array([0xde, 0xad]))).toBe("dead");
    expect(new StringDecoder("ascii").write(new Uint8Array([0xc1, 0x42]))).toBe("AB");
    const base64 = new StringDecoder("base64");
    expect(base64.write(new Uint8Array([0x4d, 0x61, 0x6e, 0x4d]))).toBe("TWFu");
    expect(base64.end()).toBe("TQ==");
    expect(() => new StringDecoder("koi8-r")).toThrow(/Unknown encoding/u);
  });
});
