import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

for (const runtime of ["node", "bun"] as const) for (const poison of ["shadow", "getter", "throwing-getter"] as const) {
  it(`returns the ${runtime} realm global without reading ${poison}`, () => {
    const root = globalThis, define = Object.defineProperty, descriptor = Object.getOwnPropertyDescriptor(root, "globalThis");
    if (descriptor === undefined) throw new Error("Missing global descriptor");
    const values = new NativeValues(() => undefined, () => undefined, () => undefined, 0, () => undefined,
      { claim: () => undefined, retire: () => undefined, runtime });
    const marker = new Error("global identity marker"), shadow = {}; let traps = 0;
    for (const pending of [false, true]) {
      if (pending) expect(values.dispatch("napi_throw", [values.add(marker)], new Uint8Array()).status).toBe(0);
      define(root, "globalThis", poison === "shadow" ? { configurable: true, value: shadow }
        : { configurable: true, get() { traps++; if (poison === "throwing-getter") throw marker; return shadow; } });
      let result: ReturnType<NativeValues["dispatch"]>;
      try { result = values.dispatch("napi_get_global", [], new Uint8Array()); }
      finally { define(root, "globalThis", descriptor); }
      expect(result.status).toBe(0); const handle = result.args[0];
      if (handle === undefined) throw new Error("Missing global handle");
      expect(values.get(handle)).toBe(root); expect(traps).toBe(0);
      let thrown: unknown;
      try { values.throwPending(); } catch (error) { thrown = error; }
      expect(thrown).toBe(pending ? marker : undefined);
    }
    values.dispose();
  });
}
