import { expect, it } from "vitest";
import { NativeCallbacks } from "./callbacks.js";
import { NativeBuffers } from "./buffers.js";

const registryPrototype = Reflect.getPrototypeOf(new FinalizationRegistry<bigint>(() => undefined)), weakPrototype = Reflect.getPrototypeOf(new WeakRef({}));
if (registryPrototype === null || weakPrototype === null) throw new Error("Missing finalization prototype");
function observe(owner: object, key: string, throwing: boolean, action: () => unknown): unknown {
  const original = Object.getOwnPropertyDescriptor(owner, key), define = Object.defineProperty;
  if (original === undefined) throw new Error("Missing finalization intrinsic");
  const previous: unknown = original.value;
  let effects = 0, result: unknown, failure: unknown;
  try {
    define(owner, key, { configurable: true, get(): unknown { effects++; if (throwing) throw new Error("Application finalization getter"); return previous; } });
    try { result = action(); } catch (error) { failure = error; }
  } finally { define(owner, key, original); }
  expect(effects).toBe(0); expect(failure).toBeUndefined(); return result;
}

for (const key of ["register", "unregister"]) for (const throwing of [false, true]) {
  it("callbacks preserve ordered retirement under " + key + " getters throwing=" + String(throwing), () => {
    const events: string[] = [], callbacks = new NativeCallbacks(0n, {
      claim: identity => { events.push("claim:" + String(identity)); },
      retire: identity => { events.push("retire:" + String(identity)); },
      finalize: identity => { expect(callbacks.active(4096n)).toBe(true); events.push("finalize:" + String(identity)); },
    });
    try {
      const result = observe(registryPrototype, key, throwing, () => {
        callbacks.add({}, 4096n, "function", 0n); callbacks.add({}, 4097n, "finalizer", 0n); callbacks.add({}, 4098n, "finalizer", 0n);
        callbacks.cancel(4098n); callbacks.finalize(); const live = callbacks.live;
        callbacks.dispose(); callbacks.dispose(); return { live, remaining: callbacks.live };
      });
      expect(result).toEqual({ live: 1, remaining: 0 });
      expect(events).toEqual(["claim:4096", "claim:4097", "claim:4098", "retire:4098", "finalize:4097", "retire:4096"]);
    } finally { callbacks.dispose(); }
  });

  it("buffers preserve backing updates and retirement under " + key + " getters throwing=" + String(throwing), () => {
    const retired: number[] = [], buffers = new NativeBuffers(identity => { retired.push(identity); });
    try {
      const result = observe(registryPrototype, key, throwing, () => {
        const created = buffers.create(3, new Uint8Array([1, 2, 3])), alias = new Uint8Array(created.value.buffer, created.value.byteOffset + 1, 1);
        const identity = buffers.inspect(alias).identity; buffers.update(identity, new Uint8Array([4, 5, 6]));
        const value = alias[0]; buffers.dispose(); buffers.dispose(); return { identity, value };
      });
      expect(result).toEqual({ identity: 1, value: 5 }); expect(retired).toEqual([1]);
    } finally { buffers.dispose(); }
  });
}

for (const throwing of [false, true]) it("buffer updates ignore deref getters throwing=" + String(throwing), () => {
  const retired: number[] = [], buffers = new NativeBuffers(identity => { retired.push(identity); });
  try {
    const created = buffers.create(3, new Uint8Array([1, 2, 3]));
    const result = observe(weakPrototype, "deref", throwing, () => {
      buffers.update(created.identity, new Uint8Array([4, 5, 6])); const value = created.value[1]; buffers.dispose(); buffers.dispose(); return value;
    });
    expect(result).toBe(5); expect(retired).toEqual([1]);
  } finally { buffers.dispose(); }
});

for (const owner of ["callbacks", "buffers"]) for (const constructor of ["FinalizationRegistry", "WeakRef"]) for (const throwing of [false, true]) {
  it(owner + " ignore application " + constructor + " constructor getters throwing=" + String(throwing), () => {
    const events: bigint[] = [], retired: number[] = [];
    const result = observe(globalThis, constructor, throwing, () => {
      if (owner === "callbacks") {
        const callbacks = new NativeCallbacks(0n, { claim: () => undefined, retire: identity => { events.push(identity); }, finalize: identity => { events.push(identity); } });
        callbacks.add({}, 4096n, "function", 0n); callbacks.add({}, 4097n, "finalizer", 0n); callbacks.dispose(); callbacks.dispose(); return callbacks.live;
      }
      const buffers = new NativeBuffers(identity => { retired.push(identity); });
      const created = buffers.create(2, new Uint8Array([1, 2])); buffers.update(created.identity, new Uint8Array([3, 4])); const value = created.value[1]; buffers.dispose(); buffers.dispose(); return value;
    });
    if (owner === "callbacks") { expect(result).toBe(0); expect(events).toEqual([4097n, 4096n]); }
    else { expect(result).toBe(4); expect(retired).toEqual([1]); }
  });
}
