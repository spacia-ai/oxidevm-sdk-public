import { describe, expect, it, vi } from "vitest";
import { NativeValues } from "./values.js";

it("restores module version across nested environments and rejects retired identities", () => {
  const values = new NativeValues(() => undefined, () => undefined, () => undefined, 37);
  const first = 0x25_0000_0001n, second = first + 1n;
  values.registerEnvironment(first, 8); values.registerEnvironment(second, 10);
  values.withEnvironment(second, () => {
    expect(values.moduleVersion).toBe(10);
    values.withEnvironment(first, () => { expect(values.moduleVersion).toBe(8); });
    expect(values.moduleVersion).toBe(10);
  });
  expect(values.moduleVersion).toBe(8);
  expect(() => values.registerEnvironment(first, 8)).toThrow(/registration/u);
  expect(() => values.withEnvironment(0x26_0000_0001n, () => values.add("forged"))).toThrow(/environment/u);
  values.dispose();
  expect(() => values.withEnvironment(first, () => undefined)).toThrow(/environment/u);
});

describe("Node-API values", () => {
  it("matches Node's ordinary-object prototypes, primitive boxing and nullish failures", () => {
    const values = new NativeValues(() => undefined, () => undefined), empty = new Uint8Array();
    const parent = { inherited: true };
    for (const value of [Object.create(parent), Object.create(null), () => undefined, 1, 1n, "x", true, Symbol("key")]) {
      const result = values.dispatch("napi_get_prototype", [values.add(value)], empty);
      expect(result.status).toBe(0);
      const handle = result.args[0]; if (handle === undefined) throw new Error("Missing prototype");
      expect(values.get(handle)).toBe(Object.getPrototypeOf(value));
    }
    for (const value of [undefined, null]) {
      expect(values.dispatch("napi_get_prototype", [values.add(value)], empty).status).toBe(2);
      expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([1n]);
      expect(() => values.throwPending()).toThrow(TypeError);
    }
  });

  it("tests own string/symbol properties and strict equality without coercing keys or values", () => {
    const values = new NativeValues(() => undefined, () => undefined), empty = new Uint8Array();
    const symbol = Symbol("own"), target: unknown = Object.assign(Object.create({ inherited: true }), { own: true, [symbol]: true });
    for (const [key, expected] of [["own", 1n], ["inherited", 0n], [symbol, 1n]] as const) {
      expect(values.dispatch("napi_has_own_property", [values.add(target), values.add(key)], empty).args).toEqual([expected]);
    }
    expect(values.dispatch("napi_has_own_property", [values.add("x"), values.add("length")], empty).args).toEqual([1n]);
    expect(values.dispatch("napi_has_own_property", [values.add(target), values.add(1)], empty).status).toBe(4);
    for (const [left, right, expected] of [[target, target, 1n], [{}, {}, 0n], [NaN, NaN, 0n], [0, -0, 1n], ["1", 1, 0n]] as const) {
      expect(values.dispatch("napi_strict_equals", [values.add(left), values.add(right)], empty).args).toEqual([expected]);
    }
    expect(() => values.dispatch("napi_get_prototype", [], empty)).toThrow(/argument/u);
    expect(() => values.dispatch("napi_has_own_property", [values.add(target)], empty)).toThrow(/argument/u);
    expect(() => values.dispatch("napi_strict_equals", [values.add(target)], empty)).toThrow(/argument/u);
  });

  it("removes one native finalizer without removing another registration on the same object", async () => {
    const registrations = new Map<object, { callback: bigint; token: object }[]>();
    let collected: ((callback: bigint) => void) | undefined;
    class Registry {
      constructor(callback: (identity: bigint) => void) { collected = callback; }
      register(target: object, callback: bigint, token: object) { registrations.set(target, [...registrations.get(target) ?? [], { callback, token }]); }
      unregister(token: object) { for (const [target, entries] of registrations) registrations.set(target, entries.filter(entry => entry.token !== token)); return true; }
    }
    vi.stubGlobal("FinalizationRegistry", Registry);
    try {
      vi.resetModules(); const { NativeValues: ControlledValues } = await import("./values.js");
      const finalized: bigint[] = [], values = new ControlledValues(() => undefined, callback => { finalized.push(callback); });
      const empty = new Uint8Array(), handle = values.dispatch("napi_create_external", [1n, 4103n], empty).args[0];
      if (handle === undefined) throw new Error("Missing external handle");
      const target = values.get(handle);
      if (typeof target !== "object" || target === null) throw new Error("Missing external object");
      expect(values.dispatch("napi_wrap", [handle, 2n, 4104n, 0n], empty).status).toBe(0);
      expect(values.dispatch("napi_remove_wrap", [handle], empty).status).toBe(0);
      expect(registrations.get(target)).toHaveLength(1);
      for (const entry of registrations.get(target) ?? []) collected?.(entry.callback);
      expect(finalized).toEqual([4103n]);
      values.dispose(); expect(finalized).toEqual([4103n]);
    } finally { vi.unstubAllGlobals(); vi.resetModules(); }
  });
  it("keeps an async completion's handles alive across unrelated native invocations", () => {
    const values = new NativeValues(() => undefined, () => undefined);
    values.createScope(1n); values.createScope(0x1_0000_0001n);
    const completion = values.withScope(0x1_0000_0001n, () => values.add({ completion: true }));
    const invocation = values.withScope(1n, () => values.add({ invocation: true }));
    values.retireScope(1n);
    expect(() => values.get(invocation)).toThrow(/stale/u);
    expect(values.get(completion)).toEqual({ completion: true });
    values.retireScope(0x1_0000_0001n);
    expect(() => values.get(completion)).toThrow(/stale/u);
  });
  it("settles a deferred once and retires finalizers once", async () => {
    const finalized: bigint[] = [], values = new NativeValues(() => undefined, callback => { finalized.push(callback); });
    const created = values.dispatch("napi_create_promise", [], new Uint8Array()), id = created.args[0], handle = created.args[1];
    if (id === undefined || handle === undefined) throw new Error("missing deferred");
    const value = { identity: "resolved" };
    expect(values.dispatch("napi_resolve_deferred", [id, values.add(value)], new Uint8Array()).status).toBe(0);
    await expect(values.get(handle)).resolves.toBe(value);
    expect(values.dispatch("napi_resolve_deferred", [id, values.add(value)], new Uint8Array()).status).toBe(1);
    const removed = values.add({});
    values.dispatch("napi_wrap", [removed, 42n, 4103n, 0n], new Uint8Array());
    values.dispatch("napi_remove_wrap", [removed], new Uint8Array());
    values.dispatch("napi_wrap", [values.add({}), 43n, 4104n, 0n], new Uint8Array());
    values.dispose(); values.dispose(); expect(finalized).toEqual([4104n]);
  });
  it("retains references after call scope retirement and fences stale handles", () => {
    const values = new NativeValues(() => undefined, () => undefined);
    values.createScope(1n);
    const object = { message: "retained" }, handle = values.withScope(1n, () => values.add(object));
    const reference = values.dispatch("napi_create_reference", [handle, 1n], new Uint8Array());
    expect(reference.status).toBe(0);
    const ref = reference.args[0]; if (ref === undefined) throw new Error("missing reference");
    values.retireScope(1n); expect(() => values.get(handle)).toThrow(/stale/u);
    const restored = values.dispatch("napi_get_reference_value", [ref], new Uint8Array());
    const restoredHandle = restored.args[0]; if (restoredHandle === undefined) throw new Error("missing restored handle");
    expect(values.get(restoredHandle)).toBe(object);
    expect(values.dispatch("napi_delete_reference", [ref], new Uint8Array()).status).toBe(0);
    expect(values.dispatch("napi_get_reference_value", [ref], new Uint8Array()).status).toBe(1);
  });

  it("preserves JavaScript callback identity, receiver and re-entrant invocation", () => {
    const calls: unknown[][] = [];
    const values = new NativeValues((callback, receiver, target, args) => { calls.push([callback, receiver, target, args]); return args[0]; }, () => undefined);
    const created = values.dispatch("napi_create_function", [4103n], new TextEncoder().encode("roundtrip"));
    const handle = created.args[0]; if (handle === undefined) throw new Error("missing callback handle");
    const fn = values.get(handle); if (typeof fn !== "function") throw new Error("missing callback");
    const receiver = { name: "receiver" }, input = { value: "same object" };
    expect(Reflect.apply(fn, receiver, [input])).toBe(input);
    expect(calls).toEqual([[4103n, receiver, undefined, [input]]]);
  });

  it("preserves exception identity and clears only the requested pending error", () => {
    const values = new NativeValues(() => undefined, () => undefined), error = new Error("native error");
    expect(values.dispatch("napi_throw", [values.add(error)], new Uint8Array()).status).toBe(0);
    expect(values.dispatch("napi_is_exception_pending", [], new Uint8Array()).args).toEqual([1n]);
    const cleared = values.dispatch("napi_get_and_clear_last_exception", [], new Uint8Array()).args[0];
    if (cleared === undefined) throw new Error("missing exception handle");
    expect(values.get(cleared)).toBe(error);
    expect(values.dispatch("napi_is_exception_pending", [], new Uint8Array()).args).toEqual([0n]);
  });

  it("rejects malformed argument shapes and does not fake unknown operations", () => {
    const values = new NativeValues(() => undefined, () => undefined);
    expect(() => values.dispatch("napi_set_property", [], new Uint8Array())).toThrow(/argument/u);
    expect(() => values.dispatch("napi_not_real", [], new Uint8Array())).toThrow(/Unsupported/u);
  });

  it("bounds live scopes and promises and releases capacity after retirement", () => {
    const values = new NativeValues(() => undefined, () => undefined);
    for (let index = 1n; index <= 192n; index++) values.createScope(index);
    expect(() => values.createScope(193n)).toThrow(/scope/u);
    values.retireScope(1n); values.createScope(193n);
    for (let index = 0; index < 128; index++) values.dispatch("napi_create_promise", [], new Uint8Array());
    expect(() => values.dispatch("napi_create_promise", [], new Uint8Array())).toThrow(/promise limit/u);
    values.dispatch("napi_resolve_deferred", [1n, values.add(undefined)], new Uint8Array());
    expect(values.dispatch("napi_create_promise", [], new Uint8Array()).status).toBe(0);
  });

  it("creates sparse arrays and passes the actual instance to native accessors", () => {
    const receivers: unknown[] = [];
    const values = new NativeValues((_callback, receiver) => { receivers.push(receiver); return "property"; }, () => undefined);
    const arrayHandle = values.dispatch("napi_create_array_with_length", [2n], new Uint8Array()).args[0];
    if (arrayHandle === undefined) throw new Error("missing array handle");
    const array = values.get(arrayHandle); if (!Array.isArray(array)) throw new Error("missing array");
    expect(0 in array).toBe(false);
    const name = values.add("field");
    const classHandle = values.dispatch("napi_define_class", [4103n, 1n, name, 0n, 4104n, 0n, 0n, 4n], new TextEncoder().encode("NativeClass")).args[0];
    if (classHandle === undefined) throw new Error("missing class");
    const constructor = values.get(classHandle); if (typeof constructor !== "function") throw new Error("missing constructor");
    const prototype: unknown = Reflect.get(constructor, "prototype");
    if (typeof prototype !== "object" || prototype === null) throw new Error("missing prototype");
    const instance: unknown = Object.create(prototype);
    if (typeof instance !== "object" || instance === null) throw new Error("missing instance");
    expect(Reflect.get(instance, "field")).toBe("property");
    expect(receivers).toEqual([instance]);
  });
});

