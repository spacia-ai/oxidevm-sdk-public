import type { createAsyncContext } from "./async-context.ts";
import type { AsyncScope } from "./async-resources.js";

type Context = ReturnType<typeof createAsyncContext>;
type Captured = ReturnType<Context["capture"]>;

function object(value: unknown): object {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    throw new TypeError("invalid process realm object");
  }
  return value;
}

/** Install only in a disposable process realm, before admitted code runs.
 * Native await must still be lowered. Preserve native Promise scheduling and
 * species construction; bind both reactions and thenable-assimilation jobs.
 */
export function installPromiseContext(context: Context, realm: unknown): () => void {
  const global = object(realm);
  const NativePromise: unknown = Reflect.get(global, "Promise");
  if (typeof NativePromise !== "function") throw new TypeError("missing process Promise");
  const prototype = object(Reflect.get(NativePromise, "prototype") as unknown);
  const nativeThen: unknown = Reflect.get(prototype, "then");
  if (typeof nativeThen !== "function") throw new TypeError("missing process Promise.then");
  const constructorDescriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
  const thenDescriptor = Object.getOwnPropertyDescriptor(prototype, "then");
  const globalDescriptor = Object.getOwnPropertyDescriptor(global, "Promise");
  if (constructorDescriptor === undefined || thenDescriptor === undefined || globalDescriptor === undefined) {
    throw new TypeError("missing process Promise descriptors");
  }
  interface WrappedValue {
    readonly original: object;
    readonly run: Captured;
    readonly target: (() => object | undefined) | undefined;
    readonly settled: () => void;
  }
  const originalValues = new WeakMap<object, WrappedValue>();
  const promises = new WeakMap<object, AsyncScope>();

  function unwrap(value: unknown): unknown {
    return typeof value === "object" && value !== null
      ? originalValues.get(value)?.original ?? value : value;
  }

  function wrapThenable(value: unknown, run: Captured, settled: () => void, target?: () => object | undefined): unknown {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") { settled(); return value; }
    const previous = originalValues.get(value);
    const metadata: WrappedValue = {
      original: previous?.original ?? value,
      run: previous?.run ?? run,
      target: target ?? previous?.target,
      settled,
    };
    // Let the native resolver perform the single observable Get(then). A
    // separate empty proxy target also supports frozen/non-configurable then
    // properties. Reactions unwrap fulfilled values before guest callbacks.
    const wrapper = new Proxy({}, {
      get(_target, key): unknown {
        if (key !== "then") return undefined;
        return metadata.run(() => {
          let then: unknown;
          try { then = Reflect.get(metadata.original, "then"); }
          catch (error) { metadata.settled(); throw error; }
          if (typeof then !== "function") { metadata.settled(); return then; }
          return function (resolve: unknown, reject: unknown): void {
            if (typeof resolve !== "function" || typeof reject !== "function") throw new TypeError("invalid promise resolution callbacks");
            let settled = false;
            const fulfill = (next: unknown): void => {
              if (settled) return;
              settled = true;
              const original = unwrap(next);
              const self = metadata.target !== undefined && original === metadata.target();
              if (self) metadata.settled();
              const result = self ? original : wrapThenable(next, context.capture(), metadata.settled, metadata.target);
              Reflect.apply(resolve, undefined, [result]);
            };
            const fail = (error: unknown): void => {
              if (settled) return;
              settled = true;
              metadata.settled();
              Reflect.apply(reject, undefined, [error]);
            };
            metadata.run(() => {
              try {
                Reflect.apply(then, metadata.original, [fulfill, fail]);
              } catch (error) {
                fail(error);
              }
            });
          };
        });
      },
    });
    originalValues.set(wrapper, metadata);
    return wrapper;
  }

  interface ReactionCapability { result?: unknown; readonly run: Captured; readonly trigger: number | undefined }
  let constructingReaction: ReactionCapability | undefined;

  function reaction(callback: unknown, capability: ReactionCapability, rejected: boolean): unknown {
    return function (this: unknown, value: unknown): unknown {
      const invoke = (): unknown => {
        const input = rejected ? value : unwrap(value);
        if (typeof callback !== "function") {
          if (rejected) throw input;
          return input;
        }
        const result: unknown = Reflect.apply(callback, this, [input]);
        return result;
      };
      const scope = typeof capability.result === "object" && capability.result !== null ? promises.get(capability.result) : undefined;
      return capability.run(() => scope === undefined ? invoke() : scope.run(invoke));
    };
  }

  const ProcessPromise = new Proxy(NativePromise, {
    construct(target, argumentsList: unknown[], newTarget) {
      const executor = argumentsList[0];
      if (typeof executor !== "function") return object(Reflect.construct(target, argumentsList, newTarget) as unknown);
      const owner: { instance?: object } = {};
      const capability = constructingReaction;
      let resolve: unknown, reject: unknown;
      const instance = object(Reflect.construct(target, [(fulfill: unknown, fail: unknown) => { resolve = fulfill; reject = fail; }], newTarget) as unknown);
      owner.instance = instance;
      const scope = context.resources.create("PROMISE", instance, capability?.trigger, false, scope => { promises.set(instance, scope); });
      const execute = (): void => {
        const fulfillNative = resolve, rejectNative = reject;
        if (typeof fulfillNative !== "function" || typeof rejectNative !== "function") throw new TypeError("invalid native promise callbacks");
        let settled = false;
        const fulfill = (value: unknown): void => {
          if (settled) return;
          settled = true;
          try {
            const original = unwrap(value);
            // Wrapping must not hide self-resolution from the native resolver.
            const self = original === owner.instance;
            if (self) scope.resolve();
            const next = self ? owner.instance : wrapThenable(value, capability !== undefined && capability.result === owner.instance
                ? capability.run : context.capture(), () => scope.resolve(), () => owner.instance);
            Reflect.apply(fulfillNative, undefined, [next]);
          } catch (error) {
            scope.resolve();
            Reflect.apply(rejectNative, undefined, [error]);
          }
        };
        const fail = (error: unknown): void => {
          if (settled) return;
          settled = true;
          scope.resolve();
          Reflect.apply(rejectNative, undefined, [error]);
        };
        try { Reflect.apply(executor, undefined, [fulfill, fail]); } catch (error) { fail(error); }
      };
      execute();
      return instance;
    },
  });
  Object.defineProperty(prototype, "then", {
    ...thenDescriptor,
    value: function then(this: unknown, fulfilled: unknown, rejected: unknown): unknown {
      const run = context.capture();
      // Native then constructs its species capability synchronously. Attach
      // context only to that returned promise; custom species sees raw values.
      const parent = typeof this === "object" && this !== null ? promises.get(this) : undefined;
      const capability: ReactionCapability = { run, trigger: parent?.id };
      const previous = constructingReaction;
      constructingReaction = capability;
      try {
        capability.result = Reflect.apply(nativeThen, this, [reaction(fulfilled, capability, false), reaction(rejected, capability, true)]);
        return capability.result;
      } finally {
        constructingReaction = previous;
      }
    },
  });
  Object.defineProperty(prototype, "constructor", { ...constructorDescriptor, value: ProcessPromise });
  Object.defineProperty(global, "Promise", { ...globalDescriptor, value: ProcessPromise });
  return () => {
    Object.defineProperty(prototype, "then", thenDescriptor);
    Object.defineProperty(prototype, "constructor", constructorDescriptor);
    Object.defineProperty(global, "Promise", globalDescriptor);
  };
}
