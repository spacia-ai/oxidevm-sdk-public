import { deprecate, format, inspect } from "node:util";
import { expect, it } from "vitest";
import { NativeAsyncContexts } from "./async-contexts.js";
import { createAsyncContext } from "../assistance/async-context.js";
import { createNodeAsyncHooks } from "../assistance/node-async-hooks.js";

const mapIterator = Reflect.getPrototypeOf(new Map().keys()), setIterator = Reflect.getPrototypeOf(new Set().values());
if (mapIterator === null || setIterator === null) throw new Error("Missing collection iterator");
const iterator = Reflect.getPrototypeOf(mapIterator);
if (iterator === null) throw new Error("Missing iterator prototype");
const choices: readonly (readonly [string, object, PropertyKey])[] = [
  ["push", Array.prototype, "push"], ["pop", Array.prototype, "pop"], ["at", Array.prototype, "at"], ["findIndex", Array.prototype, "findIndex"],
  ["map-size", Map.prototype, "size"], ["map-get", Map.prototype, "get"], ["map-set", Map.prototype, "set"], ["map-delete", Map.prototype, "delete"],
  ["map-values", Map.prototype, "values"], ["map-clear", Map.prototype, "clear"], ["map-keys", Map.prototype, "keys"],
  ["Map", globalThis, "Map"], ["Set", globalThis, "Set"], ["BigInt", globalThis, "BigInt"], ["WeakRef", globalThis, "WeakRef"], ["FinalizationRegistry", globalThis, "FinalizationRegistry"],
  ["map-next", mapIterator, "next"], ["set-next", setIterator, "next"], ["iterator-self", iterator, Symbol.iterator],
  ["set-add", Set.prototype, "add"], ["set-delete", Set.prototype, "delete"], ["set-has", Set.prototype, "has"], ["set-iterator", Set.prototype, Symbol.iterator],
  ["weak-deref", WeakRef.prototype, "deref"], ["registry-register", FinalizationRegistry.prototype, "register"], ["registry-unregister", FinalizationRegistry.prototype, "unregister"],
  ["Number", globalThis, "Number"], ["isSafeInteger", Number, "isSafeInteger"],
];

function poisoned<T>(owner: object, key: PropertyKey, throwing: boolean, action: () => T) {
  const define = Object.defineProperty, original = Object.getOwnPropertyDescriptor(owner, key), apply = Reflect.apply;
  if (original === undefined) throw new Error("Missing async owner intrinsic");
  const previous: unknown = original.value, getter: unknown = Reflect.get(original, "get");
  let effects = 0, result: T | undefined, failure: unknown;
  try {
    define(owner, key, { configurable: true, get(this: unknown): unknown { effects++; if (throwing) throw new Error("Application async owner getter"); return typeof getter === "function" ? apply(getter, this, []) : previous; } });
    try { result = action(); } catch (error) { failure = error; }
  } finally { define(owner, key, original); }
  return { result, failure, effects };
}

for (const throwing of [false, true]) for (const [name, target, key] of choices) it("async context ownership ignores " + name + " getters throwing=" + String(throwing), async () => {
  let native: NativeAsyncContexts | undefined, context: ReturnType<typeof createAsyncContext> | undefined, initialized = 0, destroyed = 0;
  const observed = poisoned(target, key, throwing, () => {
    const current = createAsyncContext(), hooks = createNodeAsyncHooks(current, { deprecate, format, inspect }), contexts = new NativeAsyncContexts(37n << 32n, current), environment = 37n << 32n | 1n, other = environment + 1n;
    context = current; native = contexts;
    const store = new current.AsyncLocalStorage<string>(), resource = {}, receiver = {};
    hooks.createHook({ init() { initialized++; }, destroy() { destroyed++; } }).enable();
    const identity = store.run("created", () => contexts.create(environment, resource, "owned"));
    let made: string | undefined, cleared = false, restored = false, wrongOrder = false, wrongEnvironment = false, stale = false;
    store.run("caller", () => {
      made = contexts.make(environment, identity, receiver, () => store.getStore());
      const outer = contexts.open(environment, identity, 17n), inner = contexts.open(environment, identity, 17n);
      cleared = store.getStore() === undefined;
      try { contexts.close(environment, outer, 17n); } catch (error) { wrongOrder = typeof error === "object" && error !== null && "status" in error && error.status === 14; }
      contexts.close(environment, inner, 17n); contexts.close(environment, outer, 17n);
      contexts.retireTransport(17n); restored = store.getStore() === "caller";
    });
    try { contexts.make(other, identity, receiver, () => undefined); } catch (error) { wrongEnvironment = typeof error === "object" && error !== null && "status" in error && error.status === 1; }
    contexts.destroy(environment, identity);
    try { contexts.destroy(environment, identity); } catch (error) { stale = typeof error === "object" && error !== null && "status" in error && error.status === 1; }
    const remaining = contexts.create(environment, {}, "remaining");
    if (remaining === identity) throw new Error("Native context identity was reused");
    contexts.dispose();
    const standalone = current.resources.create("standalone", {}); standalone.destroy(); standalone.destroy();
    store.disable();
    return { made, cleared, restored, wrongOrder, wrongEnvironment, stale };
  });
  native?.dispose(); await Promise.resolve(); context?.resources.dispose();
  expect(observed.failure).toBeUndefined(); expect(observed.effects).toBe(0);
  expect(observed.result).toEqual({ made: "created", cleared: true, restored: true, wrongOrder: true, wrongEnvironment: true, stale: true });
  expect(initialized).toBe(3); expect(destroyed).toBe(3);
});