it("preserves Node-API numeric conversions, inherited names, arrays and construction", () => {
  const values = new NativeValues(() => undefined, () => undefined), empty = new Uint8Array();
  const get = (operation: string, args: readonly bigint[]) => {
    const result = values.dispatch(operation, args, empty); expect(result.status).toBe(0);
    const handle = result.args[0]; if (handle === undefined) throw new Error("Missing result handle"); return values.get(handle);
  };
  expect(get("napi_create_int32", [0xffff_ffffn])).toBe(-1);
  expect(get("napi_create_uint32", [0xffff_ffffn])).toBe(4294967295);
  expect(get("napi_create_int64", [0xffff_ffff_ffff_fff9n])).toBe(-7);
  const bits = new DataView(new ArrayBuffer(8)); bits.setFloat64(0, -3.5, true);
  expect(get("napi_create_double", [bits.getBigUint64(0, true)])).toBe(-3.5);
  expect(values.dispatch("napi_get_value_double", [values.add(-3.5)], empty).args).toEqual([bits.getBigUint64(0, true)]);
  expect(values.dispatch("napi_get_value_uint32", [values.add(-1.75)], empty).args).toEqual([0xffff_ffffn]);
  expect(values.dispatch("napi_get_value_double", [values.add("invalid")], empty).status).toBe(6);
  const array = values.add(["a", "b"]);
  expect(values.dispatch("napi_is_array", [array], empty).args).toEqual([1n]);
  expect(values.dispatch("napi_get_array_length", [array], empty).args).toEqual([2n]);
  expect(get("napi_get_element", [array, 1n])).toBe("b");
  const inherited = { own: 1 }; Object.setPrototypeOf(inherited, { inherited: true });
  expect(get("napi_get_property_names", [values.add(inherited)])).toEqual(["own", "inherited"]);
  class Example { constructor(readonly value: unknown) {} }
  expect(get("napi_new_instance", [values.add(Example), values.add(17)])).toEqual(new Example(17));
});

