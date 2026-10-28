import { deprecate, format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Script, createContext } from "node:vm";
import { createAsyncContext } from "./async-context.js";
import { createNodeAsyncHooks } from "./node-async-hooks.js";
import { installPromiseContext } from "./promise-context.js";

describe("node async_hooks builtin", () => {
  it("runs AsyncResource scopes in the async context captured at construction", () => {
    const context = createAsyncContext();
    const hooks = createNodeAsyncHooks(context, { deprecate, format, inspect });
    const storage = new hooks.AsyncLocalStorage<string>();
    const resource = storage.run("captured", () => new hooks.AsyncResource("TEST"));
    expect(storage.getStore()).toBeUndefined();
    expect(resource.runInAsyncScope(() => storage.getStore())).toBe("captured");
    const bound = resource.bind(() => storage.getStore());
    expect(bound()).toBe("captured");
    expect(resource.asyncId()).toBeGreaterThan(0);
    expect(resource.emitDestroy()).toBe(resource);
  });

  it("reports resource identity and balanced scopes through throws and hook disable", async () => {
    const hooks = createNodeAsyncHooks(createAsyncContext(), { deprecate, format, inspect });
    const events: unknown[] = [];
    const outer = hooks.executionAsyncId();
    const hook = hooks.createHook({
      init(id: number, type: string, trigger: number, resource: object) {
        if (!("asyncId" in resource) || typeof resource.asyncId !== "function") throw new Error("Resource identity is unavailable during init");
        const actual: unknown = Reflect.apply(resource.asyncId, resource, []);
        expect(actual).toBe(id);
        events.push(["init", id, type, trigger, resource]);
      },
      before: (id: number) => events.push(["before", id, hooks.executionAsyncId()]),
      after: (id: number) => events.push(["after", id, hooks.executionAsyncId()]),
      destroy: (id: number) => events.push(["destroy", id]),
    }).enable();
    expect(hook.enable()).toBe(hook);
    const parent = new hooks.AsyncResource("PARENT");
    let child: InstanceType<typeof hooks.AsyncResource> | undefined;
    expect(() => parent.runInAsyncScope(() => {
      child = new hooks.AsyncResource("CHILD");
      expect(hooks.executionAsyncResource()).toBe(parent);
      throw new Error("scope failed");
    })).toThrow("scope failed");
    expect(child?.triggerAsyncId()).toBe(parent.asyncId());
    expect(hooks.executionAsyncId()).toBe(outer);
    parent.emitDestroy().emitDestroy();
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(events).toEqual([
      ["init", parent.asyncId(), "PARENT", outer, parent],
      ["before", parent.asyncId(), parent.asyncId()],
      ["init", child?.asyncId(), "CHILD", parent.asyncId(), child],
      ["after", parent.asyncId(), parent.asyncId()],
      ["destroy", parent.asyncId()],
      ["destroy", parent.asyncId()],
    ]);
    hook.disable();
    child?.runInAsyncScope(() => undefined);
    expect(events).toHaveLength(6);
    expect(() => hooks.createHook({ before: 1 })).toThrow(/function/u);
    expect(() => new hooks.AsyncResource("INVALID", { triggerAsyncId: NaN })).toThrow(/triggerAsyncId/u);
  });

  it("tracks promise parentage, resolution and reaction scopes in a disposable realm", async () => {
    const context = createAsyncContext();
    const hooks = createNodeAsyncHooks(context, { deprecate, format, inspect });
    const events: { kind: string; id: number; trigger?: number; resource?: object }[] = [];
    hooks.createHook({
      init(id: number, type: string, trigger: number, resource: object) { if (type === "PROMISE") events.push({ kind: "init", id, trigger, resource }); },
      before(id: number) { events.push({ kind: "before", id }); },
      after(id: number) { events.push({ kind: "after", id }); },
      promiseResolve(id: number) { events.push({ kind: "resolve", id }); },
    }).enable();
    const sandbox = createContext({ hooks, install: (value: unknown) => installPromiseContext(context, value) });
    const value: unknown = await new Script(`
      install(globalThis);
      const parent = new Promise(resolve => resolve(4));
      const child = parent.then(value => [value, hooks.executionAsyncId(), hooks.triggerAsyncId()]);
      ({ parent, child });
    `).runInContext(sandbox);
    expect(typeof value).toBe("object");
    if (typeof value !== "object" || value === null) throw new Error("missing promise fixture");
    const parent: unknown = Reflect.get(value, "parent");
    const child: unknown = Reflect.get(value, "child");
    const parentInit = events.find(event => event.resource === parent);
    const childInit = events.find(event => event.resource === child);
    expect(parentInit?.id).toBeGreaterThan(1);
    expect(childInit?.trigger).toBe(parentInit?.id);
    await expect(child).resolves.toEqual([4, childInit?.id, parentInit?.id]);
    for (const id of [parentInit?.id, childInit?.id]) expect(events.filter(event => event.kind === "resolve" && event.id === id)).toHaveLength(1);
    expect(events).toContainEqual({ kind: "before", id: childInit?.id });
    expect(events).toContainEqual({ kind: "after", id: childInit?.id });
    expect(hooks.executionAsyncId()).toBe(1);
  });
});
