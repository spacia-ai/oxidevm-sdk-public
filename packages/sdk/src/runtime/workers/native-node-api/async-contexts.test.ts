import { deprecate, format, inspect } from "node:util";
import { expect, it } from "vitest";
import { createAsyncContext } from "../assistance/async-context.js";
import { createNodeAsyncHooks } from "../assistance/node-async-hooks.js";
import { NativeValues } from "./values.js";

function fixture() {
  const context = createAsyncContext(), hooks = createNodeAsyncHooks(context, { deprecate, format, inspect });
  const values = new NativeValues(() => undefined, () => undefined, () => undefined, 37);
  values.bindAsyncContext(context);
  const environment = 37n << 32n | 1n, other = environment + 1n;
  values.registerEnvironment(environment, 10); values.registerEnvironment(other, 10);
  const call = (operation: string, args: readonly bigint[] = [], owner = environment) => values.withEnvironment(owner, () => values.dispatch(operation, args, new Uint8Array()));
  const init = (resource: object = {}) => {
    const result = call("napi_async_init", [values.add(resource), values.add("oxidevm-native-context")]);
    expect(result.status).toBe(0);
    const identity = result.args[0]; if (identity === undefined) throw new Error("Missing native context identity");
    return identity;
  };
  return { context, hooks, values, environment, other, call, init };
}

it("uses creation storage and shared async identity through nested native callbacks", () => {
  const { context, hooks, values, call, init } = fixture(), store = new context.AsyncLocalStorage<string>();
  const resource = {}, parent = hooks.executionAsyncId(), events: string[] = [];
  let id = 0;
  hooks.createHook({ init(identity: number, type: string, trigger: number, actual: object) {
    if (type === "oxidevm-native-context") { id = identity; expect(actual).toBe(resource); expect(trigger).toBe(parent); events.push("init"); }
  }, before() { events.push("before"); }, after() { events.push("after"); } }).enable();
  const identity = store.run("created", () => init(resource)), receiver = values.add({});
  const nested = values.add(() => store.getStore());
  const callback = values.add(() => {
    expect(hooks.executionAsyncId()).toBe(id); expect(hooks.executionAsyncResource()).toBe(resource);
    expect(store.getStore()).toBe("created");
    const inner = call("napi_make_callback", [identity, receiver, nested]);
    expect(inner.status).toBe(0); return values.get(inner.args[0] ?? 0n);
  });
  store.run("caller", () => {
    const result = call("napi_make_callback", [identity, receiver, callback]);
    expect(result.status).toBe(0); expect(values.get(result.args[0] ?? 0n)).toBe("created");
    expect(store.getStore()).toBe("caller"); expect(hooks.executionAsyncId()).toBe(parent);
  });
  expect(events).toEqual(["init", "before", "before", "after", "after"]);
});

it("clears manual callback storage and closes scopes in order while an exception is pending", () => {
  const { context, hooks, values, call, init } = fixture(), store = new context.AsyncLocalStorage<string>();
  const identity = store.run("created", () => init()), caller = hooks.executionAsyncId(), failure = new Error("callback failure");
  store.run("caller", () => {
    const first = call("napi_open_callback_scope", [identity]).args[0];
    expect(first).toBeDefined(); expect(store.getStore()).toBeUndefined();
    const second = call("napi_open_callback_scope", [identity]).args[0];
    expect(second).toBeDefined();
    expect(call("napi_close_callback_scope", [first ?? 0n]).status).toBe(14);
    const result = call("napi_call_function", [values.add({}), values.add(() => { throw failure; })]);
    expect(result.status).toBe(10);
    expect(call("napi_close_callback_scope", [second ?? 0n]).status).toBe(0);
    expect(call("napi_close_callback_scope", [first ?? 0n]).status).toBe(0);
    expect(store.getStore()).toBe("caller"); expect(hooks.executionAsyncId()).toBe(caller);
    const exception = call("napi_get_and_clear_last_exception");
    expect(values.get(exception.args[0] ?? 0n)).toBe(failure);
  });
});

