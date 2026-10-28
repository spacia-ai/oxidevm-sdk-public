import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";

const original = Object.getOwnPropertyDescriptor(Error, "isError");
const originalDOM = Object.getOwnPropertyDescriptor(DOMException.prototype, "name");
const nativeError: unknown = original === undefined ? undefined : Reflect.get(original, "value");
function nodeOracle(value: unknown): boolean {
  if (typeof nativeError !== "function") throw new Error("Missing test Error predicate");
  const result: unknown = Reflect.apply(nativeError, undefined, [value]);
  if (typeof result !== "boolean") throw new Error("Invalid test Error predicate");
  return result;
}
afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(Error, "isError"); else Object.defineProperty(Error, "isError", original);
  if (originalDOM === undefined) Reflect.deleteProperty(DOMException.prototype, "name"); else Object.defineProperty(DOMException.prototype, "name", originalDOM);
  vi.resetModules();
});

it("rejects missing and accessor Error capabilities without evaluating the accessor", async () => {
  for (const descriptor of [{ value: undefined }, { get: (): never => { throw new Error("Accessor ran"); } }]) {
    Object.defineProperty(Error, "isError", { configurable: true, ...descriptor }); vi.resetModules();
    const brand = await import("./error-brand.js");
    expect(brand.nativeErrorCapability).toBe(0);
    expect(() => brand.nativeIsError({}, "node")).toThrow("Native Error predicate is unavailable");
  }
});

it("captures the DOM brand getter for Node fallback and ignores subsequent mutations", async () => {
  const getName: unknown = originalDOM === undefined ? undefined : Reflect.get(originalDOM, "get");
  if (typeof getName !== "function") throw new Error("Missing test DOM getter");
  // Simulate JSC's native predicate with Node's labeled engine oracle, never as a browser polyfill.
  Object.defineProperty(Error, "isError", { configurable: true, value: (value: unknown): boolean => {
    try { Reflect.apply(getName, value, []); return false; } catch { return nodeOracle(value); }
  } });
  const brand = await import("./error-brand.js"); expect(brand.nativeErrorCapability).toBe(2);
  const observed = vi.fn((): never => { throw new Error("Input observed"); });
  Object.defineProperty(Error, "isError", { configurable: true, get: observed });
  Object.defineProperty(DOMException.prototype, "name", { configurable: true, get: observed });
  const foreign: unknown = runInNewContext("new DOMException('foreign')", { DOMException });
  const revoked = Proxy.revocable(new DOMException("revoked"), { get: observed, getPrototypeOf: observed }); revoked.revoke();
  for (const value of [new DOMException("ordinary"), foreign, Object.setPrototypeOf(new DOMException("null"), null),
    Object.defineProperty(new DOMException("getter"), "name", { get: observed })]) {
    expect(brand.nativeIsError(value, "node")).toBe(true); expect(brand.nativeIsError(value, "bun")).toBe(false);
  }
  for (const value of [Object.create(DOMException.prototype), new Proxy(new DOMException("proxy"), { get: observed, getPrototypeOf: observed }), revoked.proxy, {}, null]) {
    expect(brand.nativeIsError(value, "node")).toBe(false); expect(brand.nativeIsError(value, "bun")).toBe(false);
  }
  expect(brand.nativeIsError(new TypeError("ordinary"), "node")).toBe(true);
  expect(brand.nativeIsError(new TypeError("ordinary"), "bun")).toBe(true);
  expect(observed).not.toHaveBeenCalled();
});

it("excludes genuine DOM brands for pinned Bun when the host includes them", async () => {
  Object.defineProperty(Error, "isError", { configurable: true, value: nodeOracle });
  const brand = await import("./error-brand.js");
  const observed = vi.fn((): never => { throw new Error("Input observed"); });
  const value: unknown = Object.setPrototypeOf(Object.defineProperty(new DOMException("DOM"), "name", { get: observed }), null);
  expect(brand.nativeIsError(value, "node")).toBe(true); expect(brand.nativeIsError(value, "bun")).toBe(false);
  const error: unknown = Object.setPrototypeOf(new Error("ordinary"), DOMException.prototype);
  expect(brand.nativeIsError(error, "bun")).toBe(true); expect(observed).not.toHaveBeenCalled();
});

it("rejects a missing DOM brand primitive before exposing a capability", async () => {
  Object.defineProperty(DOMException.prototype, "name", { configurable: true, value: "forged" });
  const brand = await import("./error-brand.js");
  expect(brand.nativeErrorCapability).toBe(0); expect(() => brand.nativeIsError({}, "bun")).toThrow("Native Error predicate is unavailable");
});

it("rejects invalid captured primitives and malformed query results", async () => {
  for (const value of [(): number => 1, (): never => { throw new Error("Host failure"); }]) {
    Object.defineProperty(Error, "isError", { configurable: true, value }); vi.resetModules();
    const brand = await import("./error-brand.js");
    expect(brand.nativeErrorCapability).toBe(0); expect(() => brand.nativeIsError({}, "node")).toThrow("Invalid native Error capability");
  }
  Object.defineProperty(Error, "isError", { configurable: true, value: (value: unknown): unknown => value instanceof DOMException ? true : 1 }); vi.resetModules();
  const brand = await import("./error-brand.js");
  expect(brand.nativeErrorCapability).toBe(2); expect(() => brand.nativeIsError({}, "node")).toThrow("Invalid native Error predicate result");
});

it("does not inspect a primitive failure or change it into an application exception", async () => {
  const failure = new Proxy(new Error("host"), { get(): never { throw new Error("Failure inspected"); }, getPrototypeOf(): never { throw new Error("Failure inspected"); } });
  Object.defineProperty(Error, "isError", { configurable: true, value: (value: unknown): boolean => {
    if (value instanceof DOMException) return true; throw failure;
  } });
  const brand = await import("./error-brand.js");
  expect(() => brand.nativeIsError({}, "node")).toThrow("Native Error predicate failed");
});
