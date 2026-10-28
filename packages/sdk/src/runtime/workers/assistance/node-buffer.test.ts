import { describe, expect, it } from "vitest";
import { Buffer } from "buffer";
import { Buffer as BrowserBuffer } from "buffer/";
import { createNodeBuffer } from "./node-buffer.js";

describe("node buffer builtin", () => {
  it("matches Node's base64url output, decoding, lengths and string operations", () => {
    createNodeBuffer(globalThis, BrowserBuffer);
    for (const input of [[], [251], [251, 255], Array.from({ length: 256 }, (_, index) => index)]) {
      const actual = BrowserBuffer.from(input), expected = Buffer.from(input), text = expected.toString("base64url");
      expect(actual.toString("base64url")).toBe(text);
      expect(actual.toString("BASE64URL", 1, 3)).toBe(expected.toString("base64url", 1, 3));
      expect(BrowserBuffer.isEncoding("base64url")).toBe(true);
      expect(BrowserBuffer.isEncoding("BASE64URL")).toBe(true);
      expect(Array.from(BrowserBuffer.from(text, "base64url"))).toEqual(input);
      expect(BrowserBuffer.byteLength(text, "base64url")).toBe(Buffer.byteLength(text, "base64url"));
      if (text === "") continue;
      expect(Array.from(BrowserBuffer.alloc(8, text, "base64url"))).toEqual(Array.from(Buffer.alloc(8, text, "base64url")));
      const written = BrowserBuffer.alloc(8), nativeWritten = Buffer.alloc(8);
      expect(written.write(text, 1, 4, "base64url")).toBe(nativeWritten.write(text, 1, 4, "base64url"));
      expect(Array.from(written)).toEqual(Array.from(nativeWritten));
      Reflect.apply(written.fill.bind(written), undefined, [text, 2, 7, "base64url"]); nativeWritten.fill(text, 2, 7, "base64url");
      expect(Array.from(written)).toEqual(Array.from(nativeWritten));
      expect(actual.indexOf(text, 0, "base64url")).toBe(0);
      expect(actual.lastIndexOf(text, undefined, "base64url")).toBe(0);
      expect(actual.includes(text, 0, "base64url")).toBe(true);
      expect(actual.toString("base64")).toBe(expected.toString("base64"));
    }
  });
  it.each([["latin1Slice", "latin1"], ["utf8Slice", "utf8"], ["ucs2Slice", "ucs2"], ["base64Slice", "base64"]] as const)("exposes %s to native-compatible stream parsers", (name, encoding) => {
    createNodeBuffer(globalThis, BrowserBuffer);
    const bytes = BrowserBuffer.from([65, 128, 255]);
    const slice: unknown = Reflect.get(bytes, name);
    expect(typeof slice).toBe("function");
    if (typeof slice !== "function") throw new Error(`Missing ${name}`);
    expect(Reflect.apply(slice, bytes, [1, 3])).toBe(Buffer.from([128, 255]).toString(encoding));
  });
  it("exposes Buffer with the platform's Blob, File and base64 helpers plus the encoding probes", () => {
    const module = createNodeBuffer(globalThis, Buffer);
    expect(module.Buffer).toBe(Buffer);
    expect(module.Blob).toBe(globalThis.Blob);
    expect(module.File).toBe(globalThis.File);
    expect(module.btoa("hi")).toBe("aGk=");
    expect(module.atob("aGk=")).toBe("hi");
    expect(module.isUtf8(new Uint8Array([0xe2, 0x82, 0xac]))).toBe(true);
    expect(module.isUtf8(new Uint8Array([0xff]))).toBe(false);
    expect(module.isAscii(new Uint8Array([0x41]))).toBe(true);
    expect(module.isAscii(new Uint8Array([0x80]))).toBe(false);
    expect(module.kMaxLength).toBeGreaterThan(0);
    expect(module.constants.MAX_LENGTH).toBe(module.kMaxLength);
  });
  it("keeps module receivers away from the browser base64 operations", () => {
    function atobPlatform(this: unknown, value: unknown): string {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return globalThis.atob(String(value));
    }
    function btoaPlatform(this: unknown, value: unknown): string {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return globalThis.btoa(String(value));
    }
    const module = createNodeBuffer({ Blob, File, atob: atobPlatform, btoa: btoaPlatform }, Buffer);
    expect(module.atob(module.btoa("\0\xff"))).toBe("\0\xff");
    const { atob, btoa } = module;
    expect(atob(btoa("\0\xff"))).toBe("\0\xff");
    expect(() => atob("%%%")).toThrow();
    expect(() => btoa("\u0100")).toThrow();
  });
  it.each(["atob", "btoa"])("rejects a missing or non-callable %s", name => {
    for (const value of [undefined, null, 0, {}]) {
      const globals = { Blob, File, atob, btoa, [name]: value };
      expect(() => createNodeBuffer(globals, Buffer)).toThrow(`the platform lacks ${name}`);
    }
  });
  it.each(["node", "bun"] as const)("preserves %s base64 errors and coercion failures", runtime => {
    const module = createNodeBuffer(globalThis, Buffer, runtime);
    for (const name of ["atob", "btoa"] as const) {
      const missing = runtime === "node" ? 'The "input" argument must be specified' : `${name} requires 1 argument (a string)`;
      expect(() => module[name]()).toThrow(missing);
      try { module[name](); } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        expect(typeof error === "object" && error !== null && "code" in error ? error.code : undefined).toBe(runtime === "node" ? "ERR_MISSING_ARGS" : undefined);
      }
      const message = runtime === "node" ? "Cannot convert a Symbol value to a string" : "Cannot convert a symbol to a string";
      expect(() => module[name](Symbol("input"))).toThrow(message);
      const marker = new DOMException("application coercion", "InvalidCharacterError");
      try { module[name]({ toString() { throw marker; } }); throw new Error("Coercion did not fail"); } catch (error) { expect(error).toBe(marker); }
    }
    for (const [name, input, nodeMessage] of [["atob", "%%%", "Invalid character"], ["atob", "a=", "The string to be decoded is not correctly encoded."], ["btoa", "\u0100", "Invalid character"]] as const) {
      const message = runtime === "node" ? nodeMessage : "The string contains invalid characters.";
      expect(() => module[name](input)).toThrow(message);
      try { module[name](input); } catch (error) { expect(error).toBeInstanceOf(DOMException); expect(error).toMatchObject({ name: "InvalidCharacterError", code: 5, message }); }
    }
  });
});
