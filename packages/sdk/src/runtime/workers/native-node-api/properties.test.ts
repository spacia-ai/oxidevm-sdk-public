import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const empty = new Uint8Array();
function fixture() { return new NativeValues(() => undefined, () => undefined); }
function read(values: NativeValues, operation: string, input: unknown): unknown {
  const result = values.dispatch(operation, [values.add(input)], empty); expect(result.status).toBe(0);
  const id = result.args[0]; if (id === undefined) throw new Error("Missing value"); return values.get(id);
}

it("coerces booleans without reading properties and numbers with ToNumber semantics", () => {
  const values = fixture(), events: string[] = [];
  expect(read(values, "napi_coerce_to_bool", new Proxy({}, { get() { throw new Error("Unexpected coercion"); } }))).toBe(true);
  for (const input of [null, 0, 0n, "", undefined, NaN]) expect(read(values, "napi_coerce_to_bool", input)).toBe(false);
  expect(read(values, "napi_coerce_to_number", -0)).toBe(-0);
  expect(read(values, "napi_coerce_to_number", { [Symbol.toPrimitive](hint: string) { events.push(hint); return "42"; } })).toBe(42);
  expect(events).toEqual(["number"]);
  for (const input of [1n, Symbol(), { valueOf: () => 1n }]) {
    expect(values.dispatch("napi_coerce_to_number", [values.add(input)], empty).status).toBe(6);
    expect(() => values.throwPending()).toThrow(TypeError);
  }
});

it.each(["Boolean", "String", "Object"] as const)("coerces values without reading the application %s constructor", (constructor) => {
  const values = fixture(), handle = values.add(17), define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, constructor), marker = new Error("application constructor getter");
  if (descriptor === undefined) throw new Error("Missing constructor descriptor");
  const operation = constructor === "Boolean" ? "napi_coerce_to_bool" : constructor === "String" ? "napi_coerce_to_string" : "napi_coerce_to_object";
  let getters = 0, status: number | undefined, result: bigint | undefined, escaped = false;
  define(globalThis, constructor, { configurable: true, get() { getters++; throw marker; } });
  try { const output = values.dispatch(operation, [handle], empty); status = output.status; result = output.args[0]; }
  catch { escaped = true; }
  finally { define(globalThis, constructor, descriptor); }
  expect({ getters, escaped, status }).toEqual({ getters: 0, escaped: false, status: 0 });
  if (result === undefined) throw new Error("Missing coerced value");
  expect(values.get(result)).toEqual(constructor === "Boolean" ? true : constructor === "String" ? "17" : Object(17));
  values.dispose();
});

it("keeps conversion failure statuses and pending intrinsic exceptions", () => {
  for (const [operation, input, status] of [["napi_coerce_to_string", Symbol(), 3], ["napi_coerce_to_object", null, 2], ["napi_coerce_to_object", undefined, 2]] as const) {
    const values = fixture();
    expect(values.dispatch(operation, [values.add(input)], empty)).toMatchObject({ status, args: [], bytes: empty });
    expect(() => values.throwPending()).toThrow(TypeError);
    expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([0n]);
    values.dispose();
  }
});

it("checks inherited elements and deletes properties with optional key coercion", () => {
  const values = fixture(), input = { 1: 1 }, events: string[] = []; Object.setPrototypeOf(input, { 0: 9 });
  const target = values.add(input);
  expect(values.dispatch("napi_has_element", [target, 0n], empty)).toMatchObject({ status: 0, args: [1n] });
  expect(values.dispatch("napi_delete_element", [target, 0n], empty)).toMatchObject({ status: 0, args: [1n] });
  expect(values.dispatch("napi_has_element", [target, 0n], empty).args).toEqual([1n]);
  expect(values.dispatch("napi_delete_property", [target, values.add({ toString() { events.push("key"); return "1"; } })], empty).args).toEqual([1n]);
  expect(events).toEqual(["key"]); expect(Object.hasOwn(input, 1)).toBe(false);
  const frozen = values.add(Object.freeze({ 3: true }));
  expect(values.dispatch("napi_delete_element", [frozen, 3n], empty).args).toEqual([0n]);
  expect(values.dispatch("napi_has_element", [values.add(null), 0n], empty).status).toBe(2);
  expect(() => values.throwPending()).toThrow(TypeError);
  expect(() => values.dispatch("napi_has_element", [target, 0x1_0000_0000n], empty)).toThrow(/Invalid native/u);
});

it("retains property trap failures and integrity-level proxy ordering", () => {
  const values = fixture(), marker = new Error("trap"), events: string[] = [], input = { x: 1 };
  const proxy = new Proxy(input, {
    preventExtensions(target) { events.push("prevent"); return Reflect.preventExtensions(target); },
    ownKeys(target) { events.push("keys"); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { events.push("descriptor"); return Reflect.getOwnPropertyDescriptor(target, key); },
    defineProperty(target, key, descriptor) { events.push("define"); return Reflect.defineProperty(target, key, descriptor); }
  });
  expect(values.dispatch("napi_object_freeze", [values.add(proxy)], empty).status).toBe(0);
  expect(events).toEqual(["prevent", "keys", "descriptor", "define"]); expect(Object.isFrozen(input)).toBe(true);
  const throwing = values.add(new Proxy({}, { deleteProperty() { throw marker; } }));
  expect(values.dispatch("napi_delete_property", [throwing, values.add("x")], empty).status).toBe(10);
  expect(() => values.throwPending()).toThrow(marker);
});

it("uses constructor hooks for primitives, bound functions and separate error statuses", () => {
  const values = fixture(), events: unknown[] = [];
  class Constructor { readonly value = 1; } const instance = new Constructor();
  function Custom() {} Object.defineProperty(Custom, Symbol.hasInstance, { value(input: unknown) { events.push(input); return 1; } });
  const call = (input: unknown, constructor: unknown) => values.dispatch("napi_instanceof", [values.add(input), values.add(constructor)], empty);
  expect(call(7, Custom)).toMatchObject({ status: 0, args: [1n] }); expect(events).toEqual([7]);
  expect(call(instance, Constructor.bind(undefined)).args).toEqual([1n]);
  expect(call({}, {})).toMatchObject({ status: 5 });
  let caught: unknown; try { values.throwPending(); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ code: "ERR_NAPI_CONS_FUNCTION" });
  const marker = new Error("instance hook");
  expect(call(instance, new Proxy(Constructor, { get() { throw marker; } })).status).toBe(9);
  expect(() => values.throwPending()).toThrow(marker);
});

it("captures property assignment before application replacement", () => {
  for (const name of ["set", "apply"] as const) {
    const values = fixture(), target = {}, handle = values.add(target), input = values.add(42);
    const descriptor = Object.getOwnPropertyDescriptor(Reflect, name);
    if (descriptor === undefined) throw new Error("Missing property intrinsic");
    let calls = 0;
    const statuses: number[] = [];
    Object.defineProperty(Reflect, name, { configurable: true, value() { calls++; throw new Error("application replacement"); } });
    try {
      statuses.push(values.dispatch("napi_set_named_property", [handle, input], new TextEncoder().encode("named")).status);
      statuses.push(values.dispatch("napi_set_property", [handle, values.add({ toString: () => "key" }), input], empty).status);
      statuses.push(values.dispatch("napi_set_element", [handle, 7n, input], empty).status);
    } finally { Object.defineProperty(Reflect, name, descriptor); }
    expect(calls).toBe(0);
    expect(statuses).toEqual([0, 0, 0]);
    expect(target).toEqual({ named: 42, key: 42, 7: 42 });
    values.dispose();
  }
});
