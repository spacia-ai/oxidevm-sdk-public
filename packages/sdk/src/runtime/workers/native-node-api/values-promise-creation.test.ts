import { deprecate, format, inspect } from "node:util";
import { types } from "node:util";
import { expect, it } from "vitest";
import { createAsyncContext } from "../assistance/async-context.js";
import { createNodeAsyncHooks } from "../assistance/node-async-hooks.js";
import { installPromiseContext } from "../assistance/promise-context.js";
import { NativeValues } from "./values.js";

const empty = new Uint8Array(), NativePromise = Promise;
function fixture() { return new NativeValues(() => undefined, () => undefined); }
function create(values: NativeValues) {
  const result = values.dispatch("napi_create_promise", [], empty);
  expect(result.status).toBe(0);
  const [deferred, handle] = result.args;
  if (deferred === undefined || handle === undefined) throw new Error("Missing deferred");
  return { deferred, promise: values.get(handle), handle };
}

it("creates a genuine Promise without reading a replaced global constructor or factory", () => {
  for (const target of [globalThis, NativePromise]) {
    const values = fixture(), key = target === globalThis ? "Promise" : "withResolvers";
    const original = Object.getOwnPropertyDescriptor(target, key);
    if (original === undefined) throw new Error("Missing intrinsic descriptor");
    let reads = 0, result: ReturnType<typeof create> | undefined;
    try {
      Object.defineProperty(target, key, { configurable: true, get() { reads++; throw new Error("Application getter ran"); } });
      result = create(values);
    } finally { Object.defineProperty(target, key, original); }
    expect(reads).toBe(0);
    expect(types.isPromise(result.promise)).toBe(true);
    values.dispose();
  }
});

for (const operation of ["napi_resolve_deferred", "napi_reject_deferred"] as const) {
  it(`validates a stale resolution before consuming ${operation}'s deferred`, async () => {
    const values = fixture(), created = create(values), result = { value: operation };
    const observed = NativePromise.resolve(created.promise).then(value => ["resolved", value], (error: unknown) => ["rejected", error]);
    values.createScope(1n);
    const stale = values.withScope(1n, () => values.add({ stale: true }));
    values.retireScope(1n);
    expect(() => values.dispatch(operation, [created.deferred, stale], empty)).toThrow(/stale/u);
    expect(values.dispatch(operation, [created.deferred, values.add(result)], empty).status).toBe(0);
    await expect(observed).resolves.toEqual([operation === "napi_resolve_deferred" ? "resolved" : "rejected", result]);
    expect(values.dispatch(operation, [created.deferred, values.add(result)], empty).status).toBe(1);
    values.dispose();
  });
}

it("does not consume a deferred while an application exception is pending", async () => {
  const values = fixture(), created = create(values), exception = Symbol("pending"), result = {};
  values.dispatch("napi_throw", [values.add(exception)], empty);
  expect(values.dispatch("napi_resolve_deferred", [created.deferred, values.add(result)], empty).status).toBe(10);
  const cleared = values.dispatch("napi_get_and_clear_last_exception", [], empty).args[0];
  if (cleared === undefined) throw new Error("Missing exception");
  expect(values.get(cleared)).toBe(exception);
  expect(values.dispatch("napi_resolve_deferred", [created.deferred, values.add(result)], empty).status).toBe(0);
  await expect(created.promise).resolves.toBe(result);
  values.dispose();
});

it("preserves pinned Bun self-resolution errors independently of the host engine", async () => {
  const values = new NativeValues(() => undefined, () => undefined, undefined, 0, undefined,
    { runtime: "bun", claim: () => undefined, retire: () => undefined });
  const created = create(values);
  const observed = NativePromise.resolve(created.promise).then(() => "unexpected", (error: unknown) => error);
  expect(values.dispatch("napi_resolve_deferred", [created.deferred, created.handle], empty).status).toBe(0);
  await expect(observed).resolves.toMatchObject({ name: "TypeError", message: "Cannot resolve a promise with itself" });
  values.dispose();
});

it("keeps native creation and settlement in the existing Promise context owner", async () => {
  const values = fixture(), context = createAsyncContext(), hooks = createNodeAsyncHooks(context, { deprecate, format, inspect });
  const store = new context.AsyncLocalStorage<string>(), initialized: object[] = [], resolved: number[] = [];
  const hook = hooks.createHook({
    init(_id: number, type: string, _trigger: number, resource: object) { if (type === "PROMISE") initialized.push(resource); },
    promiseResolve(id: number) { resolved.push(id); },
  }).enable();
  const restore = installPromiseContext(context, globalThis);
  try {
    values.bindAsyncContext(context);
    const created = store.run("created", () => create(values));
    expect(initialized).toContain(created.promise);
    const events: unknown[] = [], input = { get then() {
      events.push(["get", store.getStore()]);
      return (resolve: (value: unknown) => void) => { events.push(["call", store.getStore()]); resolve(7); };
    } };
    const observed = store.run("reaction", () => NativePromise.resolve(created.promise).then(value => { events.push(["reaction", store.getStore(), value]); }));
    store.run("settlement", () => {
      expect(values.dispatch("napi_resolve_deferred", [created.deferred, values.add(input)], empty).status).toBe(0);
      events.push(["returned", store.getStore()]);
    });
    await observed;
    expect(events).toEqual([["get", "settlement"], ["returned", "settlement"], ["call", "settlement"], ["reaction", "reaction", 7]]);
    expect(resolved.length).toBeGreaterThan(0);
  } finally { restore(); hook.disable(); values.dispose(); }
});
