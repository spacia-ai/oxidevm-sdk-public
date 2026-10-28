import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const operations = [
  ["napi_create_function", "defineProperty"], ["napi_define_properties", "defineProperty"],
  ["napi_define_class", "defineProperty"], ["napi_object_freeze", "freeze"],
  ["napi_object_seal", "seal"], ["napi_create_external", "create"],
] as const;
for (const runtime of ["node", "bun"] as const) for (const poison of ["replacement", "getter"] as const) for (const [operation, method] of operations) {
  it(`${runtime} ${operation} ignores application Object.${method} ${poison}`, () => {
    const define = Object.defineProperty, original = Object.getOwnPropertyDescriptor(Object, method);
    if (original === undefined) throw new Error("Missing object intrinsic descriptor");
    const claims: bigint[] = [], retired: bigint[] = [];
    const values = new NativeValues(() => "child-value", () => undefined, () => undefined, 0, () => undefined,
      { claim(identity) { claims.push(identity); }, retire(identity) { retired.push(identity); }, runtime });
    const marker = new Error("object intrinsic"), target = { field: 17 }, targetId = values.add(target), valueId = values.add(29), nameId = values.add("field");
    const descriptor = [nameId, 0n, 0n, 0n, valueId, 7n], empty = new Uint8Array(), name = new TextEncoder().encode("Thing");
    const args = operation === "napi_create_function" ? [4103n] : operation === "napi_define_class" ? [4103n, 1n, ...descriptor]
      : operation === "napi_define_properties" ? [targetId, 1n, ...descriptor] : operation === "napi_create_external" ? [73n, 0n] : [targetId];
    let traps = 0;
    for (const pending of runtime === "node" ? [true, false] : [false]) {
      if (pending) expect(values.dispatch("napi_throw", [values.add(marker)], empty).status).toBe(0);
      const replacement = () => { traps++; throw marker; };
      define(Object, method, poison === "replacement" ? { configurable: true, value: replacement }
        : { configurable: true, get() { traps++; return replacement; } });
      let result: ReturnType<NativeValues["dispatch"]>;
      try { result = values.dispatch(operation, args, operation === "napi_create_function" || operation === "napi_define_class" ? name : empty); }
      finally { define(Object, method, original); }
      expect(result.status).toBe(pending ? 10 : 0); expect(traps).toBe(0);
      if (pending) { expect(claims).toEqual([]); expect(target.field).toBe(17); }
      else if (operation === "napi_define_properties") expect(target.field).toBe(29);
      else if (operation === "napi_object_freeze") expect(Object.isFrozen(target)).toBe(true);
      else if (operation === "napi_object_seal") { expect(Object.isSealed(target)).toBe(true); expect(Object.isFrozen(target)).toBe(false); }
      else {
        const handle = result.args[0]; if (handle === undefined) throw new Error("Missing native value");
        const value = values.get(handle);
        if (operation === "napi_create_external") { expect(values.dispatch("napi_get_value_external", [handle], empty).args).toEqual([73n]); if (typeof value !== "object" || value === null) throw new Error("Missing native external"); expect(Reflect.getPrototypeOf(value)).toBe(null); }
        else { if (typeof value !== "function") throw new Error("Missing native function"); expect(value.name).toBe("Thing"); expect(value.length).toBe(0);
          if (operation === "napi_create_function") expect(Reflect.apply(value, undefined, [])).toBe("child-value");
          else { const prototype: unknown = Reflect.get(value, "prototype"); if (typeof prototype !== "object" || prototype === null) throw new Error("Missing native prototype"); expect(Reflect.get(prototype, "field")).toBe(29); }
        }
      }
      let thrown: unknown; try { values.throwPending(); } catch (error) { thrown = error; }
      expect(thrown).toBe(pending ? marker : undefined);
    }
    values.dispose(); expect(retired).toEqual(claims);
  });
}
