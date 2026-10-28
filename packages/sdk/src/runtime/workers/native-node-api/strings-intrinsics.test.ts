import { expect, it } from "vitest";
import { decodeNativeString, encodeNativeString } from "./strings.js";
import { encodeNativeFrame, decodeNativeFrame, type NativeFrame } from "./codec.js";
import { NativeValues } from "./values.js";

const Encoder = TextEncoder, Decoder = TextDecoder;
const payload = new Uint8Array([239, 187, 191, 65, 195, 169]);
for (const runtime of ["node", "bun"] as const) for (const poison of ["encoder-constructor", "decoder-constructor", "encode", "decode"] as const) for (const throwing of [false, true]) {
  it(runtime + " native strings and frames ignore " + poison + " getters throwing=" + String(throwing), () => {
    const define = Object.defineProperty, owner = poison === "encode" ? Encoder.prototype : poison === "decode" ? Decoder.prototype : globalThis;
    const key = poison === "encoder-constructor" ? "TextEncoder" : poison === "decoder-constructor" ? "TextDecoder" : poison;
    const original = Object.getOwnPropertyDescriptor(owner, key);
    if (original === undefined) throw new Error("Missing encoding intrinsic descriptor");
    const previousValue: unknown = original.value;
    const values = new NativeValues(() => undefined, () => undefined, undefined, undefined, undefined, { runtime, claim: () => undefined, retire: () => undefined });
    const object = values.add({}), input = values.add(42), frame: NativeFrame = { kind: 3, sequence: 1, scope: 1n, environment: 0n, operation: "napi_create_string_utf8", status: 0, args: [], bytes: payload };
    const sentinel = new Error("Application encoding getter"); let effects = 0, failure: unknown, result: unknown;
    try {
      define(owner, key, { configurable: true, get(): unknown { effects++; if (throwing) throw sentinel; return previousValue; } });
      try {
        result = {
          encoded: encodeNativeString("\ufeffAé", "utf8"), decoded: decodeNativeString(payload, "utf8"),
          frame: decodeNativeFrame(encodeNativeFrame(frame).subarray(4)),
          created: values.dispatch("napi_create_string_utf8", [], payload),
          named: values.dispatch("napi_set_named_property", [object, input], payload),
        };
      } catch (error) { failure = error; }
    } finally { define(owner, key, original); }
    expect(effects).toBe(0); expect(failure).toBeUndefined();
    expect(result).toEqual({
      encoded: payload, decoded: "\ufeffAé", frame,
      created: { status: 0, args: [3n], bytes: new Uint8Array() },
      named: { status: 0, args: [0n], bytes: new Uint8Array() },
    });
    expect(values.get(object)).toEqual({ "\ufeffAé": 42 });
    expect(values.get(3n)).toBe("\ufeffAé");
  });
}

it("native frame metadata rejects malformed UTF8 before accepting the next valid frame", () => {
  const frame: NativeFrame = { kind: 3, sequence: 1, scope: 1n, environment: 0n, operation: "a", status: 0, args: [], bytes: new Uint8Array() };
  const bytes = encodeNativeFrame(frame).slice(4); bytes[36] = 255;
  expect(() => decodeNativeFrame(bytes)).toThrow();
  expect(decodeNativeFrame(encodeNativeFrame(frame).subarray(4))).toEqual(frame);
});
