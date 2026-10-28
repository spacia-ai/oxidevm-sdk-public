import { expect, it } from "vitest";
import { VMError } from "../../errors.js";
import { NapiFailure } from "./errors.js";
import { NativeValues, type NativeResult } from "./values.js";

const empty = new Uint8Array();
const operations = ["napi_call_function", "napi_get_named_property", "napi_new_instance", "napi_coerce_to_string"] as const;

it.each(operations)("preserves opaque application exceptions from %s without prototype inspection", (operation) => {
  for (const poison of [false, true]) for (const kind of ["object", "proxy", "revoked", "undefined", "symbol", "error", "promise", "forged-protocol", "forged-status"]) {
    const values = new NativeValues(() => undefined, () => undefined), marker = new Error("classification trap");
    let traps = 0;
    const proxy = new Proxy({}, { getPrototypeOf() { traps++; throw marker; } }), revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const promise = Promise.resolve(17); void Object.defineProperty(promise, "then", { get() { traps++; throw marker; } });
    const exception: unknown = kind === "object" ? {} : kind === "proxy" ? proxy : kind === "revoked" ? revoked.proxy : kind === "undefined" ? undefined : kind === "symbol" ? Symbol() : kind === "promise" ? promise : kind === "forged-protocol" ? Object.create(VMError.prototype) : kind === "forged-status" ? Object.create(NapiFailure.prototype) : new Error("application");
    const callback = function Target() { throw exception; }, input = operation === "napi_get_named_property" ? { get x() { throw exception; } } : operation === "napi_coerce_to_string" ? { [Symbol.toPrimitive]() { throw exception; } } : callback;
    const args = operation === "napi_call_function" ? [values.add(undefined), values.add(input)] : [values.add(input)];
    const bytes = operation === "napi_get_named_property" ? new TextEncoder().encode("x") : empty;
    const descriptor = Object.getOwnPropertyDescriptor(Error, Symbol.hasInstance);
    let result: NativeResult | undefined, escaped = false;
    if (poison) Object.defineProperty(Error, Symbol.hasInstance, { configurable: true, get() { traps++; throw marker; } });
    try { result = values.dispatch(operation, args, bytes); }
    catch { escaped = true; }
    finally {
      if (descriptor === undefined) Reflect.deleteProperty(Error, Symbol.hasInstance);
      else Object.defineProperty(Error, Symbol.hasInstance, descriptor);
    }
    const pending = values.dispatch("napi_is_exception_pending", [], empty).args[0] === 1n;
    const cleared = values.dispatch("napi_get_and_clear_last_exception", [], empty).args[0];
    const original = cleared !== undefined && values.get(cleared) === exception;
    expect({ poison, kind, escaped, traps, status: result?.status, pending, original }).toEqual({ poison, kind, escaped: false, traps: 0, status: operation === "napi_coerce_to_string" ? 3 : 10, pending: true, original: true });
    expect(result?.args).toEqual([]);
    expect(result?.bytes).toEqual(empty);
    values.dispose();
  }
});

it("keeps malformed requests as protocol failures when Error.hasInstance is poisoned", () => {
  const values = new NativeValues(() => undefined, () => undefined), marker = new Error("application getter");
  const descriptor = Object.getOwnPropertyDescriptor(Error, Symbol.hasInstance);
  let getters = 0, caught: unknown;
  Object.defineProperty(Error, Symbol.hasInstance, { configurable: true, get() { getters++; throw marker; } });
  try { values.dispatch("napi_get_value_int32", [], empty); }
  catch (error) { caught = error; }
  finally {
    if (descriptor === undefined) Reflect.deleteProperty(Error, Symbol.hasInstance);
    else Object.defineProperty(Error, Symbol.hasInstance, descriptor);
  }
  expect(caught).toBeInstanceOf(VMError);
  expect(caught).toMatchObject({ code: "PROTOCOL_ERROR", message: "Invalid napi_get_value_int32 argument shape" });
  expect(getters).toBe(0);
  expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([0n]);
  values.dispose();
});
