import { types } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

const original = Object.getOwnPropertyDescriptor(Promise, "isPromise"), empty = new Uint8Array();
afterEach(() => { if (original === undefined) Reflect.deleteProperty(Promise, "isPromise"); else Object.defineProperty(Promise, "isPromise", original); vi.resetModules(); });
async function owner(available = true) {
  Object.defineProperty(Promise, "isPromise", { configurable: true, value: available ? types.isPromise : undefined });
  vi.resetModules();
  const { NativeValues } = await import("./values.js");
  return new NativeValues(() => undefined, () => undefined);
}
it("queries arbitrary values without losing a pending object, null or undefined exception", async () => {
  const values = await owner();
  for (const exception of [{}, null, undefined]) for (const [input, expected] of [[Promise.resolve(), 1n], [{ then() { throw new Error("Then ran"); } }, 0n]] as const) {
    const handle = values.add(input), thrown = values.add(exception);
    expect(values.dispatch("napi_throw", [thrown], empty).status).toBe(0);
    expect(values.dispatch("napi_is_promise", [handle], empty)).toEqual({ status: 0, args: [expected], bytes: empty });
    expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([1n]);
    const cleared = values.dispatch("napi_get_and_clear_last_exception", [], empty).args[0];
    if (cleared === undefined) throw new Error("Missing exception handle");
    expect(values.get(cleared)).toBe(exception);
  }
  values.dispose();
});
it("rejects wrong shape, stale handles and foreign generations before calling the predicate", async () => {
  const values = await owner(), handle = values.add(Promise.resolve());
  for (const args of [[], [handle, handle], [0n], [1n << 32n]]) expect(() => values.dispatch("napi_is_promise", args, empty)).toThrow();
  expect(() => values.dispatch("napi_is_promise", [handle], Uint8Array.of(1))).toThrow();
  values.createScope(1n); const stale = values.withScope(1n, () => values.add(Promise.resolve())); values.retireScope(1n);
  expect(() => values.dispatch("napi_is_promise", [stale], empty)).toThrow();
  values.dispose(); expect(() => values.dispatch("napi_is_promise", [handle], empty)).toThrow();
});
it("answers with its own brand check when the primitive is missing, without an application exception", async () => {
  const values = await owner(false);
  for (const [input, expected] of [[Promise.resolve(), 1n], [{ then() { throw new Error("Then ran"); } }, 0n], [Object.create(Promise.prototype), 0n]] as const) {
    expect(values.dispatch("napi_is_promise", [values.add(input)], empty)).toMatchObject({ status: 0, args: [expected] });
  }
  expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([0n]);
  values.dispose();
});
it("does not fabricate a Boolean or application exception when neither the primitive nor a brand check exists", async () => {
  const has = Object.getOwnPropertyDescriptor(Map.prototype, "has");
  if (has === undefined) throw new Error("Missing Map.prototype.has");
  // An engine whose Map.prototype.has accepts any receiver gives the brand check nothing to compare with.
  Object.defineProperty(Promise, "isPromise", { configurable: true, value: undefined }); vi.resetModules();
  Object.defineProperty(Map.prototype, "has", { ...has, value: () => false });
  // Only the brand module captures the changed method; the value owner loads afterwards and shares that module.
  try { await import("../../promise-brand.js"); } finally { Object.defineProperty(Map.prototype, "has", has); }
  const { NativeValues } = await import("./values.js"), values = new NativeValues(() => undefined, () => undefined);
  expect(() => values.dispatch("napi_is_promise", [values.add({})], empty)).toThrow("Native Promise predicate is unavailable");
  expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([0n]);
  values.dispose();
});
