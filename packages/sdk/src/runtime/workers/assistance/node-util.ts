/*!
 * Portions adapted from Node.js v24.18.1 lib/util.js, lib/internal/util.js
 * and lib/internal/process/warning.js; modified for OxideVM's process owner.
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
import inspection from "node-inspect-extracted";
import { parseArgs as parseArguments } from "@pkgjs/parseargs";
import { record } from "../../decode.ts";
import { VMError } from "../../errors.ts";
import { nodeAssert } from "./node-assert.ts";
import { nodeUtilTypes, exactPromiseUtilTypes } from "./node-util-types.ts";
import { createStyleText } from "./node-util-style.js";
import type { NodeProcess } from "./node-process.ts";
import { unavailableNodeApi } from "./node-capability.js";

// Dependency declarations contain permissive parameter types. Quarantine the
// namespace and expose only validated functions used by the admitted graph.
const exports = record(inspection, "Node inspection exports");
const apply = Reflect.apply, read = Reflect.get;
type Callable = (this: unknown, ...args: unknown[]) => unknown;
function callable(value: unknown): value is Callable { return typeof value === "function"; }
function stringOperation(name: string): (...args: unknown[]) => string {
  const operation = exports[name];
  if (!callable(operation)) throw new TypeError(`Missing util.${name}`);
  const wrapped = (...args: unknown[]): string => {
    const result: unknown = Reflect.apply(operation, undefined, args);
    if (typeof result !== "string") throw new TypeError(`Invalid util.${name} result`);
    return result;
  };
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(operation));
  return wrapped;
}

const customPromisify = Symbol.for("nodejs.util.promisify.custom");
const promisify = Object.assign(function promisify(original: unknown): Callable {
  if (!callable(original)) throw invalid("original");
  const custom: unknown = Reflect.get(original, customPromisify);
  const hasCustom = Boolean(custom);
  if (hasCustom) {
    if (!callable(custom)) throw invalid("util.promisify.custom");
    Object.defineProperty(custom, customPromisify, { value: custom, configurable: true });
    return custom;
  }
  const wrapped = function (this: unknown, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      Reflect.apply(original, this, [...args, (error: unknown, value: unknown) => {
        const failed = Boolean(error);
        if (failed) {
          // Node forwards callback error values unchanged, including primitives.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        } else resolve(value);
      }]);
    });
  };
  const prototype: unknown = Object.getPrototypeOf(original);
  if (prototype !== null && typeof prototype !== "object" && typeof prototype !== "function") {
    throw new TypeError("Invalid function prototype");
  }
  Object.setPrototypeOf(wrapped, prototype);
  Object.defineProperty(wrapped, customPromisify, { value: wrapped, configurable: true });
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
  return wrapped;
}, { custom: customPromisify });

function invalid(name: string): TypeError {
  return Object.assign(new TypeError(`The ${name} argument must be a function`), { code: "ERR_INVALID_ARG_TYPE" });
}

// Node accepts constructor-shaped objects too. Preserve the child's prototype
// and own methods; only its prototype's parent and the super_ descriptor change.
function inherits(ctor: unknown, superCtor: unknown): void {
  if (ctor === undefined || ctor === null) throw invalid("ctor");
  if (superCtor === undefined || superCtor === null) throw invalid("superCtor");
  const parent: unknown = typeof superCtor === "object" || typeof superCtor === "function"
    ? Reflect.get(superCtor, "prototype") : undefined;
  if (parent === undefined) throw Object.assign(new TypeError("superCtor.prototype must be an object"), { code: "ERR_INVALID_ARG_TYPE" });
  if (typeof ctor !== "object" && typeof ctor !== "function") throw new TypeError("Object.defineProperty called on non-object");
  Object.defineProperty(ctor, "super_", { value: superCtor, writable: true, configurable: true });
  const prototype: unknown = Reflect.get(ctor, "prototype");
  if (parent !== null && typeof parent !== "object" && typeof parent !== "function") throw new TypeError("Object prototype may only be an Object or null");
  Object.setPrototypeOf(prototype, parent);
}

function parseArgs(options?: unknown): unknown {
  if (typeof options === "object" && options !== null && "allowNegative" in options) {
    const value: unknown = options.allowNegative;
    if (value !== undefined && typeof value !== "boolean") {
      throw Object.assign(new TypeError("util.parseArgs options.allowNegative must be a boolean"), { code: "ERR_INVALID_ARG_TYPE" });
    }
    if (value === true) throw new VMError("FEATURE_NOT_AVAILABLE", "util.parseArgs option allowNegative is unsupported", { api: "util.parseArgs", option: "allowNegative" });
  }
  return parseArguments(options);
}

export const nodeUtil = {
  inspect: stringOperation("inspect"),
  format: stringOperation("format"),
  formatWithOptions: stringOperation("formatWithOptions"),
  stripVTControlCharacters: stringOperation("stripVTControlCharacters"),
  parseArgs, promisify, inherits, TextEncoder, TextDecoder, types: nodeUtilTypes,
};

/** Deprecation codes belong to one process, shared by all loaded modules. */
/** `NODE_DEBUG` selects sections by comma- or space-separated names with a
 * trailing `*` wildcard, case-insensitively; Node reads it on first use. */
