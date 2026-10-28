import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

for (const runtime of ["node", "bun"] as const) for (const poison of ["replacement", "getter"] as const) {
  for (const [operation, method] of [["napi_call_function", "apply"], ["napi_new_instance", "construct"]] as const) {
    it(`${runtime} ${operation} ignores application Reflect.${method} ${poison}`, () => {
      const define = Object.defineProperty, original = Object.getOwnPropertyDescriptor(Reflect, method);
      if (original === undefined) throw new Error("Missing call intrinsic");
      const values = new NativeValues(() => undefined, () => undefined, () => undefined, 0, () => undefined,
        { claim: () => undefined, retire: () => undefined, runtime });
      const receiver = {}, marker = new Error("application call intrinsic"); let calls = 0, traps = 0;
      function Target(this: unknown, value: unknown) { const target: unknown = new.target; calls++; return target === undefined ? value : receiver; }
      const fn = values.add(Target), value = values.add(marker), args = operation === "napi_call_function" ? [values.add(receiver), fn, value] : [fn, value];
      const replacement = () => { traps++; throw marker; };
      define(Reflect, method, poison === "replacement" ? { configurable: true, value: replacement }
        : { configurable: true, get() { traps++; return replacement; } });
      let result: ReturnType<NativeValues["dispatch"]>;
      try { result = values.dispatch(operation, args, new Uint8Array()); }
      finally { define(Reflect, method, original); }
      expect(result.status).toBe(0); expect(traps).toBe(0); expect(calls).toBe(1);
      const output = result.args[0]; if (output === undefined) throw new Error("Missing call result");
      expect(values.get(output)).toBe(operation === "napi_call_function" ? marker : receiver);
      values.dispose();
    });
  }
}
