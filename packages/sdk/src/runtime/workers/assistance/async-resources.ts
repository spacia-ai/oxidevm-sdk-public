import { VMError } from "../../errors.js";

const defer = globalThis.queueMicrotask.bind(globalThis);
const hookNames = ["init", "before", "after", "destroy", "promiseResolve"] as const;
type HookName = typeof hookNames[number];
type Callback = (...args: unknown[]) => unknown;
type HookCallbacks = Record<HookName, Callback | undefined>;
const Set = globalThis.Set, WeakRef = globalThis.WeakRef, FinalizationRegistry = globalThis.FinalizationRegistry;
const safeInteger = Number.isSafeInteger, maximumIdentity = Number.MAX_SAFE_INTEGER, apply = Reflect.apply, read = Reflect.get;
const hooks = new Set<HookCallbacks>(), callbacks: HookCallbacks[] = [];
const hookAdd = Reflect.get(hooks, "add"), hookDelete = Reflect.get(hooks, "delete"), hookClear = Reflect.get(hooks, "clear"), hookValues = Reflect.get(hooks, "values");
const hookNext = Reflect.get(apply(hookValues, hooks, []), "next"), callbackPush = Reflect.get(callbacks, "push");
const registry = new FinalizationRegistry<number>(() => undefined), register = Reflect.get(registry, "register"), unregister = Reflect.get(registry, "unregister");
const dereference = Reflect.get(new WeakRef<object>({}), "deref");

function hookSnapshot(hooks: ReadonlySet<HookCallbacks>): HookCallbacks[] {
  const snapshot: HookCallbacks[] = [], iterator = apply(hookValues, hooks, []);
  for (let step = apply(hookNext, iterator, []); step.done !== true; step = apply(hookNext, iterator, [])) apply(callbackPush, snapshot, [step.value]);
  return snapshot;
}
export interface AsyncHook { enable(): AsyncHook; disable(): AsyncHook }
export interface AsyncScope {
  readonly id: number;
  readonly trigger: number;
  enter(): (outcome: "returned" | "threw") => void;
  run<Result>(callback: () => Result): Result;
  resolve(): void;
  destroy(repeat?: boolean): void;
}

/** JS resource identity is process-local and independent of Linux task identity. */
export function createAsyncResources() {
  const hooks = new Set<HookCallbacks>();
  const root = {};
  let next = 1;
  let current = { id: 1, trigger: 0, resource: root };
  let disposed = false;
  function emit(name: HookName, ...args: unknown[]): void {
    if (disposed) return;
    const snapshot = hookSnapshot(hooks);
    for (let index = 0; index < snapshot.length; index++) {
      const hook = snapshot[index]; if (hook === undefined) throw new VMError("PROTOCOL_ERROR", "Missing async hook snapshot");
      hook[name]?.(...args);
    }
  }
  const finalizer = new FinalizationRegistry<number>(id => emit("destroy", id));
  return {
    get current() { return current; },
    get hasInitHooks(): boolean {
      const snapshot = hookSnapshot(hooks);
      for (let index = 0; index < snapshot.length; index++) if (snapshot[index]?.init !== undefined) return true;
      return false;
    },
    runUntracked<Result>(resource: object, callback: () => Result): Result {
      const previous = current; current = { id: 0, trigger: 0, resource };
      try { return callback(); } finally { current = previous; }
    },
    create(type: string, resource: object, trigger = current.id, manualDestroy = false, initialized?: (scope: AsyncScope) => void): AsyncScope {
      if (!safeInteger(trigger) || trigger < -1) {
        throw Object.assign(new RangeError("Invalid triggerAsyncId"), { code: "ERR_INVALID_ASYNC_ID" });
      }
      if (next === maximumIdentity) throw new VMError("QUOTA_EXCEEDED", "Async resource identity exhausted");
      const id = ++next;
      const weak = new WeakRef(resource);
      let destroyed = false, resolved = false, replacement: object | undefined;
      const scope: AsyncScope = {
        id, trigger,
        enter() {
          const previous = current;
          current = { id, trigger, resource: apply(dereference, weak, []) ?? (replacement ??= {}) };
          try { emit("before", id); } catch (error) { current = previous; throw error; }
          return outcome => { try { if (outcome === "returned") emit("after", id); } finally { current = previous; } };
        },
        run<Result>(callback: () => Result): Result {
          const close = scope.enter();
          try { return callback(); } finally { close("returned"); }
        },
        resolve() { if (!resolved) { resolved = true; emit("promiseResolve", id); } },
        destroy(repeat = false) {
          if (destroyed && !repeat) return;
          destroyed = true;
          apply(unregister, finalizer, [scope]);
          defer(() => emit("destroy", id));
        },
      };
      // Hooks can inspect the resource's identity during init.
      initialized?.(scope);
      if (!manualDestroy) apply(register, finalizer, [resource, id, scope]);
      emit("init", id, type, trigger, resource);
      return scope;
    },
    createHook(callbacks: unknown): AsyncHook {
      if (typeof callbacks !== "object" || callbacks === null) throw new TypeError("Hook callbacks must be an object");
      // Absent callbacks must stay independent of later prototype changes.
      const entries: HookCallbacks = { init: undefined, before: undefined, after: undefined, destroy: undefined, promiseResolve: undefined };
      for (const name of hookNames) {
        const callback: unknown = read(callbacks, name);
        if (callback === undefined) continue;
        if (typeof callback !== "function") throw new TypeError(`Hook ${name} must be a function`);
        entries[name] = (...args): unknown => apply(callback, undefined, args);
      }
      const hook: AsyncHook = {
        enable() { if (!disposed) apply(hookAdd, hooks, [entries]); return hook; },
        disable() { apply(hookDelete, hooks, [entries]); return hook; },
      };
      return hook;
    },
    dispose() { disposed = true; apply(hookClear, hooks, []); },
  };
}
