import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const empty = new Uint8Array();

it.each(["napi_call_function", "napi_new_instance"] as const)("accepts %s arguments up to the existing frame bound", operation => {
  const values = new NativeValues(() => undefined, () => undefined);
  const receiver = values.add(undefined), argument = values.add(17);
  let calls = 0;
  const target = values.add(function Target(...args: unknown[]) {
    calls++;
    return { count: args.length, valid: args.every(value => value === 17) };
  });
  const header = operation === "napi_call_function" ? [receiver, target] : [target];
  for (const count of [0, 1, 63, 64, 65, 255, 300, 1024, 4096 - header.length]) {
    const result = values.dispatch(operation, [...header, ...Array<bigint>(count).fill(argument)], empty);
    expect(result.status).toBe(0);
    const handle = result.args[0]; if (handle === undefined) throw new Error("Missing result");
    expect(values.get(handle)).toEqual({ count, valid: true });
  }
  expect(calls).toBe(9);
  expect(() => values.dispatch(operation, [...header, ...Array<bigint>(4097 - header.length).fill(argument)], empty)).toThrow(/argument/u);
  expect(() => values.dispatch(operation, [...header, ...Array<bigint>(65).fill(argument), 0n], empty)).toThrow(/handle/u);
  expect(calls).toBe(9);
  values.dispose();
});

it.each(["napi_get_element", "napi_has_element", "napi_delete_element", "napi_set_element"] as const)("does not read application String for %s", operation => {
  for (const index of [0, 7, 0xffff_fffe, 0xffff_ffff]) {
    const values = new NativeValues(() => undefined, () => undefined), marker = new Error("application String getter");
    const property = `${index}`, target = { [property]: 17 }, handle = values.add(target), input = values.add(marker);
    const args = operation === "napi_set_element" ? [handle, BigInt(index), input] : [handle, BigInt(index)];
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "String");
    let getters = 0, status: number | undefined, result: readonly bigint[] | undefined;
    Object.defineProperty(globalThis, "String", { configurable: true, get() { getters++; throw marker; } });
    try {
      const reply = values.dispatch(operation, args, empty); status = reply.status; result = reply.args;
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "String");
      else Object.defineProperty(globalThis, "String", descriptor);
    }
    expect(status).toBe(0); expect(getters).toBe(0);
    if (operation === "napi_get_element") {
      const output = result[0]; if (output === undefined) throw new Error("Missing element");
      expect(values.get(output)).toBe(17);
    } else if (operation === "napi_set_element") expect(Reflect.get(target, property)).toBe(marker);
    else {
      expect(result).toEqual([1n]);
      expect(Object.hasOwn(target, property)).toBe(operation === "napi_has_element");
    }
    expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([0n]);
    values.dispose();
  }
});
