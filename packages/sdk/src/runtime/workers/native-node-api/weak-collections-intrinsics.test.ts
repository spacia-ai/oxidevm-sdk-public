import { expect, it } from "vitest";
import { NativeValues } from "./values.js";
import { NativeBuffers } from "./buffers.js";

const prototype = Reflect.getPrototypeOf(new WeakMap<object, unknown>());
if (prototype === null) throw new Error("Missing WeakMap prototype");
const empty = new Uint8Array();
function observe(key: string, throwing: boolean, action: () => unknown): unknown {
  const original = Object.getOwnPropertyDescriptor(prototype, key), define = Object.defineProperty;
  if (original === undefined) throw new Error("Missing weak collection method");
  const previous: unknown = original.value;
  let effects = 0, result: unknown, failure: unknown;
  try {
    define(prototype, key, { configurable: true, get(): unknown { effects++; if (throwing) throw new Error("Application WeakMap getter"); return previous; } });
    try { result = action(); } catch (error) { failure = error; }
  } finally { define(prototype, key, original); }
  expect(effects).toBe(0); expect(failure).toBeUndefined(); return result;
}

for (const key of ["get", "set", "has", "delete"]) for (const throwing of [false, true]) for (const runtime of ["node", "bun"] as const) {
  it(runtime + " wrapping and removal ignore " + key + " getters throwing=" + String(throwing), () => {
    const values = new NativeValues(() => undefined, () => undefined, undefined, undefined, undefined, { runtime, claim: () => undefined, retire: () => undefined });
    const handle = values.add({}); values.registerEnvironment(1n, 10);
    try {
      const result = observe(key, throwing, () => values.withEnvironment(1n, () => {
        const wrapped = values.dispatch("napi_wrap", [handle, 113n, 0n, 0n], empty);
        const duplicate = values.dispatch("napi_wrap", [handle, 119n, 0n, 0n], empty);
        const unwrapped = values.dispatch("napi_unwrap", [handle], empty);
        const removed = values.dispatch("napi_remove_wrap", [handle], empty);
        const stale = values.dispatch("napi_unwrap", [handle], empty);
        const rewrapped = values.dispatch("napi_wrap", [handle, 127n, 0n, 0n], empty);
        const next = values.dispatch("napi_unwrap", [handle], empty);
        values.dispose(); values.dispose();
        return { statuses: [wrapped.status, duplicate.status, unwrapped.status, removed.status, stale.status, rewrapped.status, next.status], pointers: [unwrapped.args[0], removed.args[0], next.args[0]], staleArgs: stale.args };
      }));
      expect(result).toEqual({ statuses: [0, 1, 0, 0, 1, 0, 0], pointers: [113n, 113n, 127n], staleArgs: [] });
    } finally { values.dispose(); }
  });

  it(runtime + " tags and externals ignore " + key + " getters throwing=" + String(throwing), () => {
    const values = new NativeValues(() => undefined, () => undefined, undefined, undefined, undefined, { runtime, claim: () => undefined, retire: () => undefined });
    const handle = values.add({}); values.registerEnvironment(1n, 10);
    try {
      const result = observe(key, throwing, () => values.withEnvironment(1n, () => {
        const missing = values.dispatch("napi_check_object_type_tag", [handle, 2n, 3n], empty);
        const tagged = values.dispatch("napi_type_tag_object", [handle, 2n, 3n], empty);
        const duplicate = values.dispatch("napi_type_tag_object", [handle, 2n, 3n], empty);
        const matching = values.dispatch("napi_check_object_type_tag", [handle, 2n, 3n], empty);
        const different = values.dispatch("napi_check_object_type_tag", [handle, 2n, 4n], empty);
        const created = values.dispatch("napi_create_external", [131n, 0n], empty), external = created.args[0];
        if (external === undefined) throw new Error("Missing external handle");
        const type = values.dispatch("napi_typeof", [external], empty);
        const pointer = values.dispatch("napi_get_value_external", [external], empty);
        const invalid = values.dispatch("napi_get_value_external", [handle], empty);
        values.dispose(); values.dispose();
        return { statuses: [missing.status, tagged.status, duplicate.status, matching.status, different.status, created.status, type.status, pointer.status, invalid.status], values: [missing.args[0], matching.args[0], different.args[0], type.args[0], pointer.args[0]], invalidArgs: invalid.args };
      }));
      expect(result).toEqual({ statuses: [0, 0, 1, 0, 0, 0, 0, 0, 1], values: [0n, 1n, 0n, 8n, 131n], invalidArgs: [] });
    } finally { values.dispose(); }
  });
}

