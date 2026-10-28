import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const empty = new Uint8Array();
function fixture() { return new NativeValues(() => undefined, () => undefined); }
function value(values: NativeValues, operation: string, args: readonly bigint[] = [], bytes = empty): unknown {
  const result = values.dispatch(operation, args, bytes); expect(result.status).toBe(0);
  const id = result.args[0]; if (id === undefined) throw new Error("Missing result"); return values.get(id);
}

it("converts int32 and int64 with truncation, finite saturation and separate type errors", () => {
  const values = fixture();
  for (const [input, signed32, signed64] of [[3.9, 3n, 3n], [-3.9, -3n, -3n], [2 ** 32 + 3, 3n, 4294967299n], [NaN, 0n, 0n], [Infinity, 0n, 0n], [-Infinity, 0n, 0n], [-0, 0n, 0n], [2 ** 63, 0n, (1n << 63n) - 1n], [-(2 ** 64), 0n, -(1n << 63n)]] as const) {
    const inputHandle = values.add(input);
    expect(values.dispatch("napi_get_value_int32", [inputHandle], empty)).toMatchObject({ status: 0, args: [BigInt.asUintN(64, signed32)] });
    expect(values.dispatch("napi_get_value_int64", [inputHandle], empty)).toMatchObject({ status: 0, args: [BigInt.asUintN(64, signed64)] });
  }
  for (const input of ["42", true, 42n, null]) expect(values.dispatch("napi_get_value_int32", [values.add(input)], empty).status).toBe(6);
});

it("preserves property keys, prototypes, readonly assignments, holes, and throwing proxy values", () => {
  const values = fixture(), marker = new Error("has trap"), symbol = Symbol("key");
  const input = { [symbol]: true, 42: true }; Object.setPrototypeOf(input, { inherited: true });
  const target = values.add(input);
  for (const key of [symbol, 42, { toString: () => "inherited" }]) expect(values.dispatch("napi_has_property", [target, values.add(key)], empty)).toMatchObject({ status: 0, args: [1n] });
  expect(values.dispatch("napi_has_named_property", [target], new TextEncoder().encode("inherited"))).toMatchObject({ status: 0, args: [1n] });
  const frozen = Object.freeze({ entry: 7 });
  expect(values.dispatch("napi_set_property", [values.add(frozen), values.add("entry"), values.add(8)], empty).status).toBe(0); expect(frozen.entry).toBe(7);
  expect(value(values, "napi_create_array")).toEqual([]);
  const sparse = value(values, "napi_create_array_with_length", [65537n]); expect(Array.isArray(sparse)).toBe(true);
  if (!Array.isArray(sparse)) throw new Error("Missing array"); expect(sparse.length).toBe(65537); expect(Object.hasOwn(sparse, 2)).toBe(false);
  const proxy = values.add(new Proxy({}, { has() { throw marker; } }));
  expect(values.dispatch("napi_has_property", [proxy, values.add("key")], empty).status).toBe(10);
  expect(() => values.throwPending()).toThrow(marker);
});

it("preserves Latin-1 code units, UTF-16 surrogates, embedded NUL and UTF-8 BOM", () => {
  const values = fixture();
  const latin = new Uint8Array([65, 0, 128, 255]); expect(value(values, "napi_create_string_latin1", [], latin)).toBe("A\0\u0080ÿ");
  const units = new Uint8Array([65, 0, 0, 0, 0, 216, 66, 0]); expect(value(values, "napi_create_string_utf16", [], units)).toBe("A\0\ud800B");
  expect(value(values, "napi_create_string_utf8", [], new Uint8Array([239, 187, 191, 65]))).toBe("\ufeffA");
  expect(value(values, "napi_create_string_utf8", [], new Uint8Array([192, 175]))).toBe("��");
  const input = values.add("A\0\u0080\u0100\ud800");
  expect(values.dispatch("napi_get_value_string_latin1", [input], empty).bytes).toEqual(new Uint8Array([65, 0, 128, 0, 0]));
  expect(values.dispatch("napi_get_value_string_utf16", [input], empty).bytes).toEqual(new Uint8Array([65, 0, 0, 0, 128, 0, 0, 1, 0, 216]));
  expect(() => values.dispatch("napi_create_string_utf16", [], new Uint8Array([65]))).toThrow(/UTF-16/u);
});

it("copies external string code units without changing a pending exception", () => {
  const values = fixture(), message = new TextEncoder().encode("external string pending");
  expect(values.dispatch("napi_throw_error", [0n, 1n], message).status).toBe(0);
  expect(value(values, "node_api_create_external_string_latin1", [], new Uint8Array([65, 0, 255]))).toBe("A\0ÿ");
  expect(value(values, "node_api_create_external_string_utf16", [], new Uint8Array([65, 0, 0, 0, 0, 216]))).toBe("A\0\ud800");
  expect(() => values.throwPending()).toThrow("external string pending");
});

for (const encoding of ["latin1", "utf16"] as const) {
  for (const poison of ["constructor", "fromCharCode", "charCodeAt"] as const) {
    it(`native ${encoding} strings ignore application ${poison} getters`, () => {
      const values = fixture(), define = Object.defineProperty;
      const owner = poison === "constructor" ? globalThis : poison === "fromCharCode" ? String : String.prototype;
      const key = poison === "constructor" ? "String" : poison;
      const original = Object.getOwnPropertyDescriptor(owner, key);
      if (original === undefined) throw new Error("Missing string intrinsic");
      const bytes = encoding === "latin1" ? new Uint8Array([65, 0, 255]) : new Uint8Array([65, 0, 0, 0, 0, 216]);
      const text = encoding === "latin1" ? "A\0ÿ" : "A\0\ud800", input = values.add(text), marker = new Error("application string intrinsic");
      let traps = 0;
      define(owner, key, { configurable: true, get() { traps++; throw marker; } });
      let created: ReturnType<NativeValues["dispatch"]>, encoded: ReturnType<NativeValues["dispatch"]>;
      try {
        created = values.dispatch(`napi_create_string_${encoding}`, [], bytes);
        encoded = values.dispatch(`napi_get_value_string_${encoding}`, [input], empty);
      } finally { define(owner, key, original); }
      expect(created.status).toBe(0); expect(encoded.status).toBe(0); expect(traps).toBe(0);
      const handle = created.args[0]; if (handle === undefined) throw new Error("Missing string result");
      expect(values.get(handle)).toBe(text); expect(encoded.bytes).toEqual(bytes);
      expect(() => values.throwPending()).not.toThrow(); values.dispose();
    });
  }
}
