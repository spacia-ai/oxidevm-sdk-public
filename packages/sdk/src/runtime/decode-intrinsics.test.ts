import { expect, it } from "vitest";
import { integer } from "./decode.js";

for (const throwing of [false, true]) it("integer validation ignores application safe-integer getters throwing=" + String(throwing), () => {
  const define = Object.defineProperty, original = Object.getOwnPropertyDescriptor(Number, "isSafeInteger");
  if (original === undefined) throw new Error("Missing safe integer intrinsic");
  const previous: unknown = original.value;
  let effects = 0, failure: unknown, output: unknown, rejected = 0;
  try {
    define(Number, "isSafeInteger", { configurable: true, get(): unknown { effects++; if (throwing) throw new Error("Application integer getter"); return previous; } });
    try {
      output = integer(3, "field", 0, 4);
      for (const invalid of [NaN, Infinity, -Infinity, 1.5, -1, 5, "3", null]) {
        try { integer(invalid, "field", 0, 4); } catch { rejected++; }
      }
    } catch (error) { failure = error; }
  } finally { define(Number, "isSafeInteger", original); }
  expect(effects).toBe(0); expect(failure).toBeUndefined(); expect(output).toBe(3); expect(rejected).toBe(8);
});
