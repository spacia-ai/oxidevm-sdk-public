import { expect, it } from "vitest";
import { installCallSites } from "./call-sites.ts";

type Capture = (target: unknown, above?: unknown) => void;

/** A realm whose Error behaves like SpiderMonkey's or JavaScriptCore's: `stack` is text in the
 * `function@url:line:column` form and nothing calls `prepareStackTrace`. */
function foreignRealm(stack: string): { readonly Error: object; readonly capture: Capture } {
  class ForeignError {
    readonly stack = stack;
    static captureStackTrace(target: object): void { Reflect.set(target, "stack", stack); }
  }
  return { Error: ForeignError, capture: (target, above) => { Reflect.apply(method(ForeignError, "captureStackTrace"), ForeignError, [target, above]); } };
}

function method(value: unknown, name: string): (...args: unknown[]) => unknown {
  const fn: unknown = typeof value === "object" && value !== null || typeof value === "function" ? Reflect.get(value, name) : undefined;
  if (typeof fn !== "function") throw new TypeError(`Missing method ${name}`);
  return (...args) => { const result: unknown = Reflect.apply(fn, value, args); return result; };
}

/** The frames a program's `prepareStackTrace` receives, read through the named call-site methods. */
function captured(realm: { readonly Error: object; readonly capture: Capture }, names: readonly string[]): unknown[][] {
  Reflect.set(realm.Error, "prepareStackTrace", (_error: unknown, frames: unknown) => frames);
  const target = {};
  realm.capture(target);
  const frames: unknown = Reflect.get(target, "stack");
  if (!Array.isArray(frames)) throw new TypeError("No structured frames");
  const sites: readonly unknown[] = frames;
  return sites.map(site => names.map(name => method(site, name)()));
}

const SPIDERMONKEY = [
  "captureStackTrace@http://localhost:1/assets/process.worker.js:1:10",
  "getStack@oxidevm:compiled/12/%2Fworkspace%2Fnode_modules%2Fdepd%2Findex.js:392:9",
  "depd@oxidevm:compiled/12/%2Fworkspace%2Fnode_modules%2Fdepd%2Findex.js:111:30",
  "@oxidevm:compiled/11/%2Fworkspace%2Fnode_modules%2Fhttp-errors%2Findex.js:17:32",
  "async*load@http://localhost:1/assets/process.worker.js:597:13253",
  "forEach@[native code]",
  "",
].join("\n");
const DEPD = "oxidevm:compiled/12/%2Fworkspace%2Fnode_modules%2Fdepd%2Findex.js";
const HTTP_ERRORS = "oxidevm:compiled/11/%2Fworkspace%2Fnode_modules%2Fhttp-errors%2Findex.js";

it("leaves a V8 realm's native call sites alone", () => {
  const capture = Object.getOwnPropertyDescriptor(Error, "captureStackTrace"), prepare = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  const restore = installCallSites(globalThis);
  expect(Object.getOwnPropertyDescriptor(Error, "captureStackTrace")).toEqual(capture);
  expect(Object.getOwnPropertyDescriptor(Error, "prepareStackTrace")).toEqual(prepare);
  restore();
  expect(Object.getOwnPropertyDescriptor(Error, "captureStackTrace")).toEqual(capture);
});

it("hands structured frames to prepareStackTrace in a realm without V8 call sites", () => {
  const realm = foreignRealm(SPIDERMONKEY), restore = installCallSites(realm);
  expect(captured(realm, ["getFunctionName", "getFileName", "getLineNumber", "getColumnNumber", "isAsync", "isNative", "getEvalOrigin", "toString"])).toEqual([
    ["getStack", DEPD, 392, 9, false, false, undefined, `getStack (${DEPD}:392:9)`],
    ["depd", DEPD, 111, 30, false, false, undefined, `depd (${DEPD}:111:30)`],
    [null, HTTP_ERRORS, 17, 32, false, false, undefined, `${HTTP_ERRORS}:17:32`],
    ["load", "http://localhost:1/assets/process.worker.js", 597, 13253, true, false, undefined, "async load (http://localhost:1/assets/process.worker.js:597:13253)"],
    ["forEach", null, null, null, false, true, undefined, "forEach (native)"],
  ]);
  restore();
  expect(Reflect.get(realm.Error, "stackTraceLimit")).toBeUndefined();
  const target = {};
  realm.capture(target);
  expect(Reflect.get(target, "stack")).toBe(SPIDERMONKEY);
});

it("follows V8 for the default format, the frame limit and the constructor argument", () => {
  const realm = foreignRealm(SPIDERMONKEY);
  installCallSites(realm);
  expect(Reflect.get(realm.Error, "stackTraceLimit")).toBe(10);
  const target = { name: "Deprecation", message: "old" };
  Reflect.set(realm.Error, "stackTraceLimit", 2);
  function depd(): void { /* Only its name matters: frames up to and including it are left out. */ }
  realm.capture(target, depd);
  const text = ["Deprecation: old", `    at ${HTTP_ERRORS}:17:32`, "    at async load (http://localhost:1/assets/process.worker.js:597:13253)"].join("\n");
  expect(Object.getOwnPropertyDescriptor(target, "stack")).toEqual({ value: text, writable: true, enumerable: false, configurable: true });
  Reflect.set(realm.Error, "stackTraceLimit", 0);
  realm.capture(target);
  expect(Reflect.get(target, "stack")).toBe("Deprecation: old");
  expect(() => { realm.capture(undefined); }).toThrow(TypeError);
});

it("reads JavaScriptCore and evaluated-code frame forms", () => {
  const realm = foreignRealm(["captureStackTrace@http://h/a.js:1:1", "global code@http://h/b.js:3:4", "eval code@", "http://h/c.js:5:6", "f@http://h/d.js line 370 > eval:13:24"].join("\n"));
  installCallSites(realm);
  expect(captured(realm, ["getFunctionName", "getFileName", "getLineNumber", "isToplevel", "isEval"])).toEqual([
    [null, "http://h/b.js", 3, true, false],
    [null, null, null, false, true],
    [null, "http://h/c.js", 5, true, false],
    ["f", "http://h/d.js", 13, false, true],
  ]);
});
