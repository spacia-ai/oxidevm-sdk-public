/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/errors.js (ERR_INVALID_ARG_TYPE and determineSpecificType).
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

const TypeError = globalThis.TypeError;
const read = Reflect.get, negativeZero = Object.is, stringify = JSON.stringify;
export type Inspect = (value: unknown, options: { readonly depth: -1 }) => string;

function text(value: unknown): string {
  if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
  return String(value);
}
function member(value: unknown, key: string): unknown {
  if (value === null || value === undefined) throw new TypeError(`Cannot read properties of ${String(value)} (reading '${key}')`);
  const boxed: unknown = Object(value);
  if (typeof boxed !== "object" && typeof boxed !== "function" || boxed === null) throw new TypeError("Invalid argument description");
  return read(boxed, key);
}
/** Node's description of the value it received, as `determineSpecificType` words it. */
function received(value: unknown, inspect: Inspect): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "function") return `function ${text(read(value, "name"))}`;
  if (typeof value === "object") {
    const hasConstructor = Boolean(read(value, "constructor"));
    if (hasConstructor) {
      const constructor: unknown = read(value, "constructor");
      if (typeof constructor !== "object" && typeof constructor !== "function" || constructor === null) {
        throw new TypeError(`Cannot use 'in' operator to search for 'name' in ${String(constructor)}`);
      }
      if ("name" in constructor) return `an instance of ${text(member(read(value, "constructor"), "name"))}`;
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
  throw new TypeError("Invalid argument type");
}

/** Node's ERR_INVALID_ARG_TYPE for an argument that must be of one type. */
export function invalidArgType(name: string, expected: string, value: unknown, inspect: Inspect): TypeError {
  return Object.assign(new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received(value, inspect)}`), { code: "ERR_INVALID_ARG_TYPE" });
}
