import { expect, it } from "vitest";
import { installProxyRegistry, nativeIsProxy } from "./proxy-brand.js";

it("records every proxy the realm's Proxy makes and keeps the constructor's own shape (ADR 0026, 2.11)", () => {
  const native = Proxy, nativeRevocable = Proxy.revocable, descriptor = Object.getOwnPropertyDescriptor(globalThis, "Proxy");
  const restore = installProxyRegistry(globalThis);
  try {
    const target = {}, made = new Proxy(target, {}), { proxy } = Proxy.revocable({}, {});
    const constructed: unknown = Reflect.construct(Proxy, [{}, {}], function NewTarget() { /* only a new.target */ });
    expect([nativeIsProxy(made), nativeIsProxy(proxy), nativeIsProxy(constructed)]).toEqual([true, true, true]);
    expect([nativeIsProxy(target), nativeIsProxy(Proxy), nativeIsProxy(Proxy.revocable), nativeIsProxy(null), nativeIsProxy(1)]).toEqual([false, false, false, false, false]);
    expect([Proxy.name, Proxy.length, Reflect.get(Proxy, "prototype"), Proxy.revocable.name, Proxy.revocable.length]).toEqual(["Proxy", 2, undefined, "revocable", 2]);
    expect(Object.getPrototypeOf(Proxy)).toBe(Function.prototype);
    expect(Reflect.ownKeys(Proxy)).toEqual(Reflect.ownKeys(native));
    const call: unknown = Proxy;
    expect(() => { if (typeof call === "function") Reflect.apply(call, undefined, [{}, {}]); }).toThrow(TypeError);
    expect(Object.getOwnPropertyDescriptor(globalThis, "Proxy")).toEqual({ ...descriptor, value: Proxy });
    // An application's own revocable stays its own.
    const replacement = () => ({ proxy: {}, revoke: () => undefined });
    expect(Reflect.set(Proxy, "revocable", replacement)).toBe(true);
    expect(Reflect.get(Proxy, "revocable")).toBe(replacement);
  } finally { restore(); }
  expect(Proxy).toBe(native);
  expect(Proxy.revocable).toBe(nativeRevocable);
});

it("refuses to answer for a realm whose proxies it never saw", () => {
  expect(() => nativeIsProxy({})).toThrow(/Proxy registry/u);
});