it("restores thrown make_callback calls without an after hook and handles a null context", () => {
  const { context, hooks, values, call, init } = fixture(), store = new context.AsyncLocalStorage<string>();
  const identity = init(), events: string[] = [], receiver = {}, failure = new Error("native callback failure");
  hooks.createHook({ before() { events.push("before"); }, after() { events.push("after"); } }).enable();
  store.run("caller", () => {
    const result = call("napi_make_callback", [identity, values.add(receiver), values.add(() => { throw failure; })]);
    expect(result.status).toBe(10); expect(store.getStore()).toBe("caller");
    expect(values.get(call("napi_get_and_clear_last_exception").args[0] ?? 0n)).toBe(failure);
    const zero = call("napi_make_callback", [0n, values.add(receiver), values.add(() => {
      expect(hooks.executionAsyncId()).toBe(0); expect(hooks.triggerAsyncId()).toBe(0);
      expect(hooks.executionAsyncResource()).toBe(receiver); expect(store.getStore()).toBeUndefined(); return 7;
    })]);
    expect(zero.status).toBe(0); expect(values.get(zero.args[0] ?? 0n)).toBe(7);
    expect(store.getStore()).toBe("caller");
  });
  expect(events).toEqual(["before"]);
});

it("fences module and retired identities without entering callbacks", () => {
  const { values, call, init, other } = fixture(), identity = init(); let calls = 0;
  const args = [identity, values.add({}), values.add(() => calls++)];
  expect(call("napi_make_callback", args, other).status).toBe(1);
  expect(call("napi_async_destroy", [identity], other).status).toBe(1);
  expect(call("napi_async_destroy", [identity]).status).toBe(0);
  expect(call("napi_make_callback", args).status).toBe(1);
  expect(call("napi_async_destroy", [identity]).status).toBe(1);
  expect(init()).not.toBe(identity); expect(calls).toBe(0);
});

it("matches make_callback's invalid-argument status for a nonfunction value", () => {
  const { values, call, init } = fixture();
  expect(call("napi_make_callback", [init(), values.add({}), values.add(undefined)]).status).toBe(1);
});

for (const operation of ["napi_create_async_work", "napi_create_threadsafe_function"]) it(`${operation} enters completion with its shared resource identity and cleared storage`, () => {
  const { context, hooks, values, call } = fixture(), store = new context.AsyncLocalStorage<string>();
  const resource = {}, parent = hooks.executionAsyncId(), events: string[] = []; let identity = 0;
  hooks.createHook({ init(id: number, name: string, trigger: number, actual: object) {
    expect(name).toBe("native-work"); expect(actual).toBe(resource); expect(trigger).toBe(parent); identity = id; events.push("init");
  }, before() { events.push("before"); }, after() { events.push("after"); } }).enable();
  const work = store.run("created", () => call(operation, [values.add(resource), values.add("native-work")]));
  expect(work.status).toBe(0);
  store.run("caller", () => {
    const scope = call("napi_open_callback_scope", work.args); expect(scope.status).toBe(0);
    expect(store.getStore()).toBeUndefined(); expect(hooks.executionAsyncId()).toBe(identity);
    expect(hooks.executionAsyncResource()).toBe(resource);
    expect(call("napi_async_destroy", work.args).status).toBe(0);
    expect(call("napi_close_callback_scope", scope.args).status).toBe(0);
    expect(store.getStore()).toBe("caller"); expect(hooks.executionAsyncId()).toBe(parent);
  });
  expect(events).toEqual(["init", "before", "after"]);
});

