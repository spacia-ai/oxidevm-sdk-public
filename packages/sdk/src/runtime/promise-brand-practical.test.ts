import { createHook } from "node:async_hooks";
import { types } from "node:util";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { nativeIsPromise, nativePromiseCapability, practicalPromiseCapability } from "./promise-brand.js";

/*
 * The practical check of engine ADR 0026, against Node's own util.types.isPromise. The same cases run in Chromium,
 * Firefox and WebKit, page and worker, through the engine's docs/research/promise-detection-poc-2026-10-19.
 */
const noop = (): undefined => undefined, resolved = (): Promise<number> => Promise.resolve(1);
type Fixture = readonly [name: string, make: (effects: string[]) => unknown, allowed?: readonly string[]];
const observed = (effects: string[], value: object): object => new Proxy(value, {
  get: (target, key, receiver): unknown => { effects.push(`get:${String(key)}`); return Reflect.get(target, key, receiver); },
  getPrototypeOf: target => { effects.push("getPrototypeOf"); return Reflect.getPrototypeOf(target); },
  ownKeys: target => { effects.push("ownKeys"); return Reflect.ownKeys(target); },
  getOwnPropertyDescriptor: (target, key) => { effects.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
});
const fixtures: readonly Fixture[] = [
  ["undefined", () => undefined], ["null", () => null], ["number", () => 42], ["bigint", () => 1n], ["string", () => "p"], ["symbol", () => Symbol("p")],
  ["function", () => noop], ["plain object", () => ({})], ["map", () => new Map()], ["weak map", () => new WeakMap()], ["error", () => new TypeError("x")],
  ["pending", () => new Promise(noop)], ["fulfilled", resolved],
  ["rejected and handled", () => { const value = Promise.reject(new Error("fixture")); value.catch(noop); return value; }],
  ["async function result", () => (async () => { await Promise.resolve(); return 1; })()],
  ["subclass", () => new (class extends Promise<unknown> {})(resolve => { resolve(1); })],
  ["frozen", () => Object.freeze(resolved())],
  ["null-prototype promise", () => Object.setPrototypeOf(resolved(), null) as unknown],
  ["foreign-realm promise", () => runInNewContext("Promise.resolve(1)") as unknown],
  ["foreign-realm subclass", () => runInNewContext("new (class extends Promise {})(resolve => resolve(1))") as unknown],
  ["foreign-realm fake", () => runInNewContext("Object.create(Promise.prototype)") as unknown],
  ["fake prototype", () => Object.create(Promise.prototype) as unknown],
  ["fake tag", () => ({ [Symbol.toStringTag]: "Promise" })],
  ["thenable", () => ({ then: noop })],
  ["then getter", effects => Object.defineProperty({}, "then", { get: () => { effects.push("get:then"); return noop; } })],
  ["tag getter", effects => Object.defineProperty({}, Symbol.toStringTag, { get: () => { effects.push("get:tag"); return "Promise"; } })],
  ["object whose constructor getter throws", effects => Object.defineProperty({}, "constructor", { get: () => { effects.push("get:constructor"); throw new TypeError("fixture"); } })],
  ["object with a primitive constructor", () => ({ constructor: 5 })],
  ["constructor getter", effects => Object.defineProperty(resolved(), "constructor", { get: () => { effects.push("get:constructor"); return Promise; } }), ["get:constructor"]],
  ["throwing constructor", effects => Object.defineProperty(resolved(), "constructor", { get: () => { effects.push("get:constructor"); throw new TypeError("fixture"); } }), ["get:constructor"]],
  ["primitive constructor", () => Object.defineProperty(resolved(), "constructor", { value: 5 })],
  ["species getter", effects => Object.defineProperty(resolved(), "constructor", { value: { get [Symbol.species](): unknown { effects.push("get:species"); return Promise; } } }), ["get:species"]],
  ["species that is no constructor", () => Object.defineProperty(resolved(), "constructor", { value: { [Symbol.species]: noop } })],
  ["promise with its own then getter", effects => Object.defineProperty(resolved(), "then", { get: () => { effects.push("get:then"); return noop; } })],
  ["promise with its own tag getter", effects => Object.defineProperty(resolved(), Symbol.toStringTag, { get: () => { effects.push("get:tag"); return "Promise"; } })],
  ["proxy of an object", effects => observed(effects, {})], ["proxy of a promise", effects => observed(effects, resolved())],
  ["revoked proxy", () => { const value = Proxy.revocable(resolved(), {}); value.revoke(); return value.proxy; }],
];

it("this engine has no exact primitive, so the practical check answers", () => {
  expect(nativePromiseCapability).toBe(0); expect(practicalPromiseCapability).toBe(1);
});

for (const [name, make, allowed = []] of fixtures) it(`answers as Node does for: ${name}`, () => {
  const effects: string[] = [], value = make(effects); effects.length = 0;
  expect(nativeIsPromise(value)).toBe(types.isPromise(value));
  // Only a promise's own constructor or species accessor runs, once.
  expect(effects).toEqual(allowed);
});

it("attaches nothing to an ordinary promise, so its rejection is reported as before", () => {
  let created = 0;
  const hook = createHook({ init(_id, type) { if (type === "PROMISE") created++; } });
  const subclass = new (class extends Promise<unknown> {})(resolve => { resolve(1); }), plain = resolved(), pending = new Promise(noop);
  hook.enable();
  try { for (const value of [plain, pending, subclass, Object.freeze(resolved())]) expect(nativeIsPromise(value)).toBe(true); }
  finally { hook.disable(); }
  // Object.freeze(resolved()) made the one promise; no check derived another.
  expect(created).toBe(1);
});

it("leaves the intrinsics as it found them, also when the receiver's accessor throws", () => {
  const constructor = Object.getOwnPropertyDescriptor(Promise.prototype, "constructor"), species = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  nativeIsPromise(resolved()); nativeIsPromise({});
  nativeIsPromise(Object.defineProperty(resolved(), "constructor", { get: (): never => { throw new Error("fixture"); } }));
  expect(Object.getOwnPropertyDescriptor(Promise.prototype, "constructor")).toEqual(constructor);
  expect(Object.getOwnPropertyDescriptor(Promise, Symbol.species)).toEqual(species);
  expect(new Promise(noop).constructor).toBe(Promise);
});

it("uses only intrinsics captured before application code", () => {
  const saved = [Object.getOwnPropertyDescriptor(Promise.prototype, "then"), Object.getOwnPropertyDescriptor(Map.prototype, "has"), Object.getOwnPropertyDescriptor(Reflect, "apply"), Object.getOwnPropertyDescriptor(Reflect, "defineProperty")] as const;
  const [then, has, apply, define] = saved;
  if (then === undefined || has === undefined || apply === undefined || define === undefined) throw new Error("Missing intrinsic");
  const promise = resolved(), map = new Map(), promisePrototype: object = Promise.prototype;
  const set = (target: object, key: string, value: PropertyDescriptor): void => { Object.defineProperty(target, key, value); };
  const tampered = (): boolean[] => {
    set(promisePrototype, "then", { ...then, value: (): never => { throw new Error("Application then"); } });
    set(Map.prototype, "has", { ...has, value: () => true });
    set(Reflect, "apply", { ...apply, value: () => false });
    set(Reflect, "defineProperty", { ...define, value: () => false });
    try { return [nativeIsPromise(promise), nativeIsPromise({}), nativeIsPromise(map), nativeIsPromise(Object.create(promisePrototype))]; }
    finally { set(Reflect, "defineProperty", define); set(Reflect, "apply", apply); set(Map.prototype, "has", has); set(promisePrototype, "then", then); }
  };
  expect(tampered()).toEqual([true, false, false, false]);
});