for (const key of ["get", "set", "has", "delete"]) for (const throwing of [false, true]) {
  it("buffer identity reuse ignores " + key + " getters throwing=" + String(throwing), () => {
    const retired: number[] = [], buffers = new NativeBuffers(identity => { retired.push(identity); });
    try {
      const result = observe(key, throwing, () => {
        const created = buffers.create(3, new Uint8Array([1, 2, 3])), alias = new Uint8Array(created.value.buffer, created.value.byteOffset + 1, 1);
        const identity = buffers.inspect(alias).identity;
        buffers.update(identity, new Uint8Array([4, 5, 6]));
        const value = alias[0]; buffers.dispose(); buffers.dispose(); return { identity, value };
      });
      expect(result).toEqual({ identity: 1, value: 5 }); expect(retired).toEqual([1]);
    } finally { buffers.dispose(); }
  });
}

for (const runtime of ["node", "bun"] as const) for (const version of [8, 9, 10]) {
  for (const requested of [0n, 1n]) it(runtime + " version " + String(version) + " wrap preserves pending exceptions with output=" + String(requested), () => {
    const values = new NativeValues(() => undefined, () => undefined, undefined, undefined, undefined, { runtime, claim: () => undefined, retire: () => undefined });
    const handle = values.add({}), marker = new Error("pending wrap"); values.registerEnvironment(1n, version);
    try {
      values.withEnvironment(1n, () => {
        expect(values.dispatch("napi_throw", [values.add(marker)], empty).status).toBe(0);
        const wrapped = values.dispatch("napi_wrap", [handle, 139n, 0n, requested], empty);
        expect(wrapped.status).toBe(runtime === "node" ? 10 : 0);
        expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([1n]);
        const cleared = values.dispatch("napi_get_and_clear_last_exception", [], empty), caught = cleared.args[0];
        expect(cleared.status).toBe(0); if (caught === undefined) throw new Error("Missing cleared exception"); expect(values.get(caught)).toBe(marker);
        expect(values.dispatch("napi_unwrap", [handle], empty).status).toBe(runtime === "node" ? 1 : 0);
        if (runtime === "node") expect(wrapped.args).toEqual([]);
        else if (requested !== 0n) {
          const reference = wrapped.args[0]; if (reference === undefined || reference === 0n) throw new Error("Missing pending Bun wrap reference");
          expect(values.dispatch("napi_delete_reference", [reference], empty).status).toBe(0);
        }
      });
    } finally { values.dispose(); }
  });

  it(runtime + " version " + String(version) + " wrap output without a finalizer retains the pinned contract", () => {
    const values = new NativeValues(() => undefined, () => undefined, undefined, undefined, undefined, { runtime, claim: () => undefined, retire: () => undefined });
    const target = {}, handle = values.add(target); values.registerEnvironment(1n, version);
    try {
      values.withEnvironment(1n, () => {
        const wrapped = values.dispatch("napi_wrap", [handle, 137n, 0n, 1n], empty);
        expect(wrapped.status).toBe(runtime === "node" ? 1 : 0);
        if (runtime === "node") { expect(wrapped.args).toEqual([]); expect(values.dispatch("napi_unwrap", [handle], empty).status).toBe(1); return; }
        const reference = wrapped.args[0]; if (reference === undefined || reference === 0n) throw new Error("Missing Bun wrap reference");
        expect(values.dispatch("napi_unwrap", [handle], empty).args).toEqual([137n]);
        expect(values.dispatch("napi_remove_wrap", [handle], empty).args).toEqual([137n]);
        const result = values.dispatch("napi_get_reference_value", [reference], empty), restored = result.args[0];
        expect(result.status).toBe(0); if (restored === undefined) throw new Error("Missing weak reference value"); expect(values.get(restored)).toBe(target);
        expect(values.dispatch("napi_delete_reference", [reference], empty).status).toBe(0);
        expect(values.dispatch("napi_get_reference_value", [reference], empty).status).toBe(1);
      });
    } finally { values.dispose(); }
  });
}
