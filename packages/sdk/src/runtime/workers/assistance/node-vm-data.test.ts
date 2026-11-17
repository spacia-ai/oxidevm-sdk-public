import * as native from "node:vm";
import { expect, it } from "vitest";
import { ExecutableSources } from "./executable-sources.js";
import { evaluateContextData } from "./node-vm-data.js";

it("matches Node's data-script completion and mutations without changing process globals", () => {
  const source = 'globalThis.records = globalThis.records || {}; globalThis.records["route"] = { id: 7, enabled: true, token: process.env.TOKEN };';
  const expected = { process: { env: { TOKEN: "value" } } }, actual = { process: { env: { TOKEN: "value" } } };
  const result: unknown = native.runInNewContext(source, expected);
  const received = evaluateContextData(source, actual, "/manifest.js", new ExecutableSources());
  expect(received).toEqual(result); expect(actual).toEqual(expected);
  expect(Object.hasOwn(globalThis, "records")).toBe(false);
});

it("rejects programs and non-data contexts before any assignment runs", () => {
  const context = { marker: 0 }, sources = new ExecutableSources();
  for (const source of [
    'globalThis.marker = 1; globalThis.marker = (() => 2)();',
    'globalThis.marker = 1; globalThis.constructor.constructor("return self")();',
    'globalThis.marker = 1; globalThis["__proto__"].changed = true;',
    'globalThis.marker = 1; fetch("https://example.invalid");',
    'globalThis.marker = 1; while (true) {}',
  ]) { expect(() => evaluateContextData(source, context, "/data.js", sources)).toThrow(/data scripts/u); expect(context.marker).toBe(0); }
  expect(() => evaluateContextData('globalThis.marker = 1', { getter: () => 1 }, "/data.js", sources)).toThrow(/data scripts/u);
});

it("preserves completion values around empty statements and directives", () => {
  for (const source of ['globalThis.value = 42; ;', '"data only"; ;', ';']) {
    expect(evaluateContextData(source, {}, "/data.js", new ExecutableSources())).toEqual(native.runInNewContext(source, {}));
  }
});

it("refuses inherited functions and object coercion inside data programs", () => {
  for (const source of ['globalThis.output = globalThis.value.toString;', 'globalThis.output = "x".slice;', 'globalThis.output = +globalThis.value;']) {
    expect(() => evaluateContextData(source, { value: {} }, "/data.js", new ExecutableSources())).toThrow(/data scripts/u);
  }
});

/** A value from another V8 context compared by content: its RegExp is not this realm's RegExp. */
function plain(value: unknown): unknown {
  if (Object.prototype.toString.call(value) === "[object RegExp]") return `regexp ${String(value)}`;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]): [string, unknown] => [key, plain(entry)]));
  return value;
}

it("serves a called function that only returns data, the form of webpack's magic comments", () => {
  for (const comment of ['webpackChunkName: "page", webpackMode: "lazy"', 'webpackInclude: /\\.json$/i, webpackExports: ["a", "b"], webpackIgnore: true', ""]) {
    const source = `(function(){return {${comment}};})()`;
    const expected: unknown = native.runInContext(source, native.createContext(undefined));
    expect(plain(evaluateContextData(source, {}, "/comment.js", new ExecutableSources()))).toEqual(plain(expected));
  }
});

it("refuses a called function that does more than return data", () => {
  for (const source of ['(function(){fetch("https://example.invalid");return {};})()', "(function(a){return {a};})()", "(async function(){return {};})()", "(function*(){return {};})()",
    "(function(){return {};})(1)", "(function named(){return named;})()", "(function(){return this;})()", "(function(){return arguments;})()", "(function(){return {};})()();"]) {
    expect(() => evaluateContextData(source, {}, "/comment.js", new ExecutableSources())).toThrow(/data scripts/u);
  }
});
