import { deprecate, format, inspect } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeAsyncHooks } from "./node-async-hooks.js";
import { createNodeEvents } from "./node-events.js";
import { EventEmitter } from "./node-streams.js";

function builtin() {
  const hooks = createNodeAsyncHooks(createAsyncContext(), { deprecate, format, inspect });
  const events = createNodeEvents(EventEmitter, hooks);
  onTestFinished(events.restore);
  return { hooks, Resource: events.module.EventEmitterAsyncResource };
}

function throwsCode(callback: () => unknown, code: string): void {
  try { callback(); } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("code", code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("EventEmitterAsyncResource", () => {
  it("captures construction context and restores nested and throwing emits", () => {
    const { hooks, Resource } = builtin();
    const storage = new hooks.AsyncLocalStorage<string>();
    const emitter = storage.run("created", () => new Resource({ name: "Fixture" }));
    const seen: unknown[] = [];
    emitter.on("inner", function (this: unknown, value) {
      seen.push([this === emitter, value, storage.getStore(), hooks.executionAsyncId(), hooks.executionAsyncResource() === emitter.asyncResource]);
    });
    emitter.on("outer", () => {
      emitter.emit("inner", 42);
      throw new Error("listener failed");
    });
    storage.run("caller", () => {
      expect(() => emitter.emit("outer")).toThrow("listener failed");
      expect(storage.getStore()).toBe("caller");
      expect(hooks.executionAsyncId()).toBe(1);
    });
    expect(seen).toEqual([[true, 42, "created", emitter.asyncId, true]]);
    expect(emitter.emit("missing")).toBe(false);
    expect(emitter.emit("inner", 84)).toBe(true);
    expect(() => emitter.emit("error", new Error("unhandled"))).toThrow("unhandled");
    expect(hooks.executionAsyncId()).toBe(1);
    expect(emitter.asyncResource.eventEmitter).toBe(emitter);
    expect(emitter.asyncResource).toBeInstanceOf(hooks.AsyncResource);
    expect(emitter).toBeInstanceOf(EventEmitter);
  });

  it("uses the shared hook identity and reports each explicit destroy", async () => {
    const { hooks, Resource } = builtin();
    const events: unknown[] = [];
    const hook = hooks.createHook({
      init: (id: number, name: string, trigger: number, resource: object) => events.push(["init", id, name, trigger, resource]),
      before: (id: number) => events.push(["before", id, hooks.executionAsyncId()]),
      after: (id: number) => events.push(["after", id, hooks.executionAsyncId()]),
      destroy: (id: number) => events.push(["destroy", id]),
    }).enable();
    class Pool extends Resource {}
    const pool = new Pool({ triggerAsyncId: 77, requireManualDestroy: true });
    expect(pool.triggerAsyncId).toBe(77);
    expect(pool.emit("empty")).toBe(false);
    expect(() => { pool.emitDestroy(); }).not.toThrow();
    pool.emitDestroy();
    await new Promise<void>(resolve => queueMicrotask(resolve));
    hook.disable();
    expect(events).toEqual([
      ["init", pool.asyncId, "Pool", 77, pool.asyncResource],
      ["before", pool.asyncId, pool.asyncId],
      ["after", pool.asyncId, pool.asyncId],
      ["destroy", pool.asyncId],
      ["destroy", pool.asyncId],
    ]);
    const names: unknown[] = [], nameHook = hooks.createHook({ init(_id: unknown, name: unknown) { names.push(name); } }).enable();
    const positional = new Resource("Positional"), explicit = new Resource({ name: "Explicit" });
    nameHook.disable(); positional.emitDestroy(); explicit.emitDestroy();
    expect(names).toEqual(["Positional", "Explicit"]);
  });

  it("validates names and trigger identities before resource initialization", () => {
    const { hooks, Resource } = builtin();
    let initialized = 0;
    hooks.createHook({ init: () => { initialized++; } }).enable();
    for (const options of [undefined, null, 1, {}, { name: 1 }]) {
      throwsCode(() => new Resource(options), "ERR_INVALID_ARG_TYPE");
    }
    for (const triggerAsyncId of [NaN, Infinity, -2, 1.5]) {
      throwsCode(() => new Resource({ name: "Invalid", triggerAsyncId }), "ERR_INVALID_ASYNC_ID");
    }
    expect(initialized).toBe(0);
  });

  it("rejects captureRejections until the shared emitter supports it", () => {
    const { Resource } = builtin();
    throwsCode(() => new Resource({ name: "Rejections", captureRejections: true }), "FEATURE_NOT_AVAILABLE");
    throwsCode(() => new Resource({ name: "Invalid", captureRejections: 1 }), "ERR_INVALID_ARG_TYPE");
  });

  it("keeps extracted constructors bound to their process resource owner", () => {
    const first = builtin(), second = builtin();
    const seen: string[] = [];
    first.hooks.createHook({ init: () => seen.push("first") }).enable();
    second.hooks.createHook({ init: () => seen.push("second") }).enable();
    const one = new first.Resource("One");
    const two = new second.Resource("Two");
    expect(one.asyncResource).toBeInstanceOf(first.hooks.AsyncResource);
    expect(one.asyncResource).not.toBeInstanceOf(second.hooks.AsyncResource);
    expect(two.asyncResource).toBeInstanceOf(second.hooks.AsyncResource);
    expect(seen).toEqual(["first", "second"]);
  });

  it("rejects receivers without the resource private state", () => {
    const { Resource } = builtin();
    for (const name of ["emit", "emitDestroy"]) {
      const method: unknown = Reflect.get(Resource.prototype, name);
      if (typeof method !== "function") throw new Error(`Missing ${name}`);
      expect(() => { Reflect.apply(method, {}, ["event"]); }).toThrow(TypeError);
    }
    for (const name of ["asyncId", "triggerAsyncId", "asyncResource"]) {
      expect(() => { Reflect.get(Resource.prototype, name, {}); }).toThrow(TypeError);
    }
  });
});
