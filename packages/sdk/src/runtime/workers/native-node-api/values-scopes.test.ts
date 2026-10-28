import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const empty = new Uint8Array();
function handle(values: NativeValues, operation: string, args: readonly bigint[] = []): bigint {
  const result = values.dispatch(operation, args, empty); expect(result.status).toBe(0);
  const identity = result.args[0]; if (identity === undefined || identity === 0n) throw new Error("Missing scope or value identity");
  return identity;
}

it("retires nested public handles, escapes once, and preserves only the parent lifetime", () => {
  const values = new NativeValues(() => undefined, () => undefined), object = {};
  const parent = handle(values, "napi_open_handle_scope"), child = handle(values, "napi_open_escapable_handle_scope");
  const original = values.add(object), escaped = handle(values, "napi_escape_handle", [child, original]);
  expect(values.dispatch("napi_escape_handle", [child, original], empty).status).toBe(12);
  expect(values.dispatch("napi_close_handle_scope", [parent], empty).status).toBe(13);
  expect(values.dispatch("napi_close_handle_scope", [child], empty).status).toBe(13);
  expect(values.dispatch("napi_close_escapable_handle_scope", [child], empty).status).toBe(0);
  expect(() => values.get(original)).toThrow(/handle/u); expect(values.get(escaped)).toBe(object);
  expect(values.dispatch("napi_close_handle_scope", [parent], empty).status).toBe(0);
  expect(() => values.get(escaped)).toThrow(/handle/u);
  expect(() => values.dispatch("napi_close_handle_scope", [parent], empty)).toThrow(/scope/u);
});

it("keeps public scopes separate from reentrant transport scopes and module environments", () => {
  const values = new NativeValues(() => undefined, () => undefined, () => undefined, 37);
  const environment = 0x25_0000_0001n; values.registerEnvironment(environment, 8); values.registerEnvironment(environment + 1n, 10);
  values.createScope(1n); values.createScope(2n);
  values.withScope(1n, () => values.withEnvironment(environment, () => {
    const scope = handle(values, "napi_open_handle_scope"), outer = values.add("outer");
    values.withScope(2n, () => {
      expect(() => values.dispatch("napi_close_handle_scope", [scope], empty)).toThrow(/scope/u);
      const child = handle(values, "napi_open_handle_scope"), inner = values.add("inner");
      expect(values.dispatch("napi_close_handle_scope", [child], empty).status).toBe(0);
      expect(() => values.get(inner)).toThrow(/handle/u);
    });
    expect(values.get(outer)).toBe("outer");
    values.withEnvironment(environment + 1n, () => { expect(() => values.dispatch("napi_close_handle_scope", [scope], empty)).toThrow(/scope/u); });
    expect(values.dispatch("napi_close_handle_scope", [scope], empty).status).toBe(0);
  }));
  values.retireScope(2n); values.retireScope(1n);
});

it("reclaims repeated public scopes while an exception is pending", () => {
  const values = new NativeValues(() => undefined, () => undefined);
  values.dispatch("napi_throw", [values.add(null)], empty);
  for (let iteration = 0; iteration < 1100; iteration++) {
    const scope = handle(values, "napi_open_handle_scope");
    for (let index = 0; index < 64; index++) handle(values, "napi_create_object");
    expect(values.dispatch("napi_close_handle_scope", [scope], empty).status).toBe(0);
  }
  expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([1n]);
});
