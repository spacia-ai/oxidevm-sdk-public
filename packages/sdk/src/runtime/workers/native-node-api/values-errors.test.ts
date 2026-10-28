import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const empty = new Uint8Array();
function fixture() { return new NativeValues(() => undefined, () => undefined); }

it("permits non-throwing Node-API operations while preserving a pending null or undefined", () => {
  for (const exception of [null, undefined, new Error("first")]) {
    const values = fixture(), original = values.add(exception);
    expect(values.dispatch("napi_throw", [original], empty).status).toBe(0);
    for (const [name, args] of [
      ["napi_get_undefined", []], ["napi_get_null", []], ["napi_create_object", []],
      ["napi_create_int32", [42n]], ["napi_typeof", [original]],
      ["napi_get_value_double", [values.add(42)]],
    ] satisfies readonly (readonly [string, readonly bigint[]])[]) expect(values.dispatch(name, args, empty).status, name).toBe(0);
    expect(values.dispatch("napi_throw", [values.add(new Error("replacement"))], empty).status).toBe(10);
    let calls = 0;
    const object = values.add({ get property() { calls++; throw new Error("getter"); } });
    expect(values.dispatch("napi_get_named_property", [object], new TextEncoder().encode("property")).status).toBe(10);
    expect(calls).toBe(0);
    const result = values.dispatch("napi_get_and_clear_last_exception", [], empty).args[0];
    if (result === undefined) throw new Error("Missing exception handle");
    expect(values.get(result)).toBe(exception);
    expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([0n]);
  }
});

it("creates the requested error class and code without replacing a pending exception", () => {
  const values = fixture(), code = values.add("ERR_NATIVE"), message = values.add("invalid native input");
  const original = new Error("pending"); values.dispatch("napi_throw", [values.add(original)], empty);
  for (const [operation, constructor] of [["napi_create_error", Error], ["napi_create_type_error", TypeError], ["napi_create_range_error", RangeError], ["node_api_create_syntax_error", SyntaxError]] as const) {
    const result = values.dispatch(operation, [code, message], empty);
    expect(result.status).toBe(0);
    const handle = result.args[0]; if (handle === undefined) throw new Error("Missing error handle");
    expect(values.get(handle)).toBeInstanceOf(constructor);
    expect(values.get(handle)).toMatchObject({ code: "ERR_NATIVE", message: "invalid native input" });
    expect(values.dispatch(operation, [0n, values.add(123)], empty).status).toBe(3);
  }
  let caught: unknown; try { values.throwPending(); } catch (error) { caught = error; } expect(caught).toBe(original);
});

it("throws each native error class, distinguishes absent and empty codes, and validates text frames", () => {
  for (const [operation, constructor] of [["napi_throw_error", Error], ["napi_throw_type_error", TypeError], ["napi_throw_range_error", RangeError], ["node_api_throw_syntax_error", SyntaxError]] as const) {
    for (const code of [undefined, "", "ERR_NATIVE"]) {
      const values = fixture(), prefix = code === undefined ? empty : new TextEncoder().encode(code + "\0"), message = new TextEncoder().encode("bad value");
      const payload = new Uint8Array(prefix.length + message.length); payload.set(prefix); payload.set(message, prefix.length);
      expect(values.dispatch(operation, [BigInt(prefix.length), 1n], payload).status).toBe(0);
      const result = values.dispatch("napi_get_and_clear_last_exception", [], empty).args[0]; if (result === undefined) throw new Error("Missing exception");
      expect(values.get(result)).toBeInstanceOf(constructor); expect(values.get(result)).toMatchObject({ message: "bad value" });
      const error = values.get(result); if (typeof error !== "object" || error === null) throw new Error("Missing error object");
      expect(Object.getOwnPropertyDescriptor(error, "code")?.value).toBe(code);
    }
  }
  const values = fixture();
  expect(() => values.dispatch("napi_throw_error", [2n, 1n], new TextEncoder().encode("no separator"))).toThrow(/text/u);
  expect(values.dispatch("napi_throw_error", [0n, 0n], empty).status).toBe(1);
  values.dispatch("napi_throw", [values.add(null)], empty);
  expect(values.dispatch("napi_throw_error", [0n, 0n], empty).status).toBe(10);
  expect(() => values.dispatch("napi_get_property", [], empty)).toThrow(/shape/u);
});

it("retains a throwing getter's value and recovers without converting it into transport failure", () => {
  const values = fixture(), marker: unknown = { marker: true };
  const input = values.add({ get property() { throw marker; } });
  expect(values.dispatch("napi_get_named_property", [input], new TextEncoder().encode("property")).status).toBe(10);
  let caught: unknown;
  try { values.throwPending(); } catch (error) { caught = error; }
  expect(caught).toBe(marker);
  expect(values.dispatch("napi_create_object", [], empty).status).toBe(0);
});
