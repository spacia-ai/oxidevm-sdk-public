/*!
 * Portions adapted from Node.js v24.18.1 lib/_http_common.js (checkIsHttpToken, checkInvalidHeaderChar),
 * lib/_http_outgoing.js (validateHeaderName, validateHeaderValue) and lib/internal/errors.js
 * (ERR_INVALID_HTTP_TOKEN, ERR_HTTP_INVALID_HEADER_VALUE, ERR_INVALID_CHAR).
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

/** Node's `%s` formatting (`util.format`), which its coded error messages use. */
export type Format = (template: string, ...values: unknown[]) => string;

const TOKEN = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/u;
const INVALID_HEADER_CHARACTER = /[^\t\x20-\x7e\x80-\xff]/u;

/** Ordinary ToString, as an implicit conversion applies it: a Symbol throws rather than printing. */
function implicitString(value: unknown): string {
  if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
  return String(value);
}

/** The label is Node's default parameter: an undefined label means "Header name", as when it is left out. */
function arguments_(name: unknown, label: unknown): unknown[] { return label === undefined ? [name] : [name, label]; }

/** Node's coded TypeError: prints as `TypeError [CODE]: message`, in its stack too. */
class CodedTypeError extends TypeError {
  declare readonly code: string;
  constructor(code: string, message: string, codeFirst: boolean) {
    super();
    if (codeFirst) Object.defineProperty(this, "code", { value: code, enumerable: true, writable: true, configurable: true });
    Object.defineProperty(this, "message", { value: message, enumerable: false, writable: true, configurable: true });
    if (!codeFirst) Object.defineProperty(this, "code", { value: code, enumerable: true, writable: true, configurable: true });
    // As Node does: the stack's first line names the code, while `name` stays "TypeError".
    Object.defineProperty(this, "name", { value: `TypeError [${code}]`, writable: true, configurable: true });
    void this.stack;
    Reflect.deleteProperty(this, "name");
  }
  override toString(): string { return `${this.name} [${this.code}]: ${this.message}`; }
}
Object.defineProperty(CodedTypeError, "name", { value: "TypeError" });

/** `http.validateHeaderName` and `http.validateHeaderValue` as pinned Node 24.18.1 has them. */
export function createHttpValidators(format: Format): {
  validateHeaderName: (name?: unknown, label?: unknown) => void;
  validateHeaderValue: (name?: unknown, value?: unknown) => void;
} {
  // Node declares both with default or rest-free parameters that report a length of zero.
  const validateHeaderName = function validateHeaderName(...values: unknown[]): void {
    const [name, label = "Header name"] = values;
    if (typeof name !== "string" || name === "" || !TOKEN.test(name)) {
      throw new CodedTypeError("ERR_INVALID_HTTP_TOKEN", format('%s must be a valid HTTP token ["%s"]', label, name), false);
    }
  };
  const validateHeaderValue = function validateHeaderValue(...values: unknown[]): void {
    const [name, value] = values;
    if (value === undefined) throw new CodedTypeError("ERR_HTTP_INVALID_HEADER_VALUE", format('Invalid value "%s" for header "%s"', value, name), false);
    if (INVALID_HEADER_CHARACTER.test(implicitString(value))) {
      throw new CodedTypeError("ERR_INVALID_CHAR", `Invalid character in header content ["${implicitString(name)}"]`, true);
    }
  };
  // Node's hideStackFrames wrappers also expose the unwrapped check as an enumerable `withoutStackTrace`, an anonymous
  // arrow function of two parameters. Array elements, unlike object literal properties, give an arrow no name.
  const [nameCheck, valueCheck] = [
    (name: unknown, label: unknown) => { validateHeaderName(...arguments_(name, label)); },
    (name: unknown, value: unknown) => { validateHeaderValue(name, value); },
  ];
  Object.defineProperty(validateHeaderName, "withoutStackTrace", { value: nameCheck, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(validateHeaderValue, "withoutStackTrace", { value: valueCheck, enumerable: true, writable: true, configurable: true });
  return { validateHeaderName, validateHeaderValue };
}
