import { expect, it } from "vitest";
import { Reader, Writer, descriptor } from "./codec.js";

for (const key of ["getUint16", "getUint32", "getBigUint64", "setUint32", "setBigUint64", "push", "isSafeInteger"] as const) for (const throwing of [false, true]) {
  it("binary fields ignore " + key + " getters throwing=" + String(throwing), () => {
    const owner = key === "push" ? Array.prototype : key === "isSafeInteger" ? Number : DataView.prototype;
    const define = Object.defineProperty, original = Object.getOwnPropertyDescriptor(owner, key);
    if (original === undefined) throw new Error("Missing binary intrinsic");
    const previous: unknown = original.value;
    let effects = 0, failure: unknown, output: unknown;
    try {
      define(owner, key, { configurable: true, get(): unknown { effects++; if (throwing) throw new Error("Application binary getter"); return previous; } });
      try {
        const bytes = new Writer().raw(new Uint8Array([0x34, 0x12])).u32(0x89ab_cdef).u64(0x0123_4567_89ab_cdefn).finish(), reader = new Reader(bytes);
        output = [reader.u16(), reader.u32(), reader.u64(), descriptor(3)];
        reader.end();
      } catch (error) { failure = error; }
    } finally { define(owner, key, original); }
    expect(effects).toBe(0); expect(failure).toBeUndefined();
    expect(output).toEqual([0x1234, 0x89ab_cdef, 0x0123_4567_89ab_cdefn, 3]);
  });
}

it("binary fields retain bounds and validate a later independent record", () => {
  for (const value of [NaN, Infinity, -1, 1.5, 0x1_0000_0000]) expect(() => new Writer().u32(value)).toThrow();
  for (const value of [-1n, 0x1_0000_0000_0000_0000n]) expect(() => new Writer().u64(value)).toThrow();
  expect(() => new Reader(new Uint8Array(1)).u16()).toThrow(/Truncated/u);
  expect(() => new Reader(new Uint8Array(3)).u32()).toThrow(/Truncated/u);
  expect(() => new Reader(new Uint8Array(7)).u64()).toThrow(/Truncated/u);
  expect(new Reader(new Writer().u32(7).finish()).u32()).toBe(7);
});
