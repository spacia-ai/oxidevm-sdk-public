import { expect, it } from "vitest";
import { NativeHandles } from "./handles.js";
import { NativeReferences } from "./references.js";
import { NativeCallbacks } from "./callbacks.js";
import { nativeBigIntFromWords } from "./extended-values.js";
import { NativeBridge } from "./bridge.js";
import { NativeValues } from "./values.js";
import { createAsyncContext } from "../assistance/async-context.js";
import { encodeNativeFrame, type NativeFrame } from "./codec.js";

function poisoned<T>(key: "push" | "pop" | "at" | "map" | "slice" | "reverse" | "constructor" | "Number" | "BigInt" | "floor" | typeof Symbol.species, throwing: boolean, action: () => T, owner: object = Array.prototype) {
  const define = Object.defineProperty, original = Object.getOwnPropertyDescriptor(owner, key), apply = Reflect.apply;
  if (original === undefined) throw new Error("Missing array intrinsic");
  const previous: unknown = original.value, getter: unknown = Reflect.get(original, "get");
  let effects = 0, result: T | undefined, failure: unknown;
  try {
    define(owner, key, { configurable: true, get(): unknown { effects++; if (throwing) throw new Error("Application array getter"); const value: unknown = typeof getter === "function" ? apply(getter, owner, []) : previous; return value; } });
    try { result = action(); } catch (error) { failure = error; }
  } finally { define(owner, key, original); }
  return { result, failure, effects };
}

