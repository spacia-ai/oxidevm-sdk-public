import { expect, it } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { installPromiseContext } from "./promise-context.js";
import { NativeValues } from "../native-node-api/values.js";

const OriginalPromise = Promise, empty = new Uint8Array();

it("reads a custom newTarget prototype once", async () => {
  const context = createAsyncContext(), restore = installPromiseContext(context, globalThis);
  try {
    let reads = 0;
    const target = new Proxy(function Target() {}, { get(object, key, receiver): unknown {
      if (key === "prototype") reads++;
      return Reflect.get(object, key, receiver);
    } });
    const promise: unknown = Reflect.construct(Promise, [(resolve: (value: number) => void) => { resolve(7); }], target);
    const then: unknown = Reflect.get(OriginalPromise.prototype, "then");
    if (typeof then !== "function") throw new Error("Missing Promise reaction");
    const result: unknown = await Reflect.apply(then, promise, [(value: unknown) => value]);
    expect(result).toBe(7);
    expect(reads).toBe(1);
  } finally { restore(); context.resources.dispose(); }
});

it("preserves native constructor descriptors while installing Promise context", () => {
  const context = createAsyncContext(), prototype = Reflect.getPrototypeOf(OriginalPromise);
  const keys = Reflect.ownKeys(OriginalPromise), restore = installPromiseContext(context, globalThis);
  try {
    expect(Reflect.getPrototypeOf(Promise)).toBe(prototype);
    expect(Reflect.ownKeys(Promise)).toEqual(keys);
    expect(Promise.name).toBe("Promise");
    expect(Promise.length).toBe(1);
    expect(Promise.prototype.constructor).toBe(Promise);
    expect(Object.getOwnPropertyDescriptor(Promise, "prototype")).toEqual(Object.getOwnPropertyDescriptor(OriginalPromise, "prototype"));
  } finally { restore(); context.resources.dispose(); }
});

it("preserves pinned Node self-resolution formatting without constructor or tag getters", async () => {
  const context = createAsyncContext(), values = new NativeValues(() => undefined, () => undefined);
  const originalName = Object.getOwnPropertyDescriptor(OriginalPromise, "name");
  const restore = installPromiseContext(context, globalThis);
  try {
    values.bindAsyncContext(context);
    for (const [kind, expected] of [
      ["ordinary", "#<Promise>"], ["null-prototype", "[object Object]"],
      ["plain-prototype", "#<Forged>"], ["constructor-getter", "[object Promise]"],
      ["tag-value", "#<Promise>"], ["tag-getter", "#<Promise>"],
      ["name-value", "#<Promise>"], ["proxy-prototype", "[object Object]"],
      ["own-constructor", "#<Promise>"], ["renamed-constructor", "#<Promise>"],
    ] as const) {
      const created = values.dispatch("napi_create_promise", [], empty), [deferred, handle] = created.args;
      expect(created.status).toBe(0);
      if (deferred === undefined || handle === undefined) throw new Error("Missing deferred");
      const promise = values.get(handle);
      if (typeof promise !== "object" || promise === null) throw new Error("Missing Promise object");
      const then: unknown = Reflect.get(OriginalPromise.prototype, "then");
      if (typeof then !== "function") throw new Error("Missing Promise reaction");
      const observed: unknown = Reflect.apply(then, promise, [() => "unexpected", (error: unknown) => error]);
      let getters = 0;
      if (kind === "null-prototype") Object.setPrototypeOf(promise, null);
      if (kind === "plain-prototype") Object.setPrototypeOf(promise, { constructor: function Forged() {}, [Symbol.toStringTag]: "Changed" });
      if (kind === "constructor-getter") Object.defineProperty(promise, "constructor", { get() { getters++; throw new Error("constructor"); } });
      if (kind === "tag-value") Object.defineProperty(promise, Symbol.toStringTag, { value: "ForgedPromise" });
      if (kind === "tag-getter") Object.defineProperty(promise, Symbol.toStringTag, { get() { getters++; throw new Error("tag"); } });
      if (kind === "name-value") Object.defineProperty(promise, "name", { value: "Forged" });
      if (kind === "proxy-prototype") Object.setPrototypeOf(promise, new Proxy({}, { get() { getters++; throw new Error("get"); }, getPrototypeOf() { getters++; throw new Error("prototype"); } }));
      const nameDescriptor = Object.getOwnPropertyDescriptor(Promise, "name");
      if (kind === "own-constructor" || kind === "renamed-constructor") Object.defineProperty(promise, "constructor", { value: Promise });
      if (kind === "renamed-constructor") Object.defineProperty(Promise, "name", { configurable: true, value: "Forged" });
      expect(values.dispatch("napi_resolve_deferred", [deferred, handle], empty).status).toBe(0);
      const error: unknown = await observed;
      expect(error).toBeInstanceOf(TypeError);
      if (!(error instanceof TypeError)) throw new Error("Missing cycle error");
      expect(error.message, kind).toBe("Chaining cycle detected for promise " + expected);
      expect(getters).toBe(0);
      if (kind === "renamed-constructor" && nameDescriptor !== undefined) Object.defineProperty(Promise, "name", nameDescriptor);
    }
  } finally {
    if (originalName !== undefined) Object.defineProperty(OriginalPromise, "name", originalName);
    restore(); values.dispose(); context.resources.dispose();
  }
});
