import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const viewPrototype = Reflect.getPrototypeOf(new DataView(new ArrayBuffer(0)));
if (viewPrototype === null) throw new Error("Missing DataView prototype");
const choices = [
  ["bigint-asIntN", BigInt, "asIntN"], ["bigint-asUintN", BigInt, "asUintN"],
  ["view-getFloat64", viewPrototype, "getFloat64"], ["view-setFloat64", viewPrototype, "setFloat64"],
  ["view-getBigUint64", viewPrototype, "getBigUint64"], ["view-setBigUint64", viewPrototype, "setBigUint64"],
] as const;
const empty = new Uint8Array(), words = new Uint8Array([17, 0, 0, 0, 0, 0, 0, 0]);
for (const runtime of ["node", "bun"] as const) for (const version of [8, 9, 10]) for (const [name, owner, key] of choices) for (const throwing of [false, true]) {
  it(runtime + " version " + String(version) + " numeric values ignore " + name + " getters throwing=" + String(throwing), () => {
    const values = new NativeValues(() => undefined, () => undefined, undefined, undefined, undefined, { runtime, claim: () => undefined, retire: () => undefined });
    const input = values.add(3.9), original = Object.getOwnPropertyDescriptor(owner, key), define = Object.defineProperty;
    if (original === undefined) throw new Error("Missing numeric intrinsic");
    const previous: unknown = original.value;
    let traps = 0, result: unknown, failure: unknown;
    values.registerEnvironment(1n, version);
    try {
      define(owner, key, { configurable: true, get(): unknown { traps++; if (throwing) throw new Error("Application numeric getter"); return previous; } });
      try {
        result = values.withEnvironment(1n, () => {
          const calls = [
            values.dispatch("napi_create_int32", [0xffff_ffffn], empty),
            values.dispatch("napi_create_int64", [0xffff_ffff_ffff_ffffn], empty),
            values.dispatch("napi_create_bigint_int64", [0xffff_ffff_ffff_ffffn], empty),
            values.dispatch("napi_create_double", [0x8000_0000_0000_0000n], empty),
            values.dispatch("napi_create_date", [0x4045_70a3_d70a_3d71n], empty),
            values.dispatch("napi_create_bigint_words", [0n], words),
          ];
          const outputs = calls.map(call => { const handle = call.args[0]; return handle === undefined ? undefined : values.get(handle); });
          const read = values.dispatch("napi_get_value_double", [input], empty);
          const wide = calls[5]?.args[0]; if (wide === undefined) throw new Error("Missing word-created BigInt");
          const decoded = values.dispatch("napi_get_value_bigint_words", [wide, 1n], empty);
          return { statuses: calls.map(call => call.status), outputs, doubleStatus: read.status, bits: read.args, wordStatus: decoded.status, wordArgs: decoded.args, wordBytes: decoded.bytes };
        });
      } catch (error) { failure = error; }
    } finally { define(owner, key, original); values.dispose(); }
    expect(traps).toBe(0); expect(failure).toBeUndefined();
    expect(result).toEqual({ statuses: [0, 0, 0, 0, 0, 0], outputs: [-1, -1, -1n, -0, new Date(42), 17n], doubleStatus: 0, bits: [0x400f_3333_3333_3333n], wordStatus: 0, wordArgs: [0n, 1n], wordBytes: words });
  });
}
