import { expect, it } from "vitest";
import { createNodeUtil, nodeUtil } from "./node-util.js";

it("deprecates Webpack hooks once per code while preserving receiver and constructor identity", () => {
  const warnings: unknown[][] = [];
  const process = { noDeprecation: false, emitWarning: (...args: unknown[]) => { warnings.push(args); } };
  const util = createNodeUtil(process);
  function method(this: { value: number }, extra: number) { return this.value + extra; }
  const wrapped = util.deprecate(method, "old hook", "DEP_HOOK");
  expect(Reflect.apply(wrapped, { value: 40 }, [2])).toBe(42);
  Reflect.apply(wrapped, { value: 1 }, [2]);
  util.deprecate(() => undefined, "another hook", "DEP_HOOK")();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.slice(0, 3)).toEqual(["old hook", "DeprecationWarning", "DEP_HOOK"]);
  expect(wrapped.length).toBe(method.length);
  expect(Object.getPrototypeOf(wrapped)).toBe(method);
  class Original { value = 42; getValue() { return this.value; } }
  const constructor = util.deprecate(Original, "old class");
  const instance: unknown = Reflect.construct(constructor, []);
  expect(instance).toBeInstanceOf(Original);
  expect(instance).toBeInstanceOf(constructor);
  process.noDeprecation = true;
  const suppressed = util.deprecate(() => 42, "temporarily suppressed");
  expect(suppressed()).toBe(42);
  const count = warnings.length;
  process.noDeprecation = false;
  suppressed();
  expect(warnings).toHaveLength(count + 1);
  const untouched = util.deprecate(method, "unmodified wrapper", undefined, { modifyPrototype: false });
  expect(Object.getPrototypeOf(untouched)).toBe(Function.prototype);
  expect(() => util.deprecate(method, "invalid", 42)).toThrow(TypeError);
});

