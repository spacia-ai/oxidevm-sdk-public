import { expect, it } from "vitest";

import { createAsyncContext } from "./async-context.ts";

it("captures independent stores and restores the caller after success or failure", () => {
  const realm = createAsyncContext();
  const left = new realm.AsyncLocalStorage<string>();
  const right = new realm.AsyncLocalStorage<number>();
  const saved = left.run("A", () => right.run(2, () => realm.capture()));
  expect(left.getStore()).toBeUndefined();
  expect(saved(() => [left.getStore(), right.getStore()])).toEqual(["A", 2]);
  expect(() => saved(() => { throw new Error("failure"); })).toThrow("failure");
  expect(left.getStore()).toBeUndefined();
  expect(right.getStore()).toBeUndefined();
});

it("clears manual callback scopes without losing captured or newly entered stores", () => {
  const context = createAsyncContext(), store = new context.AsyncLocalStorage<string>();
  const captured = store.run("captured", () => context.capture());
  store.disable();
  captured(() => {
    const restore = context.clear();
    const late = new context.AsyncLocalStorage<string>();
    try {
      expect(store.getStore()).toBeUndefined();
      late.enterWith("created in callback");
      store.enterWith("inner");
      const nested = context.clear();
      expect(store.getStore()).toBeUndefined();
      nested();
      expect(store.getStore()).toBe("inner");
    } finally { restore(); }
    expect(store.getStore()).toBe("captured");
    expect(late.getStore()).toBeUndefined();
  });
  expect(store.getStore()).toBeUndefined();
});

it("snapshots retain captured stores after disable, matching Node 24", () => {
  const realm = createAsyncContext();
  const store = new realm.AsyncLocalStorage<string>();
  const captured = store.run("old", () => realm.capture());
  store.disable();
  expect(captured(() => store.getStore())).toBe("old");
  store.run("new", () => {
    expect(captured(() => store.getStore())).toBe("old");
    expect(store.getStore()).toBe("new");
  });
});

it("a storage created after capture has no value in the captured context", () => {
  const realm = createAsyncContext();
  const saved = realm.capture();
  const late = new realm.AsyncLocalStorage<string>();
  late.run("later", () => {
    expect(saved(() => late.getStore())).toBeUndefined();
    expect(late.getStore()).toBe("later");
  });
});

it("bound callbacks preserve receiver and arguments", () => {
  const realm = createAsyncContext();
  const store = new realm.AsyncLocalStorage<string>();
  const callback = store.run("bound", () => realm.AsyncLocalStorage.bind(
    function (this: { prefix: string }, count: number) {
      return [this.prefix, count, store.getStore()];
    },
  ));
  expect(callback.call({ prefix: "value" }, 3)).toEqual(["value", 3, "bound"]);
});

it("disable inside a nested context preserves the caller context", () => {
  const realm = createAsyncContext();
  const store = new realm.AsyncLocalStorage<string>();
  const snapshot = store.run("old", () => realm.AsyncLocalStorage.snapshot());
  store.run("outer", () => {
    store.run("inner", () => store.disable());
    expect(store.getStore()).toBe("outer");
    snapshot(() => store.disable());
    expect(store.getStore()).toBe("outer");
    expect(realm.capture()(() => store.getStore())).toBe("outer");
  });
});

it("an empty snapshot clears a disabled store installed by an outer snapshot", () => {
  const realm = createAsyncContext();
  const empty = realm.AsyncLocalStorage.snapshot();
  const store = new realm.AsyncLocalStorage<string>();
  const full = store.run("old", () => realm.AsyncLocalStorage.snapshot());
  store.disable();
  full(() => {
    expect(empty(() => store.getStore())).toBeUndefined();
    expect(store.getStore()).toBe("old");
  });
  expect(store.getStore()).toBeUndefined();
});

for (const key of ["push", "reverse"] as const) for (const throwing of [false, true]) it("captured storage ignores " + key + " getters throwing=" + String(throwing), () => {
  const realm = createAsyncContext(), store = new realm.AsyncLocalStorage<string>();
  const captured = store.run("captured", () => realm.capture());
  store.run("caller", () => {
    const define = Object.defineProperty, original = Object.getOwnPropertyDescriptor(Array.prototype, key);
    if (original === undefined) throw new Error("Missing storage array intrinsic");
    const previous: unknown = original.value;
    let effects = 0, result: unknown, failure: unknown;
    try {
      define(Array.prototype, key, { configurable: true, get(): unknown { effects++; if (throwing) throw new Error("Application storage getter"); return previous; } });
      try { result = captured(() => store.getStore()); } catch (error) { failure = error; }
    } finally { define(Array.prototype, key, original); }
    expect(failure).toBeUndefined(); expect(effects).toBe(0); expect(result).toBe("captured");
    expect(store.getStore()).toBe("caller");
  });
  expect(store.getStore()).toBeUndefined();
});
