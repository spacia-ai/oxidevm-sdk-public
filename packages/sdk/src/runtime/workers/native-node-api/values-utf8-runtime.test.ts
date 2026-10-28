import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const empty = new Uint8Array();
const cases = [
  { name: "empty", value: "", bytes: [], nodeLength: 0, bunLength: 0 },
  { name: "ASCII", value: "A", bytes: [65], nodeLength: 1, bunLength: 1 },
  { name: "Latin1", value: "é", bytes: [195, 169], nodeLength: 2, bunLength: 2 },
  { name: "BMP", value: "\u0800", bytes: [224, 160, 128], nodeLength: 3, bunLength: 3 },
  { name: "pair", value: "\ud83d\udca9", bytes: [240, 159, 146, 169], nodeLength: 4, bunLength: 4 },
  { name: "high", value: "\ud800", bytes: [239, 191, 189], nodeLength: 3, bunLength: 2 },
  { name: "low", value: "\udc00", bytes: [239, 191, 189], nodeLength: 3, bunLength: 2 },
  { name: "two-high", value: "\ud800\ud800", bytes: [239, 191, 189, 239, 191, 189], nodeLength: 6, bunLength: 4 },
  { name: "embedded-NUL", value: "A\0B", bytes: [65, 0, 66], nodeLength: 3, bunLength: 3 },
] as const;
for (const runtime of ["node", "bun"] as const) for (const query of [false, true]) for (const pending of [false, true]) for (const sample of cases) {
  it(`${runtime} ${sample.name} query=${query} pending=${pending} preserves the pinned UTF8 result`, () => {
    const values = new NativeValues(() => undefined, () => undefined, undefined, undefined, undefined, { runtime, claim: () => undefined, retire: () => undefined });
    const input = values.add(sample.value), marker = {}, exception = values.add(marker);
    if (pending) expect(values.dispatch("napi_throw", [exception], empty).status).toBe(0);
    const result = values.dispatch("napi_get_value_string_utf8", [input, query ? 1n : 0n], empty);
    expect(result).toEqual({ status: 0, args: query ? [BigInt(runtime === "bun" ? sample.bunLength : sample.nodeLength)] : [], bytes: query || (runtime === "bun" && sample.name === "high") ? empty : new Uint8Array(sample.bytes) });
    expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([pending ? 1n : 0n]);
    const cleared = values.dispatch("napi_get_and_clear_last_exception", [], empty).args[0];
    if (cleared === undefined) throw new Error("Missing cleared exception");
    expect(values.get(cleared)).toBe(pending ? marker : undefined);
  });
}
for (const runtime of ["node", "bun"] as const) it(`${runtime} rejects malformed UTF8 query metadata and observes no application Proxy traps`, () => {
  const values = new NativeValues(() => undefined, () => undefined, undefined, undefined, undefined, { runtime, claim: () => undefined, retire: () => undefined });
  const input = values.add("A");
  expect(() => values.dispatch("napi_get_value_string_utf8", [input], empty)).toThrow(/shape/u);
  expect(() => values.dispatch("napi_get_value_string_utf8", [input, 2n], empty)).toThrow(/query/u);
  let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; throw new Error("Application getter"); }, getPrototypeOf() { traps++; throw new Error("Application prototype"); } });
  const invalid = values.add(proxy);
  for (const query of [0n, 1n]) expect(values.dispatch("napi_get_value_string_utf8", [invalid, query], empty)).toEqual({ status: 3, args: [], bytes: empty });
  expect(traps).toBe(0);
});

for (const runtime of ["node", "bun"] as const) it(`${runtime} UTF8 queries ignore an application BigInt getter`, () => {
  const values = new NativeValues(() => undefined, () => undefined, undefined, undefined, undefined, { runtime, claim: () => undefined, retire: () => undefined });
  const input = values.add("\ud800"), define = Object.defineProperty, original = Object.getOwnPropertyDescriptor(globalThis, "BigInt");
  if (original === undefined) throw new Error("Missing BigInt descriptor");
  let effects = 0, result: unknown, failure: unknown;
  try {
    define(globalThis, "BigInt", { configurable: true, get() { effects++; throw new Error("Application BigInt getter"); } });
    try { result = values.dispatch("napi_get_value_string_utf8", [input, 1n], empty); } catch (error) { failure = error; }
  } finally { define(globalThis, "BigInt", original); }
  expect(effects).toBe(0); expect(failure).toBeUndefined();
  expect(result).toEqual({ status: 0, args: [runtime === "bun" ? 2n : 3n], bytes: empty });
});
