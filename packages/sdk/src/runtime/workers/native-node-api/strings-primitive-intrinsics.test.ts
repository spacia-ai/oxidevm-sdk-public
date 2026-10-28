import { expect, it } from "vitest";
import { decodeNativeString } from "./strings.js";
import { encodeNativeFrame, decodeNativeFrame, type NativeFrame } from "./codec.js";
import { NativeValues } from "./values.js";

for (const key of ["min", "max", "isSafeInteger", "getUint32", "setUint32", "getBigUint64", "setBigUint64", "push"] as const) for (const throwing of [false, true]) {
  it("native values and frames ignore " + key + " getters throwing=" + String(throwing), () => {
    const owner = key === "min" || key === "max" ? Math : key === "isSafeInteger" ? Number : key === "push" ? Array.prototype : DataView.prototype;
    const define = Object.defineProperty, original = Object.getOwnPropertyDescriptor(owner, key);
    if (original === undefined) throw new Error("Missing native primitive");
    const previous: unknown = original.value, payload = new Uint8Array([255, 254, 65, 0]);
    const values = new NativeValues(() => undefined, () => undefined);
    const frame: NativeFrame = { kind: 3, sequence: 1, scope: 1n, environment: 0n, operation: "napi_create_string_utf16", status: 0, args: [], bytes: payload };
    let effects = 0, failure: unknown, output: unknown;
    try {
      define(owner, key, { configurable: true, get(): unknown { effects++; if (throwing) throw new Error("Application native primitive"); return previous; } });
      try {
        output = {
          value: decodeNativeString(payload, "utf16"),
          frame: decodeNativeFrame(encodeNativeFrame(frame).subarray(4)),
          created: values.dispatch("napi_create_string_utf16", [], payload),
        };
      } catch (error) { failure = error; }
    } finally { define(owner, key, original); }
    expect(effects).toBe(0); expect(failure).toBeUndefined();
    expect(output).toEqual({ value: "\ufeffA", frame, created: { status: 0, args: [1n], bytes: new Uint8Array() } });
    expect(values.get(1n)).toBe("\ufeffA");
  });
}
