import { record } from "../../decode.ts";
import type { createAsyncContext } from "./async-context.ts";

/** All admitted callbacks enter the same process-local context owner. */
export function installSchedulingContext(context: ReturnType<typeof createAsyncContext>, target: unknown): () => void {
  const realm = record(target, "process scheduler");
  const bindings = (["setTimeout", "setInterval", "queueMicrotask"] as const).map((key) => {
    const original = realm[key];
    const descriptor = Object.getOwnPropertyDescriptor(realm, key);
    if (typeof original !== "function" || (descriptor === undefined ? !Object.isExtensible(realm) : descriptor.configurable !== true)) {
      throw new TypeError(`process scheduler cannot bind ${key}`);
    }
    return { key, original, descriptor };
  });
  for (const { key, original, descriptor } of bindings) {
    Object.defineProperty(realm, key, {
      ...(descriptor ?? { configurable: true, writable: true, enumerable: true }),
      value(callback: unknown, ...arguments_: unknown[]): unknown {
        if (typeof callback !== "function") throw new TypeError(`${key} requires a function`);
        const run = context.capture();
        const scope = key === "queueMicrotask" ? context.resources.create("Microtask", callback) : undefined;
        const callbackArguments = key === "queueMicrotask" ? [] : arguments_.slice(1);
        return Reflect.apply(original, realm, [
          (): unknown => run((): unknown => {
            const invoke = (): unknown => Reflect.apply(callback, undefined, callbackArguments);
            try { return scope === undefined ? invoke() : scope.run(invoke); } finally { scope?.destroy(); }
          }),
          ...(key === "queueMicrotask" ? [] : [arguments_[0]]),
        ]);
      },
    });
  }
  return () => {
    for (const { key, descriptor } of bindings) {
      if (descriptor === undefined) Reflect.deleteProperty(realm, key);
      else Object.defineProperty(realm, key, descriptor);
    }
  };
}