it("inherits prototypes without replacing child methods or inheriting static properties", () => {
  class Parent { static label = "parent"; value() { return 42; } }
  class Child { own() { return "child"; } }
  const prototype = Child.prototype;
  nodeUtil.inherits(Child, Parent);
  expect(Child.prototype).toBe(prototype);
  expect(Object.getPrototypeOf(prototype)).toBe(Parent.prototype);
  expect(new Child()).toBeInstanceOf(Parent);
  expect(new Child().own()).toBe("child");
  expect(Object.hasOwn(Child, "label")).toBe(false);
  expect(Object.getOwnPropertyDescriptor(Child, "super_")).toEqual({ value: Parent, writable: true, configurable: true, enumerable: false });
  for (const [child, parent] of [[undefined, Parent], [Child, null], [Child, {}]]) {
    let failure: unknown;
    try { nodeUtil.inherits(child, parent); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
  }
  const shape = { prototype: {} };
  nodeUtil.inherits(shape, { prototype: null });
  expect(Object.getPrototypeOf(shape.prototype)).toBeNull();
  expect(() => nodeUtil.inherits(Object.freeze({ prototype: {} }), Parent)).toThrow(TypeError);
});

it("formats cycles, collections and custom inspection with Node identities", () => {
  const cycle: { label: string; self?: unknown } = { label: "root" }; cycle.self = cycle;
  expect(nodeUtil.inspect(cycle)).toBe("<ref *1> { label: 'root', self: [Circular *1] }");
  expect(nodeUtil.format("%s %d %j", "item", 3, { ok: true })).toBe('item 3 {"ok":true}');
  expect(nodeUtil.inspect(new Map([["key", 2]]))).toBe("Map(1) { 'key' => 2 }");
  const custom = { [Symbol.for("nodejs.util.inspect.custom")]: () => "CUSTOM" };
  expect(nodeUtil.inspect({ custom })).toBe("{ custom: CUSTOM }");
  expect(Reflect.get(nodeUtil.inspect, "custom")).toBe(Symbol.for("nodejs.util.inspect.custom"));
});

it("parses the token form used by Next without rewriting its arguments", () => {
  expect(nodeUtil.parseArgs({ args: ["--inspect=127.0.0.1:9229", "--trace-warnings"], strict: false, tokens: true })).toEqual({
    values: { inspect: "127.0.0.1:9229", "trace-warnings": true }, positionals: [],
    tokens: [
      { kind: "option", name: "inspect", rawName: "--inspect", index: 0, value: "127.0.0.1:9229", inlineValue: true },
      { kind: "option", name: "trace-warnings", rawName: "--trace-warnings", index: 1, value: undefined, inlineValue: undefined },
    ],
  });
  expect(() => nodeUtil.parseArgs({ args: ["--unknown"], strict: true })).toThrow();
  expect(() => nodeUtil.parseArgs({ args: [], allowNegative: true })).toThrow(/util.parseArgs.*allowNegative/u);
  expect(() => nodeUtil.parseArgs({ args: [], allowNegative: "yes" })).toThrow(TypeError);
});

it("promisifies callbacks with the receiver, rejection and shared custom symbol", async () => {
  const receiver = { value: 9 };
  const original = function (this: typeof receiver, argument: unknown, done: (error: unknown, value?: unknown) => void) {
    done(null, [this.value, argument]);
  };
  const wrapped = nodeUtil.promisify(original);
  await expect(Reflect.apply(wrapped, receiver, ["argument"])).resolves.toEqual([9, "argument"]);
  expect(nodeUtil.promisify(wrapped)).toBe(wrapped);
  const failure = new Error("callback failed");
  await expect(nodeUtil.promisify((done: (error: unknown) => void) => done(failure))()).rejects.toBe(failure);
  await expect(nodeUtil.promisify(() => { throw failure; })()).rejects.toBe(failure);
  await expect(nodeUtil.promisify((done: (error: unknown) => void) => done("callback-value"))()).rejects.toBe("callback-value");
  const custom = () => Promise.resolve("custom");
  Object.defineProperty(original, Symbol.for("nodejs.util.promisify.custom"), { value: custom });
  expect(nodeUtil.promisify(original)).toBe(custom);
  expect(Reflect.get(nodeUtil.promisify, "custom")).toBe(Symbol.for("nodejs.util.promisify.custom"));
  expect(() => nodeUtil.promisify(3)).toThrow();
});

it("util.types classifies values like Node", () => {
  const util = createNodeUtil({ noDeprecation: false, emitWarning: () => undefined });
  const types = util.types;
  expect(types.isDate(new Date())).toBe(true);
  expect(types.isUint8Array(new Uint8Array(0))).toBe(true);
  expect(types.isPromise({})).toBe(false);
});

it("util.debuglog logs a section only when NODE_DEBUG selects it, and callbackify/toUSVString/isDeepStrictEqual follow Node", async () => {
  const lines: string[] = [];
  const util = createNodeUtil({ noDeprecation: false, emitWarning: () => undefined, env: { NODE_DEBUG: "undici,http*" } }, line => { lines.push(line); });
  const undici = util.debuglog("undici");
  const http2 = util.debuglog("HTTP2");
  const silent = util.debuglog("stream");
  expect(undici.enabled).toBe(true);
  expect(http2.enabled).toBe(true);
  expect(silent.enabled).toBe(false);
  undici("connected %s", "host");
  silent("never");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^UNDICI \d+: connected host$/u);
  expect(util.toUSVString("a\ud800b")).toBe("a�b");
  expect(util.isDeepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
  expect(util.isDeepStrictEqual({ a: 1 }, { a: "1" })).toBe(false);
  const callback = util.callbackify((value: number) => Promise.resolve(value * 2));
  const result = await new Promise<unknown>((resolve, reject) => { callback(21, (error: unknown, value: unknown) => { if (error === null) resolve(value); else reject(error instanceof Error ? error : new Error("callbackify rejected")); }); });
  expect(result).toBe(42);
});
