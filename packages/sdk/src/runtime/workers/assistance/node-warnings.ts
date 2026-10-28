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

import type { NodeProcess } from "./node-process.ts";
import { basename } from "./node-path.js";

/** Warning construction and delivery follow the managed Node 24 overloads.
 * Delivery uses the process scheduler, preserving context and nextTick order. */
export function createWarningEmitter(process: NodeProcess, nextTick: (callback: () => void) => void) {
  function emitWarning(warning: unknown, type?: unknown, code?: unknown, ctor?: unknown): void {
    if (process.noDeprecation && type === "DeprecationWarning") return;
    let detail: string | undefined;
    if (type !== null && typeof type === "object" && !Array.isArray(type)) {
      ctor = Reflect.get(type, "ctor"); code = Reflect.get(type, "code");
      const value: unknown = Reflect.get(type, "detail");
      if (typeof value === "string") detail = value;
      const name: unknown = Reflect.get(type, "type");
      const named = Boolean(name);
      type = named ? name : "Warning";
    } else if (typeof type === "function") { ctor = type; code = undefined; type = "Warning"; }
    if (type !== undefined && typeof type !== "string") throw invalid("type");
    if (typeof code === "function") { ctor = code; code = undefined; }
    else if (code !== undefined && typeof code !== "string") throw invalid("code");
    let error: Error;
    if (typeof warning === "string") {
      error = new Error(warning);
      error.name = type === undefined || type === "" ? "Warning" : type;
      if (code !== undefined) Object.assign(error, { code });
      if (detail !== undefined) Object.assign(error, { detail });
      const capture: unknown = Reflect.get(Error, "captureStackTrace");
      const customConstructor = Boolean(ctor);
      if (typeof capture === "function") Reflect.apply(capture, Error, [error, customConstructor ? ctor : emitWarning]);
    } else if (warning instanceof Error) error = warning;
    else throw invalid("warning");
    if (error.name === "DeprecationWarning") {
      if (process.noDeprecation) return;
      if (process.throwDeprecation) { nextTick(() => { throw error; }); return; }
    }
    nextTick(() => { process.emit("warning", error); });
  }
  return emitWarning;
}

function invalid(argument: string): TypeError {
  return Object.assign(new TypeError(`Invalid process.emitWarning ${argument}`), { code: "ERR_INVALID_ARG_TYPE" });
}

/** The default listener is removable through ordinary process EventEmitter APIs.
 * Suppressing console output never suppresses delivery to application listeners. */
export function createWarningPrinter(process: NodeProcess, write: (text: string) => void, pid: () => number) {
  let helperShown = false;
  return function onWarning(warning: unknown): void {
    if (!(warning instanceof Error)) return;
    const deprecation = warning.name === "DeprecationWarning";
    if (deprecation && process.noDeprecation) return;
    const trace = process.traceProcessWarnings || (deprecation && process.traceDeprecation);
    const code: unknown = Reflect.get(warning, "code");
    const detail: unknown = Reflect.get(warning, "detail");
    const coded = Boolean(code);
    if (typeof code === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    // Node intentionally applies ordinary ToString to a supplied Error's code,
    // including caller-defined objects. Keep that coercion, rather than inspect.
    const label = coded ? `[${String(code)}] ` : "";
    const stack = warning.stack;
    const display = trace && stack !== undefined && stack !== "" ? stack
      : typeof warning.toString === "function" ? warning.toString() : Error.prototype.toString.call(warning);
    let text = `(node:${pid()}) ${label}${display}`;
    if (typeof detail === "string") text += `\n${detail}`;
    if (!trace && !helperShown) {
      const argv0: unknown = Reflect.get(process, "argv0");
      const hasCommand = Boolean(argv0), command = basename(hasCommand ? argv0 : "node", ".exe");
      text += `\n(Use \`${command} ${deprecation ? "--trace-deprecation" : "--trace-warnings"} ...\` to show where the warning was created)`;
      helperShown = true;
    }
    write(`${text}\n`);
  };
}