it("preserves typed-array backing identity, offsets and owned buffer updates", () => {
  const released: number[] = [];
  const values = new NativeValues(() => undefined, () => undefined, id => { released.push(id); });
  const empty = new Uint8Array(), backing = new ArrayBuffer(16), a = new Uint16Array(backing, 4, 3), b = new Uint8Array(backing, 6, 2);
  a.set([11, 22, 33]);
  expect(values.dispatch("napi_is_typedarray", [values.add(a)], empty).args).toEqual([1n]);
  expect(values.dispatch("napi_is_typedarray", [values.add(new DataView(backing))], empty).args).toEqual([0n]);
  const first = values.dispatch("napi_get_typedarray_info", [values.add(a)], empty);
  const second = values.dispatch("napi_get_buffer_info", [values.add(b)], empty);
  expect(first.args.slice(0, 4)).toEqual([1n, 4n, 3n, 4n]);
  expect(second.args.slice(0, 4)).toEqual([1n, 1n, 2n, 6n]);
  expect(first.bytes).toEqual(new Uint8Array(backing));
  const handle = first.args[4]; if (handle === undefined) throw new Error("Missing array buffer");
  expect(values.get(handle)).toBe(backing);
  const created = values.dispatch("napi_create_buffer_copy", [], new Uint8Array([7, 8]));
  const createdHandle = created.args[0], id = created.args[1];
  if (createdHandle === undefined || id === undefined) throw new Error("Missing owned buffer");
  expect(values.dispatch("buffer-update", [id], new Uint8Array([9, 10])).status).toBe(0);
  expect(values.get(createdHandle)).toEqual(expect.objectContaining({ 0: 9, 1: 10 }));
  const owned = values.get(createdHandle);
  if (!(owned instanceof Uint8Array)) throw new Error("Missing owned buffer");
  owned[0] = 42;
  expect(() => values.dispatch("buffer-update", [id], new Uint8Array([11, 12]))).toThrow(/concurrent/u);
  expect(owned[0]).toBe(42);
  expect(() => values.dispatch("buffer-update", [id], empty)).toThrow(/length/u);
  expect(() => values.dispatch("napi_get_typedarray_info", [values.add(new Uint8Array(new SharedArrayBuffer(8)))], empty)).toThrow(/shared/u);
  values.dispose(); values.dispose(); expect(released).toEqual([1, 2]);
});

it("fences value and reference handles from another native environment", () => {
  const one = new NativeValues(() => undefined, () => undefined, () => undefined, 7);
  const two = new NativeValues(() => undefined, () => undefined, () => undefined, 8);
  const handle = one.add({ source: 7 }); two.add({ source: 8 });
  expect(handle).toBe(0x7_0000_0001n);
  expect(() => two.get(handle)).toThrow(/stale/u);
  const ref = one.dispatch("napi_create_reference", [handle, 1n], new Uint8Array()).args[0];
  const other = two.dispatch("napi_create_reference", [0x8_0000_0001n, 1n], new Uint8Array());
  expect(other.status).toBe(0);
  if (ref === undefined) throw new Error("Missing reference");
  expect(two.dispatch("napi_get_reference_value", [ref], new Uint8Array()).status).toBe(1);
});