function debugSelected(env: Readonly<Record<string, string | undefined>>, section: string): boolean {
  const selection = env["NODE_DEBUG"];
  if (selection === undefined || selection === "") return false;
  const upper = section.toUpperCase();
  return selection.toUpperCase().split(/[\s,]+/u).some(entry => entry !== "" && (entry.endsWith("*") ? upper.startsWith(entry.slice(0, -1)) : entry === upper));
}

export function createNodeUtil(process: Pick<NodeProcess, "noDeprecation" | "emitWarning"> & { readonly env?: Readonly<Record<string, string | undefined>>; readonly pid?: number; readonly stdout?: unknown },
  writeDebug: (line: string) => void = () => undefined, exactPromiseQueries = false) {
  const codes = new Set<string>();
  function debuglog(section: unknown, callback?: unknown) {
    if (typeof section !== "string") throw Object.assign(new TypeError("The \"section\" argument must be of type string"), { code: "ERR_INVALID_ARG_TYPE" });
    const name = section.toUpperCase();
    let enabled: boolean | undefined;
    // Node reads NODE_DEBUG on the logger's first use, not at creation.
    const isEnabled = (): boolean => { enabled ??= debugSelected(process.env ?? {}, name); return enabled; };
    const debug = Object.assign((...args: unknown[]): void => {
      if (!isEnabled()) return;
      const [first, ...rest] = args;
      writeDebug(`${name} ${process.pid ?? 0}: ${typeof first === "string" ? nodeUtil.format(first, ...rest) : nodeUtil.format(...args)}`);
    }, { enabled: false });
    Object.defineProperty(debug, "enabled", { get: isEnabled, enumerable: true, configurable: true });
    if (typeof callback === "function") { Reflect.apply(callback, undefined, [debug]); }
    return debug;
  }
  function callbackify(original: unknown) {
    if (typeof original !== "function") throw Object.assign(new TypeError("The \"original\" argument must be of type function"), { code: "ERR_INVALID_ARG_TYPE" });
    return function callbackified(this: unknown, ...args: unknown[]): void {
      const callback = args.pop();
      if (typeof callback !== "function") throw Object.assign(new TypeError("The last argument must be of type function"), { code: "ERR_INVALID_ARG_TYPE" });
      const invoke = (error: unknown, value?: unknown): void => { Reflect.apply(callback, undefined, [error, value]); };
      Promise.resolve(Reflect.apply(original, this, args)).then(
        value => { queueMicrotask(() => { invoke(null, value); }); },
        (reason: unknown) => {
          const error = reason === null || reason === undefined || reason === false || reason === "" || reason === 0
            ? Object.assign(new Error("Promise was rejected with a falsy value"), { code: "ERR_FALSY_VALUE_REJECTION", reason }) : reason;
          queueMicrotask(() => { invoke(error); });
        });
    };
  }
  function deprecate(fn: unknown, message: unknown, code?: unknown, options?: unknown): Callable {
    if (options === null) throw new TypeError("Cannot destructure deprecation options from null");
    if (code !== undefined && typeof code !== "string") throw Object.assign(new TypeError("Deprecation code must be a string"), { code: "ERR_INVALID_ARG_TYPE" });
    const warningCode = code;
    const setting: unknown = typeof options === "object" || typeof options === "function" ? read(options, "modifyPrototype") : undefined;
    const modify = setting === undefined || Boolean(setting);
    let warned = false;
    function deprecated(this: unknown, ...args: unknown[]): unknown {
      if (!process.noDeprecation && !warned) {
        warned = true;
        if (warningCode === "ExperimentalWarning") process.emitWarning(message, warningCode, deprecated);
        else if (warningCode === undefined) process.emitWarning(message, "DeprecationWarning", deprecated);
        else if (!codes.has(warningCode)) {
          process.emitWarning(message, "DeprecationWarning", warningCode, deprecated);
          codes.add(warningCode);
        }
      }
      if (!callable(fn)) throw new TypeError("Deprecated target is not callable");
      const constructor: unknown = new.target;
      const value: unknown = typeof constructor === "function" ? Reflect.construct(fn, args, constructor) : apply(fn, this, args);
      return value;
    }
    if (modify) {
      if (fn !== null && typeof fn !== "object" && typeof fn !== "function") throw new TypeError("Object prototype may only be an Object or null");
      Object.setPrototypeOf(deprecated, fn);
      if (fn === null) throw new TypeError("Cannot read properties of null");
      const prototype: unknown = Reflect.get(fn, "prototype");
      const hasPrototype = Boolean(prototype);
      if (hasPrototype) Reflect.set(deprecated, "prototype", prototype);
      Object.defineProperty(deprecated, "length", { ...Object.getOwnPropertyDescriptor(fn, "length") });
    }
    return deprecated;
  }
  return { ...nodeUtil, types: exactPromiseQueries ? exactPromiseUtilTypes : nodeUtilTypes, deprecate, debuglog, debug: debuglog, callbackify,
    aborted: () => unavailableNodeApi("util.aborted"),
    styleText: createStyleText(() => Reflect.get(nodeUtil.inspect, "colors"), process, value => nodeUtil.inspect(value)),
    toUSVString: (value: unknown): string => String(value).toWellFormed(),
    isDeepStrictEqual: (left: unknown, right: unknown): boolean => { try { nodeAssert.deepStrictEqual(left, right); return true; } catch { return false; } },
  };
}