for (const throwing of [false, true]) {
  for (const key of ["push", "pop", "at"] as const) it("public scope lifetime ignores " + key + " getters throwing=" + String(throwing), () => {
    const handles = new NativeHandles(0n), target = {};
    const observed = poisoned(key, throwing, () => {
      const outer = handles.open(1n, false), inner = handles.open(1n, true), original = handles.add(target), escaped = handles.escape(inner, 1n, original);
      let twice: unknown; try { handles.escape(inner, 1n, original); } catch (error) { twice = error; }
      handles.close(inner, 1n, true);
      const alive = handles.get(escaped); let retiredOriginal = false;
      try { handles.get(original); } catch { retiredOriginal = true; }
      handles.close(outer, 1n, false); let retiredEscaped = false;
      try { handles.get(escaped); } catch { retiredEscaped = true; }
      return { alive, twice, retiredOriginal, retiredEscaped };
    });
    expect(observed.failure).toBeUndefined(); expect(observed.effects).toBe(0);
    expect(observed.result?.alive).toBe(target); expect(observed.result?.twice).toMatchObject({ status: 12 });
    expect(observed.result?.retiredOriginal).toBe(true); expect(observed.result?.retiredEscaped).toBe(true);
  });

  for (const [key, owner] of [["push", Array.prototype], ["pop", Array.prototype], ["Number", globalThis], ["BigInt", globalThis], ["floor", Math]] as const) it("reference reuse ignores " + key + " getters throwing=" + String(throwing), () => {
    const references = new NativeReferences(0n), target = {};
    const observed = poisoned(key, throwing, () => {
      const first = references.create({}, 1, true, 1n); references.delete(first, 1n);
      const second = references.create(target, 0, true, 1n), held = references.get(second, 1n);
      const count = references.ref(second, 1n); let stale: unknown;
      try { references.get(first, 1n); } catch (error) { stale = error; }
      references.delete(second, 1n); return { first, second, held, count, stale };
    }, owner);
    references.dispose();
    expect(observed.failure).toBeUndefined(); expect(observed.effects).toBe(0);
    expect(observed.result?.held?.value).toBe(target); expect(observed.result?.count).toBe(1);
    expect(observed.result?.second).toBe((observed.result?.first ?? 0n) + 4096n);
    expect(observed.result?.stale).toMatchObject({ status: 1 });
  });

  it("callback generations ignore floor getters throwing=" + String(throwing), () => {
    let claims = 0, retired = 0, finalized = 0;
    const callbacks = new NativeCallbacks(0n, { claim: () => { claims++; }, retire: () => { retired++; }, finalize: () => { finalized++; } });
    const observed = poisoned("floor", throwing, () => {
      callbacks.add({}, 4096n, "finalizer", 1n); const active = callbacks.active(4096n);
      callbacks.cancel(4096n); let stale: unknown;
      try { callbacks.validate(4096n); } catch (error) { stale = error; }
      return { active, live: callbacks.live, stale };
    }, Math);
    callbacks.dispose(); expect(observed.failure).toBeUndefined(); expect(observed.effects).toBe(0);
    expect(observed.result?.active).toBe(true); expect(observed.result?.live).toBe(0);
    expect(observed.result?.stale).toMatchObject({ message: "Stale native callback generation" });
    expect([claims, retired, finalized]).toEqual([1, 1, 0]);
  });

  it("BigInt word construction ignores push getters throwing=" + String(throwing), () => {
    const observed = poisoned("push", throwing, () => nativeBigIntFromWords(0, new Uint8Array([17, 0, 0, 0, 0, 0, 0, 0])));
    expect(observed).toEqual({ result: 17n, failure: undefined, effects: 0 });
  });

  for (const operation of ["napi_call_function", "napi_new_instance", "napi_make_callback"] as const) for (const [key, owner] of [["map", Array.prototype], ["slice", Array.prototype], ["reverse", Array.prototype], ["constructor", Array.prototype], [Symbol.species, Array]] as const) it(operation + " arguments ignore " + String(key) + " getters throwing=" + String(throwing), () => {
    const values = new NativeValues(() => undefined, () => undefined), marker = {}, receiver = values.add({});
    if (operation === "napi_make_callback") values.bindAsyncContext(createAsyncContext());
    let calls = 0;
    function Target(value: unknown) { calls++; return value; }
    const fn = values.add(Target), input = values.add(marker), args = operation === "napi_call_function" ? [receiver, fn, input] : operation === "napi_new_instance" ? [fn, input] : [0n, receiver, fn, input];
    const observed = poisoned(key, throwing, () => values.dispatch(operation, args, new Uint8Array()), owner);
    expect(observed.failure).toBeUndefined(); expect(observed.effects).toBe(0); expect(observed.result?.status).toBe(0);
    const handle = observed.result?.args[0]; if (handle === undefined) throw new Error("Missing callback result");
    expect(values.get(handle)).toBe(marker); expect(calls).toBe(1); values.dispose();
  });

  for (const [key, owner] of [["map", Array.prototype], ["constructor", Array.prototype], [Symbol.species, Array]] as const) it("native callback arguments ignore " + String(key) + " getters throwing=" + String(throwing), () => {
    const frame: NativeFrame = { kind: 2, sequence: 1, scope: 1n, environment: 0n, operation: "call", status: 0, args: [0n], bytes: new Uint8Array() };
    const bytes = encodeNativeFrame(frame), target = {}, argument = {}, supplied: unknown[] = [];
    const bridge = new NativeBridge({ call: () => { throw new Error("Unexpected asynchronous request"); } }, {
      read: () => bytes, writeAll: () => undefined,
    }, 3, 4, { changed: () => undefined, failed: error => { throw error; }, uncaught: error => { throw error; }, trace: request => {
      if (request.kind !== 1) return;
      for (let index = 1; index < request.args.length; index++) { const handle = request.args[index]; supplied[supplied.length] = handle === 0n || handle === undefined ? undefined : bridge.values.get(handle); }
    } });
    const observed = poisoned(key, throwing, () => bridge.values.invoke(4096n, target, undefined, [argument, 7]), owner);
    expect(observed).toEqual({ result: undefined, failure: undefined, effects: 0 });
    expect(supplied).toEqual([target, undefined, argument, 7]); expect(bridge.pending).toBe(0);
    bridge.values.dispose();
  });
}
