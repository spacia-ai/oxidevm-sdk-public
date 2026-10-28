/*!
 * Portions adapted from Node.js v24.18.1 lib/async_hooks.js and
 * lib/internal/errors.js; modified for OxideVM's existing resource owners.
 * Copyright Node.js contributors. All rights reserved.
 * Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
import type { AsyncContext } from "./async-context.ts";
import type { AsyncHook, AsyncScope } from "./async-resources.js";

const TypeError = globalThis.TypeError;
const apply = Reflect.apply, read = Reflect.get, define = Object.defineProperty;
type Callback = (this: unknown, ...args: unknown[]) => unknown;
type Deprecate = (fn: Callback, message: string, code: string, options: { readonly modifyPrototype: false }) => Callback;
type ResourceUtilities = {
  readonly deprecate: Deprecate;
  readonly format: (pattern: string, value: unknown) => string;
  readonly inspect: (value: unknown, options: { readonly depth: -1 }) => string;
};
const safeInteger = Number.isSafeInteger, negativeZero = Object.is, stringify = JSON.stringify;
function callable(value: unknown): value is Callback { return typeof value === "function"; }
function intrinsic(value: unknown): Callback {
  if (!callable(value)) throw new TypeError("Missing async resource intrinsic");
  return value;
}
const functionBind = intrinsic(read(Function.prototype, "bind")), unshift = intrinsic(read(Array.prototype, "unshift"));
function text(value: unknown): string {
  if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
  return String(value);
}
function property(value: unknown, key: string): unknown {
  if (value === null || value === undefined) throw new TypeError(`Cannot read properties of ${String(value)} (reading '${key}')`);
  const boxed: unknown = Object(value);
  if (typeof boxed !== "object" && typeof boxed !== "function" || boxed === null) throw new TypeError("Invalid async resource option");
  return read(boxed, key);
}
function received(value: unknown, inspect: ResourceUtilities["inspect"]): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "function") return `function ${text(read(value, "name"))}`;
  if (typeof value === "object") {
    const hasConstructor = Boolean(read(value, "constructor"));
    if (hasConstructor) {
      const constructor: unknown = read(value, "constructor");
      if (typeof constructor !== "object" && typeof constructor !== "function" || constructor === null) {
        throw new TypeError(`Cannot use 'in' operator to search for 'name' in ${String(constructor)}`);
      }
      if ("name" in constructor) return `an instance of ${text(property(read(value, "constructor"), "name"))}`;
    }
    return inspect(value, { depth: -1 });
  }
  if (typeof value === "string") {
    const shortened = value.length > 28 ? `${value.slice(0, 25)}...` : value;
    return `type string (${shortened.includes("'") ? stringify(shortened) : `'${shortened}'`})`;
  }
  if (typeof value === "bigint") return `type bigint (${String(value)}n)`;
  if (typeof value === "number") return `type number (${negativeZero(value, -0) ? "-0" : String(value)})`;
  if (typeof value === "boolean") return `type boolean (${String(value)})`;
  if (typeof value === "symbol") return `type symbol (${String(value)})`;
  throw new TypeError("Invalid async resource argument type");
}
function invalid(name: string, expected: string, value: unknown, inspect: ResourceUtilities["inspect"]): TypeError {
  return Object.assign(new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received(value, inspect)}`), { code: "ERR_INVALID_ARG_TYPE" });
}

export interface NodeAsyncResource {
  runInAsyncScope(fn: unknown, thisArg?: unknown, ...args: unknown[]): unknown;
  bind(fn: unknown, thisArg?: unknown): (...args: unknown[]) => unknown;
  emitDestroy(): NodeAsyncResource;
  asyncId(): number;
  triggerAsyncId(): number;
}

export interface NodeAsyncHooks {
  readonly AsyncLocalStorage: AsyncContext["AsyncLocalStorage"];
  readonly AsyncResource: { new (type: unknown, options?: unknown): NodeAsyncResource; bind(fn: unknown, type?: unknown, thisArg?: unknown): (...args: unknown[]) => unknown };
  executionAsyncId(): number;
  triggerAsyncId(): number;
  executionAsyncResource(): object;
  createHook(callbacks: unknown): AsyncHook;
  readonly asyncWrapProviders: Readonly<Record<string, number>>;
}

/** The `async_hooks` builtin: the process's AsyncLocalStorage plus a real
 * AsyncResource whose scopes run in the async context captured when the
 * resource was created. Hooks observe the shared process resource owner. */
