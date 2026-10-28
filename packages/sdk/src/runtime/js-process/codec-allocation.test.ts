import { expect, it } from "vitest";
import { Reader, Writer, copyBytes, descriptor, value, viewBytes, writeBytes } from "./codec.js";

for (const key of ["Number", "BigInt", "DataView", "Uint8Array", "set", "subarray", "slice"] as const) for (const throwing of [false, true]) it("binary allocation ignores " + key + " getters throwing=" + String(throwing), () => {
  const prototype = Reflect.getPrototypeOf(Uint8Array.prototype);
  if (prototype === null) throw new Error("Missing byte prototype");
  const owner = key === "set" || key === "subarray" || key === "slice" ? prototype : globalThis;
  const original = Object.getOwnPropertyDescriptor(owner, key), define = Object.defineProperty;
  if (original === undefined) throw new Error("Missing allocation intrinsic");
  const previous: unknown = original.value, payload = Uint8Array.of(0x34, 0x12), empty = new Uint8Array();
  let effects = 0, failure: unknown, output: unknown;
  try {
    define(owner, key, { configurable: true, get(): unknown { effects++; if (throwing) throw new Error("Application allocation getter"); return previous; } });
    try {
      const bytes = new Writer().raw(payload).u32(0x89ab_cdef).u64(0x0123_4567_89ab_cdefn).finish(), reader = new Reader(bytes);
      output = [reader.u16(), reader.u32(), reader.u64(), descriptor(3), value({ value: 7n, bytes: empty })];
      reader.end();
    } catch (error) { failure = error; }
  } finally { define(owner, key, original); }
  expect(effects).toBe(0); expect(failure).toBeUndefined();
  expect(output).toEqual([0x1234, 0x89ab_cdef, 0x0123_4567_89ab_cdefn, 3, 7]);
});

it("transport views retain shared offsets while copies own ordinary backing", () => {
  const memory = new SharedArrayBuffer(8), bytes = new Uint8Array(memory, 2, 4);
  writeBytes(bytes, [1, 2, 3, 4]);
  const view = viewBytes(bytes, 1, 3), copy = copyBytes(bytes, 1, 3);
  expect(view.buffer).toBe(memory); expect(view.byteOffset).toBe(3);
  expect([...view]).toEqual([2, 3]); expect([...copy]).toEqual([2, 3]);
  expect(copy.buffer).toBeInstanceOf(ArrayBuffer);
  view[0] = 9; expect(bytes[1]).toBe(9); expect(copy[0]).toBe(2);
  expect(() => writeBytes(bytes, [1, 2, 3, 4], 1)).toThrow(RangeError);
});
