import { expect, it } from "vitest";
import { decodeDeferredTraceValidation } from "./jit-promotion-validation.js";

it("decodes exact ABI discard codes and rejects unknown boundary results", () => {
  expect(decodeDeferredTraceValidation(1)).toBeNull();
  expect([2, 3, 4, 5, 6, 7].map(decodeDeferredTraceValidation)).toEqual([
    "not-in-flight", "machine-unavailable", "translation-unavailable",
    "cpu-context-changed", "already-bound", "code-pages-changed",
  ]);
  for (const value of [0, 8, -1, 0xffff_ffff, Number.NaN]) {
    expect(() => decodeDeferredTraceValidation(value)).toThrow("validation boundary");
  }
});
