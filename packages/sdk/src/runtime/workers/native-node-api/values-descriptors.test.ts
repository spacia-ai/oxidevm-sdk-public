import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const empty = new Uint8Array(), name = new TextEncoder().encode("Target");
const operations = ["napi_define_properties", "napi_define_class"] as const;

it.each(operations)("accepts %s descriptors up to the existing frame capacity", operation => {
  for (const count of [0, 1, 127, 128, 129, 255, 512, 682]) {
    const values = new NativeValues(() => undefined, () => undefined), target = {}, value = values.add(17);
    const args = [operation === "napi_define_class" ? 4103n : values.add(target), BigInt(count)];
    for (let index = 0; index < count; index++) args.push(values.add(`field-${index}`), 0n, 0n, 0n, value, 7n);
    const result = values.dispatch(operation, args, operation === "napi_define_class" ? name : empty);
    expect(result.status).toBe(0);
    let object: unknown = target;
    if (operation === "napi_define_class") {
      const handle = result.args[0]; if (handle === undefined) throw new Error("Missing class");
      const constructor = values.get(handle); if (typeof constructor !== "function") throw new Error("Missing constructor");
      object = Reflect.get(constructor, "prototype");
    }
    if (typeof object !== "object" || object === null) throw new Error("Missing descriptor target");
    expect(Object.keys(object)).toHaveLength(count);
    if (count !== 0) {
      expect(Reflect.get(object, "field-0")).toBe(17);
      expect(Reflect.get(object, `field-${count - 1}`)).toBe(17);
    }
    values.dispose();
  }
});

it.each(operations)("does not read application String for %s method names", operation => {
  const values = new NativeValues(() => undefined, () => undefined), target = {}, descriptor = Object.getOwnPropertyDescriptor(globalThis, "String");
  const args = [operation === "napi_define_class" ? 4103n : values.add(target), 1n, values.add("field"), 4104n, 0n, 0n, 0n, 7n], marker = new Error("application String getter");
  let traps = 0, status: number | undefined, output: readonly bigint[] | undefined;
  Object.defineProperty(globalThis, "String", { configurable: true, get() { traps++; throw marker; } });
  try {
    const result = values.dispatch(operation, args, operation === "napi_define_class" ? name : empty); status = result.status; output = result.args;
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, "String");
    else Object.defineProperty(globalThis, "String", descriptor);
  }
  expect(status).toBe(0); expect(traps).toBe(0);
  let object: unknown = target;
  if (operation === "napi_define_class") {
    const handle = output[0]; if (handle === undefined) throw new Error("Missing class");
    const constructor = values.get(handle); if (typeof constructor !== "function") throw new Error("Missing constructor");
    object = Reflect.get(constructor, "prototype");
  }
  if (typeof object !== "object" || object === null) throw new Error("Missing descriptor target");
  const method: unknown = Reflect.get(object, "field");
  if (typeof method !== "function") throw new Error("Missing method");
  expect(method.name).toBe(operation === "napi_define_class" ? "field" : "");
  expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([0n]);
  values.dispose();
});

it.each(operations)("rejects %s descriptor vectors above the frame capacity before effects", operation => {
  const values = new NativeValues(() => undefined, () => undefined), target = {};
  const args = [operation === "napi_define_class" ? 4103n : values.add(target), 683n, ...Array<bigint>(4098).fill(0n)];
  expect(() => values.dispatch(operation, args, operation === "napi_define_class" ? name : empty)).toThrow(/argument/u);
  expect(Object.keys(target)).toEqual([]);
  values.dispose();
});

it.each(operations)("validates every %s transport field before writes or callback claims", operation => {
  for (const field of ["key", "value", "method", "getter", "setter", "attributes"] as const) {
    const claims: bigint[] = [], retired: bigint[] = [], target = {};
    const values = new NativeValues(() => undefined, () => undefined, () => undefined, 0, () => undefined,
      { claim(identity) { claims.push(identity); }, retire(identity) { retired.push(identity); } });
    const value = values.add(17), key = values.add("second"), invalid = 0xffff_ffff_ffff_ffffn;
    const second = [key, 0n, 0n, 0n, value, 7n];
    const offset = { key: 0, method: 1, getter: 2, setter: 3, value: 4, attributes: 5 }[field];
    second[offset] = field === "attributes" ? 0x1_0000_0000n : invalid;
    const args = [operation === "napi_define_class" ? 4103n : values.add(target), 2n,
      values.add("first"), 0n, 0n, 0n, value, 7n, ...second];
    let error: unknown;
    try { values.dispatch(operation, args, operation === "napi_define_class" ? name : empty); } catch (caught) { error = caught; }
    expect(error).toHaveProperty("code", "PROTOCOL_ERROR");
    expect(Object.keys(target)).toEqual([]);
    expect(claims).toEqual([]);
    expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([0n]);
    values.dispose();
    expect(retired).toEqual([]);
  }
});

it.each(operations)("rejects colliding %s callback slots before any effects", operation => {
  for (const secondCallback of [4104n, 8200n]) {
    const claims: bigint[] = [], target = {};
    const values = new NativeValues(() => undefined, () => undefined, () => undefined, 0, () => undefined,
      { claim(identity) { claims.push(identity); }, retire: () => undefined });
    const args = [operation === "napi_define_class" ? 4103n : values.add(target), 2n,
      values.add("first"), 4104n, 0n, 0n, 0n, 7n,
      values.add("second"), secondCallback, 0n, 0n, 0n, 7n];
    let error: unknown;
    try { values.dispatch(operation, args, operation === "napi_define_class" ? name : empty); } catch (caught) { error = caught; }
    expect(error).toHaveProperty("code", "PROTOCOL_ERROR");
    expect(Object.keys(target)).toEqual([]); expect(claims).toEqual([]);
    values.dispose();
  }
});

it.each(operations)("preserves Node's ordered %s semantic failures after valid transport", operation => {
  const values = new NativeValues(() => undefined, () => undefined), target = {}, value = values.add(17);
  const result = values.dispatch(operation, [operation === "napi_define_class" ? 4103n : values.add(target), 2n,
    values.add("first"), 0n, 0n, 0n, value, 7n,
    value, 0n, 0n, 0n, value, 7n], operation === "napi_define_class" ? name : empty);
  expect(result.status).toBe(4);
  expect(Object.keys(target)).toEqual(operation === "napi_define_properties" ? ["first"] : []);
  if (operation === "napi_define_properties") expect(Reflect.get(target, "first")).toBe(17);
  expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([0n]);
  values.dispose();
});
