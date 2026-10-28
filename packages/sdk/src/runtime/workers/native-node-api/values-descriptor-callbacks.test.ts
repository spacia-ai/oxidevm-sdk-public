import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const empty = new Uint8Array(), operations = [0, 1, 2] as const;
type Kind = "method" | "getter" | "setter" | "both";
const kinds: readonly Kind[] = ["method", "getter", "setter", "both"];

function fixture(operation: 0 | 1 | 2, kind: Kind, key: string | symbol) {
  const values = new NativeValues((callback, _receiver, target, args) => callback === 4103n ? undefined : { target, args }, () => undefined), target = {};
  const result = values.dispatch(operation === 0 ? "napi_define_properties" : "napi_define_class",
    [operation === 0 ? values.add(target) : 4103n, 1n, values.add(key), kind === "method" ? 4104n : 0n,
      kind === "getter" || kind === "both" ? 4105n : 0n, kind === "setter" || kind === "both" ? 4106n : 0n, 0n, operation === 2 ? 1031n : 7n],
    operation === 0 ? empty : new TextEncoder().encode("Target"));
  expect(result.status).toBe(0);
  let object: unknown = target, receiver: unknown = target;
  if (operation !== 0) {
    const handle = result.args[0]; if (handle === undefined) throw new Error("Missing class handle");
    const constructor = values.get(handle); if (typeof constructor !== "function") throw new Error("Missing class constructor");
    object = operation === 1 ? Reflect.get(constructor, "prototype") : constructor;
    receiver = operation === 1 ? Reflect.construct(constructor, []) : constructor;
  }
  if ((typeof object !== "object" || object === null) && typeof object !== "function") throw new Error("Missing descriptor target");
  const descriptor = Object.getOwnPropertyDescriptor(object, key); if (descriptor === undefined) throw new Error("Missing descriptor");
  return { values, descriptor, receiver };
}

it.each(operations)("preserves Node descriptor callback names and lengths for operation %s", operation => {
  for (const key of ["field", Symbol("field"), Symbol(), Symbol.iterator]) for (const kind of kinds) {
    const { values, descriptor } = fixture(operation, kind, key);
    for (const field of ["value", "get", "set"] as const) {
      const fn: unknown = Reflect.get(descriptor, field); if (fn === undefined) continue;
      if (typeof fn !== "function") throw new Error("Missing descriptor callback");
      const name = field === "value" && operation === 1 && typeof key === "string" ? key : "";
      expect(Object.getOwnPropertyDescriptor(fn, "name")).toEqual({ value: name, writable: false, enumerable: false, configurable: true });
      expect(fn.length).toBe(0);
    }
    values.dispose();
  }
});

it.each(operations)("preserves descriptor callback arguments and newTarget for operation %s", operation => {
  for (const kind of kinds) {
    const { values, descriptor, receiver } = fixture(operation, kind, "field");
    for (const field of ["value", "get", "set"] as const) {
      const fn: unknown = Reflect.get(descriptor, field); if (fn === undefined) continue;
      if (typeof fn !== "function") throw new Error("Missing descriptor callback");
      for (const args of [[], [1], [1, 2]]) {
        const result: unknown = Reflect.apply(fn, receiver, args);
        expect(result).toEqual({ target: undefined, args });
      }
      const result: unknown = Reflect.construct(fn, [1, 2]);
      expect(result).toEqual({ target: fn, args: [1, 2] });
    }
    values.dispose();
  }
});
