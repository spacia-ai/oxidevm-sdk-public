import { expect, it } from "vitest";
import { NativeHandles } from "./handles.js";
import { NativeValues } from "./values.js";
import { NativeCallbacks } from "./callbacks.js";
import { NativeBridge } from "./bridge.js";
import { encodeNativeFrame } from "./codec.js";

const mapPrototype = Reflect.getPrototypeOf(new Map<bigint, unknown>()), setPrototype = Reflect.getPrototypeOf(new Set<bigint>());
if (mapPrototype === null || setPrototype === null) throw new Error("Missing collection prototypes");
const cases = [
  ...["get", "set", "has", "delete", "size", "values", "keys", "entries", "clear"].map(key => ({ name: "map-" + key, owner: mapPrototype, key })),
  ...["add", "has", "delete", "size", "values", "entries", "clear"].map(key => ({ name: "set-" + key, owner: setPrototype, key })),
  { name: "map-iterator", owner: mapPrototype, key: Symbol.iterator },
  { name: "set-iterator", owner: setPrototype, key: Symbol.iterator },
];
function observe(owner: object, key: PropertyKey, throwing: boolean, action: () => unknown): unknown {
  const original = Object.getOwnPropertyDescriptor(owner, key), define = Object.defineProperty, apply = Reflect.apply;
  if (original === undefined) throw new Error("Missing collection intrinsic");
  const previous: unknown = original.value, getter: unknown = Reflect.get(original, "get");
  let effects = 0, output: unknown, failure: unknown;
  try {
    define(owner, key, { configurable: true, get(this: unknown): unknown {
      effects++; if (throwing) throw new Error("Application collection getter");
      if (typeof getter !== "function") return previous;
      const result: unknown = apply(getter, this, []); return result;
    } });
    try { output = action(); } catch (error) { failure = error; }
  } finally { define(owner, key, original); }
  expect(effects).toBe(0); expect(failure).toBeUndefined();
  return output;
}

