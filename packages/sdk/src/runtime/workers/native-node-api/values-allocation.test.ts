import { expect, it } from "vitest";
import { NativeValues } from "./values.js";
import { nativeStatus } from "./errors.js";

for (const key of ["Number", "BigInt", "Uint8Array"] as const) for (const throwing of [false, true]) it("native identities and strings ignore " + key + " getters throwing=" + String(throwing), () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, key), define = Object.defineProperty;
  if (original === undefined) throw new Error("Missing value allocation intrinsic");
  const previous: unknown = original.value, payload = Uint8Array.of(65, 0, 66, 0), empty = new Uint8Array();
  const values = new NativeValues(() => undefined, () => undefined);
  let effects = 0, failure: unknown, output: unknown;
  try {
    define(globalThis, key, { configurable: true, get(): unknown { effects++; if (throwing) throw new Error("Application value allocator"); return previous; } });
    try {
      output = [nativeStatus(0), values.dispatch("napi_create_string_utf16", [], payload)];
      const handle = values.add("AB");
      output = [output, values.dispatch("napi_get_value_string_utf16", [handle], empty)];
    } catch (error) { failure = error; }
  } finally { define(globalThis, key, original); }
  expect(effects).toBe(0); expect(failure).toBeUndefined();
  expect(output).toEqual([[0, { status: 0, args: [1n], bytes: empty }], { status: 0, args: [], bytes: payload }]);
  expect(values.get(1n)).toBe("AB");
});
