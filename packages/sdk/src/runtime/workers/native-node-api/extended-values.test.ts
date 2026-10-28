import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const empty = new Uint8Array();
function value(values: NativeValues, operation: string, args: readonly bigint[], bytes = empty): unknown {
  const result = values.dispatch(operation, args, bytes); expect(result.status).toBe(0);
  const id = result.args[0]; if (id === undefined) throw new Error("Missing native value"); return values.get(id);
}
function bits(input: number): bigint { const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, input, true); return view.getBigUint64(0, true); }

it("keeps all 64 BigInt bits and reports signed and unsigned loss separately", () => {
  const values = new NativeValues(() => undefined, () => undefined);
  expect(value(values, "napi_create_bigint_int64", [0x8000_0000_0000_0000n])).toBe(-(1n << 63n));
  expect(value(values, "napi_create_bigint_uint64", [0xffff_ffff_ffff_ffffn])).toBe((1n << 64n) - 1n);
  for (const input of [0n, -1n, 1n << 63n, -(1n << 63n), (1n << 128n) + 42n]) {
    const handle = values.add(input);
    for (const signed of [true, false]) {
      const output = signed ? BigInt.asIntN(64, input) : BigInt.asUintN(64, input);
      expect(values.dispatch(signed ? "napi_get_value_bigint_int64" : "napi_get_value_bigint_uint64", [handle], empty)).toMatchObject({ status: 0, args: [BigInt.asUintN(64, output), input === output ? 1n : 0n] });
    }
  }
  expect(values.dispatch("napi_get_value_bigint_int64", [values.add(42)], empty).status).toBe(17);
});

it("preserves BigInt word order, sign, zero and truncated output capacity", () => {
  const values = new NativeValues(() => undefined, () => undefined), words = new Uint8Array(24), view = new DataView(words.buffer);
  view.setBigUint64(0, 0xffff_ffff_ffff_ffffn, true); view.setBigUint64(8, 1n, true);
  const input = value(values, "napi_create_bigint_words", [1n], words); expect(input).toBe(-((1n << 65n) - 1n));
  const handle = values.add(input);
  expect(values.dispatch("napi_get_value_bigint_words", [handle, 0n], empty)).toMatchObject({ status: 0, args: [1n, 2n], bytes: empty });
  expect(values.dispatch("napi_get_value_bigint_words", [handle, 1n], empty)).toMatchObject({ status: 0, args: [1n, 2n], bytes: words.slice(0, 8) });
  expect(value(values, "napi_create_bigint_words", [1n], empty)).toBe(0n);
  expect(() => values.dispatch("napi_create_bigint_words", [0n], words.slice(1))).toThrow(/word/u);
});

it("uses Date brand checks without invoking user getters or coercion", () => {
  const values = new NativeValues(() => undefined, () => undefined);
  for (const input of [42.9, -42.9, -0, Infinity, NaN, 8640000000000001]) {
    const date = value(values, "napi_create_date", [bits(input)]); expect(date).toBeInstanceOf(Date);
    const result = values.dispatch("napi_get_date_value", [values.add(date)], empty);
    expect(result).toMatchObject({ status: 0, args: [bits(new Date(input).getTime())] });
  }
  const real = new Date(42); real.valueOf = () => { throw new Error("coercion"); };
  expect(values.dispatch("napi_get_date_value", [values.add(real)], empty)).toMatchObject({ status: 0, args: [bits(42)] });
  const fake = { get [Symbol.toStringTag]() { throw new Error("tag getter"); } };
  for (const input of [fake, new Proxy(real, {}), Date.prototype, null, 42]) {
    expect(values.dispatch("napi_is_date", [values.add(input)], empty)).toMatchObject({ status: 0, args: [0n] });
    expect(values.dispatch("napi_get_date_value", [values.add(input)], empty).status).toBe(18);
  }
});

it.each(["replace-TypeError", "TypeError-hasInstance", "Error-hasInstance"] as const)("keeps Date statuses and private failures independent of %s", (mutation) => {
  const values = new NativeValues(() => undefined, () => undefined), originalTypeError = TypeError;
  const constructor = mutation === "Error-hasInstance" ? Error : originalTypeError;
  const property = mutation === "replace-TypeError" ? "TypeError" : Symbol.hasInstance;
  const target = mutation === "replace-TypeError" ? globalThis : constructor;
  const descriptor = Object.getOwnPropertyDescriptor(target, property), marker = new Error("application getter");
  const date = new Date(42), revoked = Proxy.revocable(date, {});
  revoked.revoke();
  const inputs: readonly unknown[] = [date, new Date(NaN), {}, Object.create(Date.prototype), new Proxy(date, {}), revoked.proxy, null, undefined, 42, 1n, Symbol()];
  const handles = inputs.map((input) => values.add(input));
  const observations: { readonly dateStatus: number; readonly brand: readonly bigint[]; readonly valueStatus: number; readonly pending: readonly bigint[] }[] = [];
  let getters = 0, escaped: unknown;
  if (mutation === "replace-TypeError") Object.defineProperty(target, property, { configurable: true, writable: true, value: class ReplacementTypeError extends Error {} });
  else Object.defineProperty(target, property, { configurable: true, get() { getters++; throw marker; } });
  try {
    for (const handle of handles) {
      const brand = values.dispatch("napi_is_date", [handle], empty);
      const time = values.dispatch("napi_get_date_value", [handle], empty);
      observations.push({ dateStatus: brand.status, brand: brand.args, valueStatus: time.status, pending: values.dispatch("napi_is_exception_pending", [], empty).args });
    }
  } catch (error) { escaped = error; }
  finally {
    if (descriptor === undefined) Reflect.deleteProperty(target, property);
    else Object.defineProperty(target, property, descriptor);
  }
  expect(escaped).toBeUndefined();
  expect(getters).toBe(0);
  expect(observations).toEqual(inputs.map((_, index) => ({ dateStatus: 0, brand: [index < 2 ? 1n : 0n], valueStatus: index < 2 ? 0 : 18, pending: [0n] })));
  values.dispose();
});

it("distinguishes fresh symbols, absent descriptions and registry identity", () => {
  const values = new NativeValues(() => undefined, () => undefined), description = values.add("a\0b");
  const first = value(values, "napi_create_symbol", [description]);
  expect(typeof first).toBe("symbol"); expect(value(values, "napi_create_symbol", [description])).not.toBe(first);
  expect(value(values, "node_api_symbol_for", [description])).toBe(Symbol.for("a\0b"));
  expect(value(values, "napi_create_symbol", [0n])).not.toBe(value(values, "napi_create_symbol", [0n]));
  expect(values.dispatch("napi_create_symbol", [values.add(undefined)], empty).status).toBe(3);
});

it("preserves property key strings across UTF-8, Latin-1 and UTF-16 encodings", () => {
  const values = new NativeValues(() => undefined, () => undefined);
  expect(value(values, "node_api_create_property_key_utf8", [], new Uint8Array([107, 0, 195, 191]))).toBe("k\0ÿ");
  expect(value(values, "node_api_create_property_key_latin1", [], new Uint8Array([107, 0, 255]))).toBe("k\0ÿ");
  expect(value(values, "node_api_create_property_key_utf16", [], new Uint8Array([107, 0, 0, 0, 255, 0]))).toBe("k\0ÿ");
});
