import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { NativeValues } from "./values.js";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it.each(["node", "bun"] as const)("uses exact Error brands for %s without invoking application code", runtime => {
  const values = new NativeValues(() => undefined, () => undefined, () => undefined, 0, () => undefined, { runtime, claim: () => undefined, retire: () => undefined });
  const empty = new Uint8Array(), observed = vi.fn((): never => { throw new Error("Input observed"); });
  const revoked = Proxy.revocable(new Error("revoked"), { get: observed, getPrototypeOf: observed }); revoked.revoke();
  const cases: readonly (readonly [unknown, boolean])[] = [
    [new Error("ordinary"), true], [Object.setPrototypeOf(new Error("null"), null), true],
    [Object.setPrototypeOf(new Error("changed"), {}), true], [runInNewContext("new Error('foreign')"), true],
    [Object.create(Error.prototype), false], [new Proxy(new Error("proxy"), { get: observed, getPrototypeOf: observed }), false],
    [revoked.proxy, false], [new Proxy({}, { get: observed, getPrototypeOf: observed }), false],
    [Object.defineProperty(new Error("getter"), "name", { get: observed }), true],
    [new DOMException("DOM"), runtime === "node"], [Object.setPrototypeOf(new DOMException("null DOM"), null), runtime === "node"],
    [Object.create(DOMException.prototype), false], [undefined, false], [null, false], [Symbol("error"), false],
  ];
  for (const [input, expected] of cases) {
    expect(values.dispatch("napi_is_error", [values.add(input)], empty)).toEqual({ status: 0, args: [expected ? 1n : 0n], bytes: empty });
  }
  expect(observed).not.toHaveBeenCalled();
  expect(() => values.dispatch("napi_is_error", [0xffffn], empty)).toThrow(/handle/u);
  values.createScope(1n); const stale = values.withScope(1n, () => values.add(new Error("stale"))); values.retireScope(1n);
  expect(() => values.dispatch("napi_is_error", [stale], empty)).toThrow(/stale/u);
  for (const exception of [undefined, null, Symbol("exception"), revoked.proxy]) {
    expect(values.dispatch("napi_throw", [values.add(exception)], empty).status).toBe(0);
    expect(values.dispatch("napi_is_error", [values.add(new Error("pending"))], empty).args).toEqual([1n]);
    expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([1n]);
    const cleared = values.dispatch("napi_get_and_clear_last_exception", [], empty).args[0];
    if (cleared === undefined) throw new Error("Missing exception handle");
    expect(values.get(cleared)).toBe(exception);
  }
  const original = new Error("captured"), replacement = Object.defineProperty(function FakeError() { return undefined; }, "isError", { get: observed });
  vi.stubGlobal("Error", replacement);
  expect(values.dispatch("napi_is_error", [values.add(original)], empty).args).toEqual([1n]);
  expect(observed).not.toHaveBeenCalled(); values.dispose();
});

it("keeps an unavailable Error capability separate from a pending application exception", async () => {
  const original = Object.getOwnPropertyDescriptor(Error, "isError");
  Object.defineProperty(Error, "isError", { configurable: true, value: undefined });
  vi.resetModules();
  try {
    const { NativeValues: CapturedValues } = await import("./values.js");
    const values = new CapturedValues(() => undefined, () => undefined), empty = new Uint8Array(), marker = Symbol("pending");
    expect(values.dispatch("napi_throw", [values.add(marker)], empty).status).toBe(0);
    expect(() => values.dispatch("napi_is_error", [values.add({})], empty)).toThrow("Native Error predicate is unavailable");
    expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([1n]);
    const handle = values.dispatch("napi_get_and_clear_last_exception", [], empty).args[0];
    if (handle === undefined) throw new Error("Missing exception");
    expect(values.get(handle)).toBe(marker); values.dispose();
  } finally {
    if (original === undefined) Reflect.deleteProperty(Error, "isError"); else Object.defineProperty(Error, "isError", original);
  }
});