for (const { name, owner, key } of cases) for (const throwing of [false, true]) {
  it("handle construction and retirement ignore " + name + " getters throwing=" + String(throwing), () => {
    let instance: NativeHandles | undefined;
    try {
      const result = observe(owner, key, throwing, () => {
        const handles = new NativeHandles(0n); instance = handles;
        const root = handles.add("root"); handles.createTransport(1n);
        let child = 0n, read: unknown;
        handles.withTransport(1n, () => {
          const scope = handles.open(1n, true); child = handles.add("child");
          const escaped = handles.escape(scope, 1n, child); read = handles.get(escaped);
          handles.close(scope, 1n, true);
        });
        handles.retireTransport(1n);
        let stale = false; try { handles.get(child); } catch { stale = true; }
        const rootValue = handles.get(root); handles.dispose(); handles.dispose();
        return { read, rootValue, stale };
      });
      expect(result).toEqual({ read: "child", rootValue: "root", stale: true });
    } finally { instance?.dispose(); }
  });

  it("environment and deferred cleanup ignore " + name + " getters throwing=" + String(throwing), async () => {
    let instance: NativeValues | undefined, promise: unknown;
    const empty = new Uint8Array();
    try {
      const result = observe(owner, key, throwing, () => {
        const values = new NativeValues(() => undefined, () => undefined); instance = values;
        values.registerEnvironment(1n, 10); values.createScope(1n);
        const result = values.withScope(1n, () => values.withEnvironment(1n, () => {
          const handle = values.add("ok"), created = values.dispatch("napi_create_promise", [], empty);
          const deferred = created.args[0], promiseHandle = created.args[1];
          if (deferred === undefined || promiseHandle === undefined) throw new Error("Missing native deferred");
          promise = values.get(promiseHandle);
          const settled = values.dispatch("napi_resolve_deferred", [deferred, handle], empty);
          const repeated = values.dispatch("napi_resolve_deferred", [deferred, handle], empty);
          return { created: created.status, settled: settled.status, repeated: repeated.status, version: values.moduleVersion };
        }));
        values.retireScope(1n); values.dispose(); values.dispose(); return result;
      });
      expect(result).toEqual({ created: 0, settled: 0, repeated: 1, version: 10 });
      await expect(promise).resolves.toBe("ok");
    } finally { instance?.dispose(); }
  });

  it("callback lifetime ignores " + name + " getters throwing=" + String(throwing), () => {
    let instance: NativeCallbacks | undefined;
    const retired: bigint[] = [], finalized: bigint[] = [];
    try {
      const result = observe(owner, key, throwing, () => {
        const callbacks = new NativeCallbacks(0n, { claim: () => undefined, retire: id => { retired.push(id); }, finalize: id => { finalized.push(id); } }); instance = callbacks;
        callbacks.add({}, 4096n, "function", 1n); callbacks.add({}, 4097n, "finalizer", 1n);
        callbacks.validateAll([8194n, 8195n]); callbacks.finalize();
        const active = callbacks.active(4096n), live = callbacks.live;
        callbacks.dispose(); callbacks.dispose(); return { active, live, remaining: callbacks.live };
      });
      expect(result).toEqual({ active: true, live: 1, remaining: 0 });
      expect(retired).toEqual([4096n]); expect(finalized).toEqual([4097n]);
    } finally { instance?.dispose(); }
  });

  it("native invocation and liveness ignore " + name + " getters throwing=" + String(throwing), () => {
    const bytes = encodeNativeFrame({ kind: 2, sequence: 1, scope: 1n, environment: 0n, operation: "load", status: 0, args: [0n], bytes: new Uint8Array() });
    let reads = 0;
    const bridge = new NativeBridge({ call: () => { throw new Error("Unexpected async transport"); } }, {
      read: () => { if (reads++ !== 0) throw new Error("Unexpected native read"); return bytes; }, writeAll: () => undefined,
    }, 3, 4, { changed: () => { void bridge.pending; }, failed: error => { throw new Error("Unexpected native failure", { cause: error }); }, uncaught: error => { throw new Error("Unexpected native exception", { cause: error }); } });
    try {
      const result = observe(owner, key, throwing, () => { const loaded = bridge.load("/fixture.node"); return { loaded, pending: bridge.pending }; });
      expect(result).toEqual({ loaded: undefined, pending: 0 });
    } finally { bridge.values.dispose(); }
  });

  it("async references retire through " + name + " getters throwing=" + String(throwing), () => {
    const states: number[] = [];
    const frames = [
      { kind: 6, sequence: 2, scope: 0x1_0000_0002n, operation: "async-queued", args: [2n] },
      ...[1n, 0n, 1n, 2n].map(state => ({ kind: 7, sequence: 100, scope: 0x1_0000_0064n, operation: "async-reference", args: [100n, state] })),
      { kind: 5, sequence: 2, scope: 0x1_0000_0002n, operation: "async-complete", args: [2n] },
      { kind: 2, sequence: 1, scope: 1n, operation: "load", args: [0n] },
    ].map(frame => encodeNativeFrame({ ...frame, environment: 0n, status: 0, bytes: new Uint8Array() }));
    let reads = 0;
    const bridge = new NativeBridge({ call: () => { throw new Error("Unexpected async transport"); } }, {
      read: () => { const bytes = frames[reads++]; if (bytes === undefined) throw new Error("Unexpected native read"); return bytes; }, writeAll: () => undefined,
    }, 3, 4, { changed: () => { states.push(bridge.pending); }, failed: error => { throw new Error("Unexpected native failure", { cause: error }); }, uncaught: error => { throw new Error("Unexpected native exception", { cause: error }); } });
    try {
      const result = observe(owner, key, throwing, () => { bridge.load("/fixture.node"); return bridge.pending; });
      expect(result).toBe(0); expect(states).toEqual([1, 2, 1, 2, 1, 0]);
    } finally { bridge.values.dispose(); }
  });
}
