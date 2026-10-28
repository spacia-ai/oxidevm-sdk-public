import { expect, it, vi } from "vitest";
import { NativeValues } from "./values.js";

function fixture(runtime: "node" | "bun" = "node") {
  const invoke = vi.fn((_callback: bigint, receiver: unknown) => receiver);
  const values = new NativeValues(invoke, () => undefined, () => undefined, 0, () => undefined,
    { claim: () => undefined, retire: () => undefined, runtime });
  let next = 4103n;
  function define(name: string) {
    const callback = next; next += 5n;
    const result = values.dispatch("napi_define_class", [callback, 3n,
      values.add("method"), callback + 1n, 0n, 0n, 0n, 5n,
      values.add("staticMethod"), callback + 2n, 0n, 0n, 0n, 1029n,
      values.add("accessor"), 0n, callback + 3n, 0n, 0n, 4n], new TextEncoder().encode(name));
    expect(result.status).toBe(0);
    const handle = result.args[0]; if (handle === undefined) throw new Error("Missing class handle");
    const constructor = values.get(handle); if (typeof constructor !== "function") throw new Error("Missing class constructor");
    const prototype: unknown = Reflect.get(constructor, "prototype");
    if (typeof prototype !== "object" || prototype === null) throw new Error("Missing class prototype");
    const method: unknown = Reflect.get(prototype, "method"), staticMethod: unknown = Reflect.get(constructor, "staticMethod");
    if (typeof method !== "function" || typeof staticMethod !== "function") throw new Error("Missing class method");
    const accessor: unknown = Reflect.get(Object.getOwnPropertyDescriptor(prototype, "accessor") ?? {}, "get");
    if (typeof accessor !== "function") throw new Error("Missing class accessor");
    return { constructor, prototype, method, staticMethod, accessor };
  }
  return { values, invoke, define };
}

it("enforces pinned Node class signatures without prototype traps or native effects", () => {
  const { define, invoke } = fixture(), first = define("First"), second = define("Second");
  const instance: unknown = Reflect.construct(first.constructor, []);
  if (typeof instance !== "object" || instance === null) throw new Error("Missing instance");
  const changed: unknown = Reflect.construct(first.constructor, []);
  if (typeof changed !== "object" || changed === null) throw new Error("Missing changed instance");
  Object.setPrototypeOf(changed, null);
  const trap = vi.fn(() => { throw new Error("Class signatures must not inspect prototypes"); });
  function OrdinaryTarget() {}
  const valid: readonly unknown[] = [instance, changed,
    Reflect.construct(first.constructor, [], OrdinaryTarget),
    Reflect.construct(first.constructor, [], second.constructor),
    Reflect.construct(first.constructor, [], new Proxy(first.constructor, {}))];
  Object.defineProperty(first.constructor, Symbol.hasInstance, { value: trap });
  for (const receiver of valid) {
    invoke.mockClear();
    expect(Reflect.apply(first.method, receiver, [])).toBe(receiver);
    expect(invoke).toHaveBeenCalledTimes(1);
  }
  for (const receiver of [{}, Object.create(first.prototype), Object.create(instance),
    Reflect.construct(second.constructor, []), Reflect.construct(OrdinaryTarget, [], first.constructor),
    null, undefined, 1, new Proxy(instance, { getPrototypeOf: trap }),
    new Proxy(Object.create(instance), { getPrototypeOf: trap }),
    Object.create(new Proxy(instance, { getPrototypeOf: trap }))]) {
    invoke.mockClear();
    expect(() => { Reflect.apply(first.method, receiver, []); }).toThrowError(new TypeError("Illegal invocation"));
    expect(invoke).not.toHaveBeenCalled();
  }
  expect(trap).not.toHaveBeenCalled();
});

