import { describe, expect, it } from "vitest";
import { VMError } from "../runtime/errors.js";
import { parseJSON } from "./decode-support.js";

const parse = (text: string): unknown => parseJSON(new TextEncoder().encode(text), "test.json", 1 << 20);

describe("reading JSON that names a key once", () => {
  it("accepts documents where no object repeats a key, however they are laid out", () => {
    expect(parse('{"a":1,"b":{"a":2},"c":[{"a":3},{"a":4}]}')).toEqual({ a: 1, b: { a: 2 }, c: [{ a: 3 }, { a: 4 }] });
    expect(parse('  {\n\t"a" : [ ] , "b" : { } \n}\n')).toEqual({ a: [], b: {} });
    expect(parse("[]")).toEqual([]);
    expect(parse('"a"')).toBe("a");
    expect(parse("[1, 2.5e3, true, false, null]")).toEqual([1, 2500, true, false, null]);
    // A value that equals a key of the same object is not a repeated key, nor is an array element that equals one.
    expect(parse('{"a":"a","b":"a","c":["a","b","c"],"d":{"a":"d"}}')).toEqual({ a: "a", b: "a", c: ["a", "b", "c"], d: { a: "d" } });
  });

  it("is not fooled by braces, commas, colons, quotes or key-like text inside strings", () => {
    const tricky = '{"a":"x\\",\\"a\\":1}","b":"{\\"a\\":2}","c":["\\"a\\":", "},{"],"a2":"\\\\"}';
    expect(parse(tricky)).toEqual({ a: 'x","a":1}', b: '{"a":2}', c: ['"a":', "},{"], a2: "\\" });
  });

  it("rejects a repeated key in the document, in a nested object or inside an array, and says which key", () => {
    for (const text of ['{"a":1,"a":2}', '{"x":{"a":1,"a":2}}', '[{"a":1,"a":2}]', '{"a":1,"b":[{"c":1},{"d":1,"d":2}]}']) {
      expect(() => parse(text), text).toThrow(VMError);
      expect(() => parse(text), text).toThrow(/more than once/u);
    }
    expect(() => parse('{"key":1,"key":2}')).toThrow(/"key"/u);
  });

  it("treats two spellings of one key as the same key, which is how JSON.parse reads them", () => {
    expect(() => parse('{"a":1,"\\u0061":2}')).toThrow(/more than once/u);
    expect(() => parse('{"caf\\u00e9":1,"café":2}')).toThrow(/more than once/u);
  });

  it("still rejects what is not JSON, and input over the bound, with the same stable reason", () => {
    expect(() => parse("{ not json")).toThrow(/not UTF-8 JSON/u);
    expect(() => parseJSON(new Uint8Array(11), "test.json", 10)).toThrow(/exceeds 10 bytes/u);
    for (const text of ["{ not json"]) {
      try { parse(text); } catch (error: unknown) { expect(error).toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" } }); }
    }
  });
});
