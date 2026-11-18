"use strict";
// Records http.validateHeaderName and http.validateHeaderValue on the pinned Node.js 24.18.1 for
// packages/sdk/src/runtime/workers/assistance/node-http-validators.ts; its output is
// node-http-validators.controls.json. Run with the runtime row of the engine's
// spec/acceleration/artifacts.tsv, through its own musl loader:
//   <root>/lib/ld-musl-x86_64.so.1 --library-path <root>/lib:<root>/usr/lib <root>/usr/bin/node node-http-validators.cjs
const { validateHeaderName, validateHeaderValue } = require("node:http");

const names = [
  ["token", "x-corpus"], ["upper", "Content-Type"], ["symbols", "!#$%&'*+-.^_`|~"], ["digits", "0123456789"],
  ["empty", ""], ["space", "x corpus"], ["leading-space", " x"], ["colon", "x:y"], ["tab", "x\ty"],
  ["newline", "x\ny"], ["nul", "x\u0000"], ["quote", "x\"y"], ["comma", "x,y"], ["slash", "x/y"], ["at", "x@y"],
  ["brackets", "x[y]"], ["latin1", "café"], ["wide", "Ā"], ["emoji", "\u{1f600}"], ["del", "x\u007f"],
  ["long", "x".repeat(300)], ["long-bad", `${"x".repeat(300)} `],
];
const nonStrings = ["undefined", "null", "number", "zero", "nan", "bigint", "boolean", "symbol", "object", "array", "string-object", "function"];
const values = [
  ["plain", "text/html"], ["empty", ""], ["spaces", "  a  b  "], ["tab", "a\tb"], ["cr", "a\rb"], ["lf", "a\nb"],
  ["crlf", "a\r\nb"], ["nul", "a\u0000b"], ["unit-separator", "a\u001fb"], ["del", "a\u007fb"], ["latin1", "café"],
  ["ff", "ÿ"], ["wide", "Ā"], ["emoji", "\u{1f600}"], ["long", "v".repeat(10000)],
];
const valueOthers = ["undefined", "null", "number", "zero", "nan", "negative", "bigint", "boolean", "symbol", "object",
  "array", "array-bad", "array-nested", "array-empty", "string-object", "function", "date"];

function other(label) {
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
    case "function": return function named() { /* a named function */ };
    case "date": return new Date(0);
    default: throw new Error(`Unknown input ${label}`);
  }
}

function outcome(call) {
  try {
    const result = call();
    return { result: result === undefined ? "undefined" : typeof result };
  } catch (error) {
    if (!(error instanceof Error)) return { thrown: typeof error };
    return {
      error: {
        class: Object.getPrototypeOf(error).constructor.name, name: error.name, code: error.code ?? null,
        message: error.message, string: String(error), ownKeys: Reflect.ownKeys(error).filter(key => key !== "stack").map(String),
      },
    };
  }
}

const rows = [];
for (const [label, name] of names) rows.push({ fn: "name", label, input: name, ...outcome(() => validateHeaderName(name)) });
for (const label of nonStrings) rows.push({ fn: "name", label, ...outcome(() => validateHeaderName(other(label))) });
rows.push({ fn: "name", label: "custom-label", input: "x y", ...outcome(() => validateHeaderName("x y", "Custom")) });
rows.push({ fn: "name", label: "no-argument", ...outcome(() => validateHeaderName()) });
for (const [label, value] of values) rows.push({ fn: "value", label, input: value, ...outcome(() => validateHeaderValue("x-corpus", value)) });
for (const label of valueOthers) rows.push({ fn: "value", label, ...outcome(() => validateHeaderValue("x-corpus", other(label))) });
rows.push({ fn: "value", label: "bad-name-good-value", ...outcome(() => validateHeaderValue("x y", "ok")) });
rows.push({ fn: "value", label: "symbol-name-undefined", ...outcome(() => validateHeaderValue(Symbol("n"), undefined)) });
rows.push({ fn: "value", label: "object-name-bad-value", ...outcome(() => validateHeaderValue({}, "a\nb")) });
rows.push({ fn: "value", label: "no-argument", ...outcome(() => validateHeaderValue()) });
rows.push({ fn: "value", label: "symbol-name-bad-value", ...outcome(() => validateHeaderValue(Symbol("n"), "a\nb")) });
rows.push({ fn: "value", label: "object-name-undefined", ...outcome(() => validateHeaderValue({}, undefined)) });
rows.push({ fn: "value", label: "array-name-undefined", ...outcome(() => validateHeaderValue(["a", "b"], undefined)) });
rows.push({ fn: "value", label: "number-name-bad-value", ...outcome(() => validateHeaderValue(-0, "a\nb")) });
rows.push({ fn: "name", label: "negative-zero", ...outcome(() => validateHeaderName(-0)) });
rows.push({ fn: "name", label: "null-prototype", ...outcome(() => validateHeaderName(Object.create(null))) });
rows.push({ fn: "name", label: "nested-object", ...outcome(() => validateHeaderName({ a: { b: { c: 1 } }, d: [1, 2] })) });
rows.push({ fn: "name", label: "object-label", ...outcome(() => validateHeaderName("x y", {})) });
rows.push({ fn: "name", label: "without-stack-trace", ...outcome(() => validateHeaderName.withoutStackTrace("x y")) });
rows.push({ fn: "name", label: "without-stack-trace-ok", ...outcome(() => validateHeaderName.withoutStackTrace("x-corpus")) });
rows.push({ fn: "value", label: "without-stack-trace", ...outcome(() => validateHeaderValue.withoutStackTrace("x", "a\nb")) });
rows.push({ fn: "value", label: "without-stack-trace-undefined", ...outcome(() => validateHeaderValue.withoutStackTrace("x")) });

const describe = fn => {
  const own = Object.getOwnPropertyDescriptor(fn, "withoutStackTrace"), inner = fn.withoutStackTrace;
  return {
    name: fn.name, length: fn.length, prototype: typeof fn.prototype, ownKeys: Reflect.ownKeys(fn).map(String),
    withoutStackTrace: { type: typeof inner, name: inner.name, length: inner.length, prototype: typeof inner.prototype,
      ownKeys: Reflect.ownKeys(inner).map(String), enumerable: own.enumerable, writable: own.writable, configurable: own.configurable },
  };
};
process.stdout.write(`${JSON.stringify({ functions: { validateHeaderName: describe(validateHeaderName), validateHeaderValue: describe(validateHeaderValue) }, rows }, null, 2)}\n`);