it("keeps Node static methods, accessors and separately defined properties unrestricted", () => {
  const { define, values, invoke } = fixture(), native = define("Native");
  const target = {};
  for (const callback of [native.staticMethod, native.accessor]) {
    expect(Reflect.apply(callback, target, [])).toBe(target);
  }
  expect(values.dispatch("napi_define_properties", [values.add(target), 1n,
    values.add("loose"), 4110n, 0n, 0n, 0n, 5n], new Uint8Array()).status).toBe(0);
  const loose: unknown = Reflect.get(target, "loose"); if (typeof loose !== "function") throw new Error("Missing ordinary native method");
  invoke.mockClear();
  expect(Reflect.apply(loose, native.prototype, [])).toBe(native.prototype);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("preserves pinned Bun's callback entry for unrelated class receivers", () => {
  const { define, invoke } = fixture("bun"), native = define("Native"), target = {};
  invoke.mockClear();
  expect(Reflect.apply(native.method, target, [])).toBe(target);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("reports a rejected native method call as a pending application exception and recovers", () => {
  const { define, values, invoke } = fixture(), native = define("Native"), empty = new Uint8Array();
  invoke.mockClear();
  const result = values.dispatch("napi_call_function", [values.add({}), values.add(native.method)], empty);
  expect(result.status).toBe(10);
  expect(invoke).not.toHaveBeenCalled();
  expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([1n]);
  const handle = values.dispatch("napi_get_and_clear_last_exception", [], empty).args[0];
  if (handle === undefined) throw new Error("Missing signature exception");
  expect(values.get(handle)).toEqual(new TypeError("Illegal invocation"));
  const instance: unknown = Reflect.construct(native.constructor, []);
  expect(Reflect.apply(native.method, instance, [])).toBe(instance);
  expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([0n]);
});

it("keeps class identities independent of application changes to WeakSet methods", () => {
  const { define, invoke } = fixture(), native = define("Native");
  const has = Object.getOwnPropertyDescriptor(WeakSet.prototype, "has"), add = Object.getOwnPropertyDescriptor(WeakSet.prototype, "add");
  if (has === undefined || add === undefined) throw new Error("Missing WeakSet methods");
  let methodError: unknown, constructorError: unknown, instance: unknown, methodCalls: number | undefined;
  invoke.mockClear();
  try {
    Object.defineProperty(WeakSet.prototype, "has", { ...has, value: () => true });
    try { Reflect.apply(native.method, {}, []); } catch (error) { methodError = error; }
    methodCalls = invoke.mock.calls.length;
    Object.defineProperty(WeakSet.prototype, "add", { ...add, value: () => { throw new Error("Application WeakSet.add"); } });
    try { instance = Reflect.construct(native.constructor, []); } catch (error) { constructorError = error; }
  } finally {
    Object.defineProperty(WeakSet.prototype, "has", has); Object.defineProperty(WeakSet.prototype, "add", add);
  }
  expect(methodError).toEqual(new TypeError("Illegal invocation"));
  expect(methodCalls).toBe(0); expect(constructorError).toBeUndefined();
  expect(Reflect.apply(native.method, instance, [])).toBe(instance);
});

it("captures class identity and error constructors before application globals change", () => {
  const { values } = fixture(), weakSet = Object.getOwnPropertyDescriptor(globalThis, "WeakSet"), typeError = Object.getOwnPropertyDescriptor(globalThis, "TypeError");
  if (weakSet === undefined || typeError === undefined) throw new Error("Missing class intrinsics");
  const NativeTypeError = TypeError, methodName = values.add("method");
  let rejected: unknown, failed: unknown, instance: unknown, returned: unknown;
  try {
    Object.defineProperty(globalThis, "WeakSet", { ...weakSet, value: class ReplacedWeakSet { has() { return true; } add() { return this; } } });
    Object.defineProperty(globalThis, "TypeError", { ...typeError, value: class ReplacedTypeError extends Error {} });
    const result = values.dispatch("napi_define_class", [4200n, 1n, methodName, 4201n, 0n, 0n, 0n, 5n], new TextEncoder().encode("Protected"));
    const handle = result.args[0]; if (handle === undefined) throw new Error("Missing protected class");
    const constructor = values.get(handle); if (typeof constructor !== "function") throw new Error("Missing protected constructor");
    instance = Reflect.construct(constructor, []);
    if (typeof instance !== "object" || instance === null) throw new Error("Missing protected instance");
    const method: unknown = Reflect.get(instance, "method"); if (typeof method !== "function") throw new Error("Missing protected method");
    returned = Reflect.apply(method, instance, []);
    try { Reflect.apply(method, {}, []); } catch (error) { rejected = error; }
  } catch (error) { failed = error; }
  finally {
    Object.defineProperty(globalThis, "WeakSet", weakSet); Object.defineProperty(globalThis, "TypeError", typeError);
  }
  expect(failed).toBeUndefined(); expect(returned).toBe(instance);
  expect(rejected).toBeInstanceOf(NativeTypeError);
});

it("permits method construction without branding its result as a class instance", () => {
  const { define, invoke } = fixture(), native = define("Native");
  for (const target of [native.method, native.constructor]) {
    invoke.mockClear();
    const instance: unknown = Reflect.construct(native.method, [], target);
    expect(invoke).toHaveBeenCalledTimes(1);
    invoke.mockClear();
    expect(() => { Reflect.apply(native.method, instance, []); }).toThrowError(new TypeError("Illegal invocation"));
    expect(invoke).not.toHaveBeenCalled();
  }
});
