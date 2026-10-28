import { record } from "../../decode.ts";
import { bindModuleLocals, type ModuleRecord } from "./module-records.ts";

class AwaitValue {
  readonly value: unknown;
  constructor(value: unknown) { this.value = value; }
}

/** Instantiation runs only the synthetic first yield; no application statement. */
export function instantiateModule(module: ModuleRecord, factory: unknown): () => unknown {
  if (typeof factory !== "function") throw new TypeError("Module factory must be callable");
  const iterator = record(Reflect.apply(factory, undefined, [{
    bind: (value: unknown) => bindModuleLocals(module, value),
    importBinding(name: string) {
      const binding = module.imports.get(name);
      if (binding === undefined) throw new SyntaxError(`Unlinked import '${name}'`);
      return binding;
    },
    awaitValue: (value: unknown) => new AwaitValue(value),
    asyncIterator,
    defaultName(value: unknown) {
      if (typeof value !== "function") throw new TypeError("default function export is not callable");
      Object.defineProperty(value, "name", { value: "default", configurable: true });
    },
    globalTypeof(name: string) { return typeof Reflect.get(globalThis, name); },
    globalRead(name: string): unknown {
      if (!Reflect.has(globalThis, name)) throw new ReferenceError(`${name} is not defined`);
      return Reflect.get(globalThis, name);
    },
  }]), "module execution iterator");
  const next = iterator["next"];
  const throwError = iterator["throw"];
  if (typeof next !== "function" || typeof throwError !== "function") throw new TypeError("Invalid module execution iterator");
  const initial = record(Reflect.apply(next, iterator, []), "module instantiation result");
  if (initial["done"] !== false || initial["value"] !== undefined) throw new TypeError("Invalid module instantiation boundary");
  const methods = {
    next: (value: unknown): unknown => Reflect.apply(next, iterator, [value]),
    throw: (value: unknown): unknown => Reflect.apply(throwError, iterator, [value]),
  };
  function advance(method: "next" | "throw", value: unknown): unknown {
    const result = record(methods[method](value), "module execution result");
    if (result["done"] === true) return undefined;
    const awaited = result["value"];
    if (result["done"] !== false || !(awaited instanceof AwaitValue)) throw new TypeError("Invalid top-level await boundary");
    return Promise.resolve(awaited.value).then(value => advance("next", value), (error: unknown) => advance("throw", error));
  }
  return () => advance("next", undefined);
}

function object(value: unknown): object {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") throw new TypeError("Iterator must be an object");
  return value;
}

function asyncIterator(value: unknown) {
  if (value === null || value === undefined) throw new TypeError("Value is not async iterable");
  const iterable = object(Object(value));
  const asyncMethod: unknown = Reflect.get(iterable, Symbol.asyncIterator);
  const sync = asyncMethod === undefined || asyncMethod === null;
  const method: unknown = sync ? Reflect.get(iterable, Symbol.iterator) : asyncMethod;
  if (typeof method !== "function") throw new TypeError("Value is not async iterable");
  const iterator = object(Reflect.apply(method, iterable, []));
  const next: unknown = Reflect.get(iterator, "next");
  if (typeof next !== "function") throw new TypeError("Iterator next must be callable");
  function result(value: unknown): Promise<{ done: boolean; value: unknown }> {
    const entry = object(value);
    const done = Boolean(Reflect.get(entry, "done"));
    const item: unknown = Reflect.get(entry, "value");
    return sync ? Promise.resolve(item).then(value => ({ done, value })) : Promise.resolve({ done, value: item });
  }
  return {
    next() {
      const value: unknown = Reflect.apply(next, iterator, []);
      return sync ? result(value) : Promise.resolve(value).then(object);
    },
    close() {
      const close: unknown = Reflect.get(iterator, "return");
      if (close === undefined || close === null) return Promise.resolve();
      if (typeof close !== "function") throw new TypeError("Iterator return must be callable");
      const value: unknown = Reflect.apply(close, iterator, []);
      return sync ? result(value) : Promise.resolve(value).then(object);
    },
  };
}
