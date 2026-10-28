import { describe, expect, it } from "vitest";
import { nodeUtilTypes } from "./node-util-types.js";

describe("util.types", () => {
  it("classifies platform values the way Node does", () => {
    const t = nodeUtilTypes;
    expect(t.isUint8Array(new Uint8Array(1))).toBe(true);
    expect(t.isUint8Array(new Uint16Array(1))).toBe(false);
    expect(t.isTypedArray(new Float64Array(1))).toBe(true);
    expect(t.isArrayBufferView(new DataView(new ArrayBuffer(1)))).toBe(true);
    expect(t.isArrayBuffer(new ArrayBuffer(1))).toBe(true);
    expect(t.isArrayBuffer(new SharedArrayBuffer(1))).toBe(false);
    expect(t.isAnyArrayBuffer(new SharedArrayBuffer(1))).toBe(true);
    expect(t.isDate(new Date())).toBe(true);
    expect(t.isRegExp(/x/u)).toBe(true);
    expect(t.isPromise(Promise.resolve())).toBe(true);
    expect(t.isMap(new Map())).toBe(true);
    expect(t.isSet(new Set())).toBe(true);
    expect(t.isMapIterator(new Map().keys())).toBe(true);
    expect(t.isNativeError(new TypeError("x"))).toBe(true);
    expect(t.isNativeError({ message: "x" })).toBe(false);
    expect(t.isBoxedPrimitive(Object(1))).toBe(true);
    expect(t.isBoxedPrimitive(1)).toBe(false);
    const asynchronous = async (): Promise<void> => { await Promise.resolve(); };
    expect(t.isAsyncFunction(asynchronous)).toBe(true);
    expect(t.isGeneratorFunction(function* generator() { yield 1; })).toBe(true);
    expect(t.isPromise({ then() { /* thenable */ } })).toBe(false);
  });
});
