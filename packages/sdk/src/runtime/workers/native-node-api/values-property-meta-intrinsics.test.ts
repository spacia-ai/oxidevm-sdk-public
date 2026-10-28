import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

for (const runtime of ["node", "bun"] as const) for (const operation of ["napi_get_prototype", "napi_has_own_property"] as const) for (const poison of ["replacement", "getter"] as const) {
  it(`${runtime} ${operation} ignores an intrinsic ${poison} and preserves pending exceptions`, () => {
    const values = new NativeValues(() => undefined, () => undefined, () => undefined, 0, () => undefined,
      { claim: () => undefined, retire: () => undefined, runtime });
    const target = { "7": 17 }, prototype = Reflect.getPrototypeOf(target), targetId = values.add(target), keyId = values.add("7");
    const owner = operation === "napi_get_prototype" ? Reflect : Object, method = operation === "napi_get_prototype" ? "getPrototypeOf" : "hasOwn";
    const define = Object.defineProperty, original = Object.getOwnPropertyDescriptor(owner, method);
    if (original === undefined) throw new Error("Missing intrinsic descriptor");
    const args = operation === "napi_get_prototype" ? [targetId] : [targetId, keyId], marker = new Error("application intrinsic"); let traps = 0;
    for (const pending of [false, true]) {
      if (pending) expect(values.dispatch("napi_throw", [values.add(marker)], new Uint8Array()).status).toBe(0);
      const replacement = () => { traps++; throw marker; };
      define(owner, method, poison === "replacement" ? { configurable: true, value: replacement }
        : { configurable: true, get() { traps++; return replacement; } });
      let result: ReturnType<NativeValues["dispatch"]>;
      try { result = values.dispatch(operation, args, new Uint8Array()); }
      finally { define(owner, method, original); }
      expect(result.status).toBe(pending ? 10 : 0); expect(traps).toBe(0);
      if (!pending) { const output = result.args[0]; if (output === undefined) throw new Error("Missing result");
        if (operation === "napi_get_prototype") expect(values.get(output)).toBe(prototype); else expect(output).toBe(1n); }
      let thrown: unknown; try { values.throwPending(); } catch (error) { thrown = error; }
      expect(thrown).toBe(pending ? marker : undefined);
    }
    values.dispose();
  });
}
