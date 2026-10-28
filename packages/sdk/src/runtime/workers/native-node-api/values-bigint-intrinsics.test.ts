import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const empty = new Uint8Array();
const dependencies = [
  ["BigInt.toString", BigInt.prototype, "toString"],
  ["String.padStart", String.prototype, "padStart"],
  ["String.slice", String.prototype, "slice"],
  ["Array.join", Array.prototype, "join"],
  ["Math.ceil", Math, "ceil"],
  ["Math.min", Math, "min"],
  ["Math.max", Math, "max"],
] as const;

for (const operation of ["napi_get_value_bigint_words", "napi_create_bigint_words"] as const) {
  it.each(dependencies)("preserves " + operation + " when application code replaces %s", (_name, target, key) => {
    const values = new NativeValues(() => undefined, () => undefined);
    const magnitude = (1n << 127n) + 17n, handle = values.add(magnitude);
    const words = new Uint8Array(16), view = new DataView(words.buffer);
    view.setBigUint64(0, 17n, true); view.setBigUint64(8, 1n << 63n, true);
    const define = Object.defineProperty, previous = Object.getOwnPropertyDescriptor(target, key);
    if (previous === undefined) throw new Error("Missing intrinsic descriptor");
    let effects = 0, result: ReturnType<NativeValues["dispatch"]>;
    try {
      define(target, key, { configurable: true, get() { effects++; throw new Error("Application intrinsic getter"); } });
      result = values.dispatch(operation, operation === "napi_get_value_bigint_words" ? [handle, 2n] : [0n], operation === "napi_get_value_bigint_words" ? empty : words);
    } finally { define(target, key, previous); }
    expect(effects).toBe(0);
    expect(result.status).toBe(0);
    if (operation === "napi_get_value_bigint_words") {
      expect(result.args).toEqual([0n, 2n]); expect(result.bytes).toEqual(words);
    } else {
      const created = result.args[0]; if (created === undefined) throw new Error("Missing native BigInt");
      expect(values.get(created)).toBe(magnitude);
    }
  });
}