export function createNodeAsyncHooks(context: AsyncContext, utilities: ResourceUtilities): NodeAsyncHooks {
  const { deprecate, format, inspect } = utilities;
  class AsyncResource implements NodeAsyncResource {
    #scope: AsyncScope;
    readonly #run: <Result>(callback: () => Result) => Result;
    constructor(type: unknown, options?: unknown) {
      if (typeof type !== "string") throw invalid("type", "string", type, inspect);
      let trigger: unknown = context.resources.current.id, manual = false;
      if (typeof options === "number") trigger = options;
      else if (options !== undefined) {
        trigger = property(options, "triggerAsyncId") === undefined ? context.resources.current.id : property(options, "triggerAsyncId");
        manual = Boolean(property(options, "requireManualDestroy"));
      }
      if (typeof trigger !== "number" || !safeInteger(trigger) || trigger < -1) {
        throw Object.assign(new RangeError(format("Invalid triggerAsyncId value: %s", trigger)), { code: "ERR_INVALID_ASYNC_ID" });
      }
      this.#run = context.capture();
      this.#scope = context.resources.create(type, this, trigger, manual, scope => {
        this.#scope = scope;
        if (type.length === 0 && context.resources.hasInitHooks) throw Object.assign(new TypeError('Invalid name for async "type": '), { code: "ERR_ASYNC_TYPE" });
      });
    }
    runInAsyncScope(fn: unknown, thisArg?: unknown, ...args: unknown[]): unknown {
      // Reject non-callable values inside the same balanced callback scope.
      return this.#scope.run(() => this.#run((): unknown => {
        // Keep the pinned Node diagnostic when browser engines format undefined differently.
        if (fn === undefined) throw new TypeError("Function.prototype.apply was called on undefined, which is a undefined and not a function");
        return apply(apply, undefined, [fn, thisArg, args]);
      }));
    }
    bind(fn: unknown, thisArg?: unknown): (...args: unknown[]) => unknown {
      if (!callable(fn)) throw invalid("fn", "function", fn, inspect);
      const invoke = (receiver: unknown, args: unknown[]): unknown => {
        apply(unshift, args, [fn, receiver]);
        const callback: unknown = read(this, "runInAsyncScope");
        return apply(apply, undefined, [callback, this, args]);
      };
      const bound: unknown = thisArg === undefined ? function bound(this: unknown, ...args: unknown[]): unknown {
        return invoke(this, args);
      } : apply(functionBind, property(this, "runInAsyncScope"), [this, fn, thisArg]);
      if (!callable(bound)) throw new TypeError("Invalid bound async resource callback");
      if (thisArg === undefined) {
        const descriptor = { __proto__: null, value: "bound", configurable: true, enumerable: false, writable: false };
        define(bound, "name", descriptor);
      }
      const metadata: { value: unknown } = { value: this };
      define(bound, "length", { value: read(fn, "length"), configurable: true, enumerable: false, writable: false });
      return define(bound, "asyncResource", {
        configurable: true, enumerable: true,
        get: deprecate(() => metadata.value, "The asyncResource property on bound functions is deprecated", "DEP0172", { modifyPrototype: false }),
        set: deprecate((value: unknown) => { metadata.value = value; }, "The asyncResource property on bound functions is deprecated", "DEP0172", { modifyPrototype: false }),
      });
    }
    static bind(fn: unknown, type?: unknown, thisArg?: unknown): (...args: unknown[]) => unknown {
      const hasType = Boolean(type), selected = hasType ? type : property(fn, "name"), hasSelected = Boolean(selected);
      return new AsyncResource(hasSelected ? selected : "bound-anonymous-fn").bind(fn, thisArg);
    }
    emitDestroy(): this { this.#scope.destroy(true); return this; }
    asyncId(): number { return this.#scope.id; }
    triggerAsyncId(): number { return this.#scope.trigger; }
  }
  return Object.freeze({
    AsyncLocalStorage: context.AsyncLocalStorage, AsyncResource,
    executionAsyncId: (): number => context.resources.current.id,
    triggerAsyncId: (): number => context.resources.current.trigger,
    executionAsyncResource: (): object => context.resources.current.resource,
    createHook: (callbacks: unknown) => context.resources.createHook(callbacks), asyncWrapProviders: Object.freeze({}),
  });
}
