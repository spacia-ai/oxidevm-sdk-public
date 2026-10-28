import { expect, it, vi } from "vitest";
import { createAsyncResources } from "./async-resources.js";

it("keeps internal cleanup idempotent while explicit Node destroys can repeat", async () => {
  const resources = createAsyncResources(), destroyed: number[] = [];
  resources.createHook({ destroy: (id: number) => destroyed.push(id) }).enable();
  const internal = resources.create("internal", {}), explicit = resources.create("explicit", {});
  internal.destroy(); internal.destroy();
  explicit.destroy(true); explicit.destroy(true);
  await new Promise<void>(resolve => queueMicrotask(resolve));
  expect(destroyed).toEqual([internal.id, explicit.id, explicit.id]);
});

it("keeps manual callback scopes distinct from balanced AsyncResource calls", () => {
  const resources = createAsyncResources(), events: string[] = [], outer = resources.current;
  resources.createHook({ before() { events.push("before"); }, after() { events.push("after"); } }).enable();
  const resource = {}, scope = resources.create("native", resource, undefined, true);
  const close = scope.enter();
  expect(resources.current).toEqual({ id: scope.id, trigger: outer.id, resource });
  const nested = scope.enter();
  nested("returned");
  close("threw");
  expect(resources.current).toBe(outer);
  expect(events).toEqual(["before", "before", "after"]);
  expect(() => scope.run(() => { throw new Error("ordinary AsyncResource"); })).toThrow("ordinary AsyncResource");
  expect(events.slice(-2)).toEqual(["before", "after"]);
});

it("replaces a collected external resource once and keeps replacements separate", async () => {
  const dereference = vi.spyOn(WeakRef.prototype, "deref").mockReturnValue(undefined);
  try {
    vi.resetModules();
    const { createAsyncResources: controlledResources } = await import("./async-resources.js");
    const resources = controlledResources();
    const one = resources.create("one", {}, undefined, true), two = resources.create("two", {}, undefined, true);
    const replacement = one.run(() => resources.current.resource);
    expect(one.run(() => resources.current.resource)).toBe(replacement);
    expect(two.run(() => resources.current.resource)).not.toBe(replacement);
  } finally { dereference.mockRestore(); vi.resetModules(); }
});

it("snapshots hooks before a callback removes one hook and adds another", () => {
  const resources = createAsyncResources(), events: string[] = [];
  const second = resources.createHook({ before() { events.push("second"); } });
  const late = resources.createHook({ before() { events.push("late"); } });
  resources.createHook({ before() { events.push("first"); second.disable(); late.enable(); } }).enable();
  second.enable();
  const scope = resources.create("reentrant", {}, undefined, true);
  scope.run(() => events.push("callback"));
  expect(events).toEqual(["first", "second", "callback"]);
  scope.run(() => events.push("callback"));
  expect(events).toEqual(["first", "second", "callback", "first", "late", "callback"]);
  resources.dispose();
});

it("runs a callback with zero async identity without creating hook events", () => {
  const resources = createAsyncResources(), outer = resources.current, events: string[] = [];
  resources.createHook({ init() { events.push("init"); }, before() { events.push("before"); }, after() { events.push("after"); } }).enable();
  const receiver = {};
  expect(() => resources.runUntracked(receiver, () => {
    expect(resources.current).toEqual({ id: 0, trigger: 0, resource: receiver });
    throw new Error("callback failed");
  })).toThrow("callback failed");
  expect(resources.current).toBe(outer);
  expect(events).toEqual([]);
});