for (const operation of ["napi_create_async_work", "napi_create_threadsafe_function"]) it(`${operation} keeps conversion failures outside the clearable pending exception`, () => {
  const { values, call } = fixture();
  expect(call(operation, [values.add(null), values.add("work")]).status).toBe(2);
  expect(call("napi_is_exception_pending").args).toEqual([0n]); expect(() => values.throwPending()).toThrow(TypeError);
  expect(call(operation, [0n, values.add(Symbol())]).status).toBe(3);
  expect(call("napi_is_exception_pending").args).toEqual([0n]); expect(() => values.throwPending()).toThrow(TypeError);
});

it("retires 8192 contexts without exhausting live capacity or duplicating destroy hooks", async () => {
  const { values, hooks, call } = fixture(), resource = values.add({}), name = values.add("reclaimed");
  let created = 0, destroyed = 0;
  hooks.createHook({ init() { created++; }, destroy() { destroyed++; } }).enable();
  for (let index = 0; index < 8192; index++) {
    const context = call("napi_async_init", [resource, name]); expect(context.status).toBe(0);
    expect(call("napi_async_destroy", context.args).status).toBe(0);
  }
  await Promise.resolve(); expect(created).toBe(8192); expect(destroyed).toBe(created);
});

it("returns a resource status at live capacity and admits work after reclamation", () => {
  const { values, call } = fixture(), resource = values.add({}), name = values.add("capacity"), identities: bigint[] = [];
  for (let index = 0; index < 4096; index++) {
    const result = call("napi_async_init", [resource, name]); expect(result.status).toBe(0);
    const identity = result.args[0]; if (identity === undefined) throw new Error("Missing context"); identities.push(identity);
  }
  expect(call("napi_async_init", [resource, name]).status).toBe(9);
  for (const identity of identities) expect(call("napi_async_destroy", [identity]).status).toBe(0);
  const reused = call("napi_async_init", [resource, name]); expect(reused.status).toBe(0);
  expect(identities).not.toContain(reused.args[0]); values.dispose();
});

it("unwinds a leaked callback scope when its transport retires", () => {
  const { hooks, values, call, init } = fixture(), identity = init(), parent = hooks.executionAsyncId();
  values.createScope(1n);
  const scope = values.withScope(1n, () => call("napi_open_callback_scope", [identity]));
  expect(scope.status).toBe(0); expect(hooks.executionAsyncId()).not.toBe(parent);
  expect(() => values.retireScope(1n)).toThrow(/open callback scope/u);
  expect(hooks.executionAsyncId()).toBe(parent);
  expect(call("napi_close_callback_scope", scope.args).status).toBe(14);
});

it("delivers raw async-init conversion failures at their own callback boundary", () => {
  const { values, call } = fixture(), name = values.add("conversion");
  values.createScope(1n); values.createScope(2n);
  values.withScope(1n, () => {
    expect(call("napi_async_init", [values.add(null), name]).status).toBe(2);
    expect(call("napi_is_exception_pending").args).toEqual([0n]);
    const cleared = call("napi_get_and_clear_last_exception");
    expect(values.get(cleared.args[0] ?? 0n)).toBeUndefined();
    values.withScope(2n, () => { expect(() => values.throwPending()).not.toThrow(); });
    expect(() => values.throwPending()).toThrow(TypeError);
    expect(call("napi_async_init", [0n, values.add(Symbol())]).status).toBe(3);
    expect(call("napi_is_exception_pending").args).toEqual([0n]);
    expect(() => values.throwPending()).toThrow("Cannot convert a Symbol value to a string");
  });
  values.retireScope(2n); values.retireScope(1n);
});

it("retains an async completion's raw exception until the completion owner delivers it", () => {
  const { values, call } = fixture(); values.createScope(0x1_0000_0001n);
  values.withScope(0x1_0000_0001n, () => {
    expect(call("napi_async_init", [0n, values.add(Symbol())]).status).toBe(3);
  });
  values.retireScope(0x1_0000_0001n);
  expect(() => values.throwPending(0x1_0000_0001n)).toThrow(TypeError);
});
