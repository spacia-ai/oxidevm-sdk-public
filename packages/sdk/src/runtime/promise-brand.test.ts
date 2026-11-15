import { types } from "node:util";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";

const original = Object.getOwnPropertyDescriptor(Promise, "isPromise");
afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(Promise, "isPromise");
  else Object.defineProperty(Promise, "isPromise", original);
  vi.resetModules();
});

it("rejects missing and accessor capabilities without running the accessor, and answers with its own brand check", async () => {
  for (const descriptor of [{ value: undefined }, { get: (): never => { throw new Error("Accessor ran"); } }]) {
    Object.defineProperty(Promise, "isPromise", { configurable: true, ...descriptor }); vi.resetModules();
    const brand = await import("./promise-brand.js");
    expect(brand.nativePromiseCapability).toBe(0); expect(brand.practicalPromiseCapability).toBe(1);
    expect(brand.nativeIsPromise({})).toBe(false); expect(brand.nativeIsPromise(Promise.resolve())).toBe(true);
  }
});

it("without the primitive and without a wording it can learn, the program is remembered for full Linux", async () => {
  const has = Object.getOwnPropertyDescriptor(Map.prototype, "has");
  if (has === undefined) throw new Error("Missing Map.prototype.has");
  // An engine whose Map.prototype.has accepts any receiver gives the check nothing to compare with.
  Object.defineProperty(Map.prototype, "has", { ...has, value: () => false }); vi.resetModules();
  try {
    const brand = await import("./promise-brand.js");
    expect(brand.nativePromiseCapability).toBe(0); expect(brand.practicalPromiseCapability).toBe(0);
    let thrown: unknown;
    try { brand.nativeIsPromise({}); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { api: "napi_is_promise", lateFailure: "unsupported-node-api", subject: "napi_is_promise" } });
  } finally { Object.defineProperty(Map.prototype, "has", has); }
});

it("captures a qualified predicate before application mutations and never observes the input", async () => {
  // Node's engine predicate is a labeled test oracle, not a browser polyfill.
  Object.defineProperty(Promise, "isPromise", { configurable: true, value: types.isPromise });
  const brand = await import("./promise-brand.js");
  expect(brand.nativePromiseCapability).toBe(1); expect(brand.practicalPromiseCapability).toBe(0);
  const replacement = vi.fn(() => false);
  Object.defineProperty(Promise, "isPromise", { configurable: true, value: replacement });
  const promise = Promise.resolve(), foreign: unknown = runInNewContext("Promise.resolve(1)");
  for (const input of [promise, foreign, (async () => { await Promise.resolve(); return 1; })(), new (class extends Promise<unknown> {})(resolve => { resolve(1); }), Object.setPrototypeOf(Promise.resolve(), null)]) expect(brand.nativeIsPromise(input)).toBe(true);
  const trap = (): never => { throw new Error("Input observed"); };
  const revoked = Proxy.revocable(promise, {}); revoked.revoke();
  for (const input of [undefined, null, false, 1, 1n, "p", Symbol(), {}, Object.create(Promise.prototype), { then: trap }, new Proxy(promise, { get: trap, getPrototypeOf: trap }), revoked.proxy, { get [Symbol.toStringTag](): never { return trap(); } }]) expect(brand.nativeIsPromise(input)).toBe(false);
  for (const key of ["then", "constructor", Symbol.toStringTag]) expect(brand.nativeIsPromise(Object.defineProperty(Promise.resolve(), key, { get: trap }))).toBe(true);
  expect(replacement).not.toHaveBeenCalled();
});

it("rejects invalid predicate results as protocol failures", async () => {
  Object.defineProperty(Promise, "isPromise", { configurable: true, value: () => 1 });
  const brand = await import("./promise-brand.js");
  expect(() => brand.nativeIsPromise({})).toThrow("Invalid native Promise predicate result");
});

it("keeps a failing host primitive out of application exception state", async () => {
  const failure = new Proxy(new Error("Host primitive failure"), { get(): never { throw new Error("Failure inspected"); }, getPrototypeOf(): never { throw new Error("Failure inspected"); } });
  Object.defineProperty(Promise, "isPromise", { configurable: true, value: (): never => { throw failure; } });
  const brand = await import("./promise-brand.js");
  expect(() => brand.nativeIsPromise({})).toThrow("Native Promise predicate failed");
});
