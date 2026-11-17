import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import * as compilerNamespace from "@swc/wasm-web";
import { initializeCompiler, transformSource } from "./compiler.js";
import { createLocalModuleLoader } from "./module-loader.js";
import { installGeneratedFunctions } from "./generated-functions.js";
import { SourceMap } from "./node-source-map.js";

it("lowers async methods containing a nested function inside an accessor into valid JavaScript", async () => {
  const root = dirname(createRequire(import.meta.url).resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const source = `class Example {
    async run() {
      let value = await Promise.resolve(42), other = (function() {
        return { get result() { return (function() { return this; }).call(this); } };
      })();
      if (other.result !== other) throw Error("Accessor receiver changed");
      return value;
    }
  }`;
  const transformed = transformSource(compiler, source, "commonjs", "/example.cjs");
  const evaluate: unknown = Reflect.apply(Function, undefined, [`${transformed.code}\nreturn new Example().run();`]);
  if (typeof evaluate !== "function") throw new Error("Missing evaluator");
  await expect(Reflect.apply(evaluate, undefined, [])).resolves.toBe(42);
});

it("preserves results from async callbacks that call super in CommonJS and ESM", async () => {
  const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const body = `const marker = new Error('expected rejection');
    class Parent { async value(value) { await Promise.resolve();
      if (this.name !== 'child') throw new Error('receiver changed');
      if (value < 0) throw marker; return value;
    } }
    class Child extends Parent { name = 'child'; async run(value) {
      const invoke = fn => fn();
      return await invoke(async () => { await Promise.resolve(); return await super.value(arguments[0]); });
    } }
    const result = Promise.all([new Child().run(42), new Child().run(-1).catch(error => error === marker)]);`;
  const loader = createLocalModuleLoader(compiler, await readFile(require.resolve("systemjs/dist/s.js"), "utf8"), {
    resolve: path => path,
    read: path => ({ format: path.endsWith(".mjs") ? "module" : "commonjs", source: body + (path.endsWith(".mjs") ? "export { result };" : "module.exports = result;") }),
  });
  await expect(loader.require("/example.cjs")).resolves.toEqual([42, true]);
  await expect((await loader.import("/example.mjs"))["result"]).resolves.toEqual([42, true]);
  const realm = { Function, eval: globalThis.eval };
  const restore = installGeneratedFunctions(compiler, realm);
  try {
    const evaluate: unknown = Reflect.apply(realm.Function, undefined, [body + "return result;"]);
    if (typeof evaluate !== "function") throw new Error("Missing generated function");
    await expect(Reflect.apply(evaluate, undefined, [])).resolves.toEqual([42, true]);
  } finally { restore(); }
});

it("retains original source content for the pinned compiler budget", async () => {
  const root = dirname(createRequire(import.meta.url).resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  for (const source of ["// original comment\nmodule.exports=17;", "module.exports='\\u0000\\ud800';", "/*" + "x".repeat(65536) + "*/module.exports=19;"]) {
    const transformed = transformSource(compiler, source, "commonjs", "/budget.cjs");
    const payload: unknown = JSON.parse(transformed.map);
    expect(payload).toMatchObject({sourcesContent:[source]});
    expect(transformed.map.length).toBeGreaterThanOrEqual(source.length);
  }
});

it("tells scripts that declare global bindings from scripts that do not (ADR 0026, 2.12)", async () => {
  const root = dirname(createRequire(import.meta.url).resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const none = ["40 + 2", "", "'use strict'; this", "1; if (false) 2;", "{ let scoped = 1; scoped }", "for (const item of [1]) item;",
    "(function named() { var inner = 1; function local() {} return inner; })()", "(() => { var inner = 1; return inner; })()",
    "globalThis.x = 1", "eval('var y = 1')", "({ method() { var z; } })", "({ get value() { var g; return g; }, set value(v) { var s = v; } })", "(class { static { var w; } })", "try { 1 } catch (error) { let e = error; }"];
  const declares = ["var a = 1", "let b = 1", "const c = 1", "class D {}", "function e() {}", "if (true) { var f = 1; }",
    "{ function g() {} }", "for (var h = 0; h < 1; h++);", "for (var i in {});", "l: { var j; }", "'use strict'; var k = 1", "switch (1) { case 1: var m; }"];
  for (const source of none) expect(compiler.scriptBindings(source), source).toBe("none");
  for (const source of declares) expect(compiler.scriptBindings(source), source).toBe("global");
  expect(compiler.scriptBindings("1 +")).toBe("unparsed");
});

it("keeps empty async-generator expressions native for intrinsic inspection", async () => {
  const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const source = "const empty = async function*() {}; const named = async function* named() {}; const result = [empty, named, Object.getPrototypeOf(Object.getPrototypeOf(empty).prototype)];";
  const transformed = transformSource(compiler, source, "commonjs", "/intrinsics.cjs");
  const evaluate: unknown = Reflect.apply(Function, undefined, [transformed.code + "\nreturn result;"]);
  if (typeof evaluate !== "function") throw new Error("Missing evaluator");
  const actual: unknown = Reflect.apply(evaluate, undefined, []);
  if (!Array.isArray(actual)) throw new Error("Missing generator observations");
  const functionPrototype: unknown = Object.getPrototypeOf(async function* () {});
  if ((typeof functionPrototype !== "object" && typeof functionPrototype !== "function") || functionPrototype === null) throw new Error("Missing native generator prototype");
  const generatorPrototype: unknown = Reflect.get(functionPrototype, "prototype");
  const prototype: unknown = Object.getPrototypeOf(generatorPrototype);
  expect(actual[2]).toBe(prototype);
  for (const [index, name] of ["empty", "named"].entries()) {
    const fn: unknown = actual[index];
    if (typeof fn !== "function") throw new Error("Missing generator function");
    expect(fn.name).toBe(name);
    expect(Object.getPrototypeOf(fn)).toBe(functionPrototype);
    const iterator: unknown = Reflect.apply(fn, undefined, []);
    if (typeof iterator !== "object" || iterator === null || !("next" in iterator) || typeof iterator.next !== "function") throw new Error("Missing async iterator");
    await expect(Reflect.apply(iterator.next, iterator, [])).resolves.toEqual({ value: undefined, done: true });
  }
});

it("preserves script parsing and composes source locations around native generator expressions", async () => {
  const root = dirname(createRequire(import.meta.url).resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const source = "const empty = async /* comment */ function*() {};\nwith ({answer: 42}) { globalThis.answer = answer; }\nthrow new Error('marker');";
  const transformed = transformSource(compiler, source, "commonjs", "/coordinates.cjs");
  const line = transformed.code.split("\n").findIndex(line => line.includes("throw new Error"));
  expect(line).toBeGreaterThan(-1);
  const payload: unknown = JSON.parse(transformed.map);
  expect(payload).toMatchObject({ sourcesContent: [source] });
  expect(new SourceMap(payload).findEntry(line, 0)).toMatchObject({ originalSource: "/coordinates.cjs", originalLine: 2, originalColumn: 0 });
});

it.each(["async/**/function*", "async function/**/ *", "async function// comment\n*"])("retains native empty generators with separated tokens: %s", async tokens => {
  const root = dirname(createRequire(import.meta.url).resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const transformed = transformSource(compiler, `const empty = ${tokens}() {};`, "commonjs", "/comments.cjs");
  const evaluate: unknown = Reflect.apply(Function, undefined, [transformed.code + "\nreturn empty;"]);
  if (typeof evaluate !== "function") throw new Error("Missing evaluator");
  const fn: unknown = Reflect.apply(evaluate, undefined, []);
  if (typeof fn !== "function") throw new Error("Missing native generator");
  expect(Object.getPrototypeOf(fn)).toBe(Object.getPrototypeOf(async function* () {}));
});

it("keeps empty async functions and arrows native, so a program reaches the AsyncFunction constructor", async () => {
  const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const source = "const empty = async function() {}; const result = [empty, async () => {}, async function() {}.constructor, async function work() { await 1; }];";
  for (const format of ["commonjs", "module"] as const) {
    const transformed = transformSource(compiler, source, format, "/intrinsics.js");
    expect(transformed.code.replaceAll(/\s+/gu, "")).toContain("asyncfunction(){}.constructor");
  }
  const transformed = transformSource(compiler, source, "commonjs", "/intrinsics.cjs");
  const evaluate: unknown = Reflect.apply(Function, undefined, [transformed.code + "\nreturn result;"]);
  if (typeof evaluate !== "function") throw new Error("Missing evaluator");
  const actual: unknown = Reflect.apply(evaluate, undefined, []);
  if (!Array.isArray(actual)) throw new Error("Missing function observations");
  const native: unknown = Object.getPrototypeOf(async () => { await Promise.resolve(); });
  if (typeof native !== "object" || native === null) throw new Error("Missing native async prototype");
  const observed: readonly unknown[] = actual, [empty, arrow, constructor, work] = observed;
  if (typeof empty !== "function") throw new Error("Missing empty async function");
  expect(Object.getPrototypeOf(empty)).toBe(native);
  expect(empty.name).toBe("empty");
  expect(Object.getPrototypeOf(arrow)).toBe(native);
  expect(constructor).toBe(Reflect.get(native, "constructor"));
  // A function with a body is still lowered.
  expect(Object.getPrototypeOf(work)).toBe(Function.prototype);
});
