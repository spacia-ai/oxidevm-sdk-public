import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { createNodeUtil } from "./node-util.js";
import { createHttpValidators } from "./node-http-validators.js";

const control = record(JSON.parse(readFileSync(new URL("./node-http-validators.controls.json", import.meta.url), "utf8")), "http validator controls");
const recorder = fileURLToPath(new URL("../../../../../../tests/fixtures/assistance/node-http-validators.cjs", import.meta.url));
const util = createNodeUtil({ noDeprecation: false, emitWarning() {} });
const format: unknown = Reflect.get(util, "format");
if (typeof format !== "function") throw new Error("Missing util.format");
const { validateHeaderName, validateHeaderValue } = createHttpValidators((template, ...values) => {
  const text: unknown = Reflect.apply(format, util, [template, ...values]);
  if (typeof text !== "string") throw new Error("util.format returned no string");
  return text;
});

function named() { /* a named function */ }
/** Node prints a function's source text. The test compiler reformats this file, so the function row expects the
 * source text this copy of the function has in place of the recorder's, and compares everything else unchanged. */
const RECORDED_SOURCE = "function named() { /* a named function */ }";
function localized(expected: unknown): unknown {
  return JSON.parse(JSON.stringify(expected).split(JSON.stringify(RECORDED_SOURCE).slice(1, -1)).join(JSON.stringify(String(named)).slice(1, -1)));
}
/** The recorder's inputs that a JSON row cannot carry, by label. */
function other(label: string): unknown {
  switch (label) {
    case "undefined": return undefined;
    case "null": return null;
    case "number": return 1;
    case "zero": return 0;
    case "nan": return NaN;
    case "negative": return -1.5;
    case "bigint": return 1n;
    case "boolean": return true;
    case "symbol": return Symbol("x");
    case "object": return {};
    case "array": return ["a", "b"];
    case "array-bad": return ["a", "b\nc"];
    case "array-nested": return [["a"], "b"];
    case "array-empty": return [];
    case "string-object": return Object("x-corpus");
    case "function": return named;
    case "date": return new Date(0);
    default: throw new Error(`Unknown input ${label}`);
  }
}
/** A validator's `withoutStackTrace` check. */
function unwrapped(validator: (...values: unknown[]) => void): (...values: unknown[]) => void {
  const inner: unknown = Reflect.get(validator, "withoutStackTrace");
  if (typeof inner !== "function") throw new Error(`${validator.name} has no withoutStackTrace`);
  return (...values) => { Reflect.apply(inner, undefined, values); };
}
/** The calls the recorder makes without a plain input. */
const special = new Map<string, () => void>([
  ["name/custom-label", () => { validateHeaderName("x y", "Custom"); }],
  ["name/no-argument", () => { validateHeaderName(); }],
  ["name/negative-zero", () => { validateHeaderName(-0); }],
  ["name/null-prototype", () => { validateHeaderName(Object.create(null)); }],
  ["name/nested-object", () => { validateHeaderName({ a: { b: { c: 1 } }, d: [1, 2] }); }],
  ["name/object-label", () => { validateHeaderName("x y", {}); }],
  ["value/bad-name-good-value", () => { validateHeaderValue("x y", "ok"); }],
  ["value/symbol-name-undefined", () => { validateHeaderValue(Symbol("n"), undefined); }],
  ["value/object-name-bad-value", () => { validateHeaderValue({}, "a\nb"); }],
  ["value/no-argument", () => { validateHeaderValue(); }],
  ["value/symbol-name-bad-value", () => { validateHeaderValue(Symbol("n"), "a\nb"); }],
  ["value/object-name-undefined", () => { validateHeaderValue({}, undefined); }],
  ["value/array-name-undefined", () => { validateHeaderValue(["a", "b"], undefined); }],
  ["value/number-name-bad-value", () => { validateHeaderValue(-0, "a\nb"); }],
  ["name/without-stack-trace", () => { unwrapped(validateHeaderName)("x y"); }],
  ["name/without-stack-trace-ok", () => { unwrapped(validateHeaderName)("x-corpus"); }],
  ["value/without-stack-trace", () => { unwrapped(validateHeaderValue)("x", "a\nb"); }],
  ["value/without-stack-trace-undefined", () => { unwrapped(validateHeaderValue)("x"); }],
]);

function outcome(call: () => void): Record<string, unknown> {
  try {
    call();
    return { result: "undefined" };
  } catch (error) {
    if (!(error instanceof Error)) return { thrown: typeof error };
    const prototype: unknown = Object.getPrototypeOf(error);
    const constructor: unknown = typeof prototype === "object" && prototype !== null ? Reflect.get(prototype, "constructor") : undefined;
    const code: unknown = Reflect.get(error, "code");
    return {
      error: {
        class: typeof constructor === "function" ? constructor.name : null, name: error.name, code: code ?? null,
        message: error.message, string: String(error), ownKeys: Reflect.ownKeys(error).filter(key => key !== "stack").map(String),
      },
    };
  }
}

it("replays the recorder the controls came from", () => {
  expect(createHash("sha256").update(readFileSync(recorder)).digest("hex")).toBe(control["recorderSHA256"]);
  expect(record(control["node"], "pinned Node")).toEqual({ binarySHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", version: "v24.18.1" });
});

it("validates header names and values exactly as pinned Node, error codes, messages and key order included", () => {
  const describe = (fn: (...values: unknown[]) => void) => {
    const own = Object.getOwnPropertyDescriptor(fn, "withoutStackTrace"), inner: unknown = own?.value;
    if (typeof inner !== "function") throw new Error(`${fn.name} has no withoutStackTrace`);
    return {
      name: fn.name, length: fn.length, prototype: typeof Reflect.get(fn, "prototype"), ownKeys: Reflect.ownKeys(fn).map(String),
      withoutStackTrace: { type: typeof inner, name: inner.name, length: inner.length, prototype: typeof Reflect.get(inner, "prototype"),
        ownKeys: Reflect.ownKeys(inner).map(String), enumerable: own?.enumerable, writable: own?.writable, configurable: own?.configurable },
    };
  };
  expect({ validateHeaderName: describe(validateHeaderName), validateHeaderValue: describe(validateHeaderValue) }).toEqual(control["functions"]);
  const rows = control["rows"];
  if (!Array.isArray(rows) || rows.length !== 84) throw new Error("Incomplete http validator controls");
  for (const value of rows) {
    const row = record(value, "http validator control"), fn = row["fn"], label = row["label"];
    if ((fn !== "name" && fn !== "value") || typeof label !== "string") throw new Error("Malformed http validator control");
    const validate = fn === "name" ? validateHeaderName : validateHeaderValue;
    const call = special.get(`${fn}/${label}`)
      ?? ("input" in row ? (fn === "name" ? () => { validateHeaderName(row["input"]); } : () => { validateHeaderValue("x-corpus", row["input"]); })
        : fn === "name" ? () => { validate(other(label)); } : () => { validate("x-corpus", other(label)); });
    const expected = Object.fromEntries(Object.entries(row).filter(([key]) => key !== "input"));
    expect({ fn, label, ...outcome(call) }, `${fn}/${label}`).toEqual(label === "function" ? localized(expected) : expected);
  }
});

it("prints the code in the stack's first line while the error's name stays TypeError", () => {
  try {
    validateHeaderName("x y");
    throw new Error("validateHeaderName accepted an invalid token");
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    expect(error.name).toBe("TypeError");
    expect(error.stack?.split("\n")[0]).toBe('TypeError [ERR_INVALID_HTTP_TOKEN]: Header name must be a valid HTTP token ["x y"]');
  }
});
