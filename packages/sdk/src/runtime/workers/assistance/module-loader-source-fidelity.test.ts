import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {dirname, join} from "node:path";
import {beforeAll, expect, it, vi} from "vitest";
import * as compilerNamespace from "@swc/wasm-web";
import {initializeCompiler, type AssistanceCompiler} from "./compiler.js";
import {createLocalModuleLoader} from "./module-loader.js";
import type * as ModuleLoader from "./module-loader.js";

let compiler: AssistanceCompiler | undefined, systemSource = "";
beforeAll(async () => {
  const load = createRequire(import.meta.url), root = dirname(load.resolve("@swc/wasm-web"));
  compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  systemSource = await readFile(load.resolve("systemjs/dist/s.js"), "utf8");
});

it("uses compiler fallback after native syntax rejection and executes effects once", async () => {
  if (compiler === undefined) throw new Error("Compiler was not initialized");
  const source = "require('effects').run(); module.exports=17;";
  const OriginalFunction = globalThis.Function;
  let parses = 0, transforms = 0, effects = 0;
  vi.resetModules();
  globalThis.Function = new Proxy(OriginalFunction, {
    construct(target, argumentsList: unknown[], newTarget) {
      if (argumentsList.at(-1) === source) { parses++; throw new SyntaxError("Unsupported native syntax"); }
      const result: unknown = Reflect.construct(target, argumentsList, newTarget);
      if (typeof result !== "function") throw new Error("Invalid evaluator");
      return result;
    },
  });
  let namespace: typeof ModuleLoader;
  try { namespace = await import("./module-loader.js"); }
  finally { globalThis.Function = OriginalFunction; }
  const pinnedCompiler = compiler;
  const observedCompiler: AssistanceCompiler = {
    hasDynamicImport: value => pinnedCompiler.hasDynamicImport(value),
    transform(value, options) { transforms++; return pinnedCompiler.transform(value, options); },
  };
  const loader = namespace.createLocalModuleLoader(observedCompiler, systemSource,
    {resolve:path=>path, read:()=>({format:"commonjs",source})},
    {effects:{run:()=>{effects++;}}});
  expect(loader.require("/fallback.cjs")).toBe(17);
  expect({parses,transforms,effects}).toEqual({parses:1,transforms:1,effects:1});
});

it("propagates non-syntax parse failures without compiler fallback or effects", async () => {
  if (compiler === undefined) throw new Error("Compiler was not initialized");
  const source = "require('effects').run(); module.exports=19;";
  const OriginalFunction = globalThis.Function, failure = new Error("Native evaluator rejected");
  let transforms = 0, effects = 0;
  vi.resetModules();
  globalThis.Function = new Proxy(OriginalFunction, {
    construct(target, argumentsList: unknown[], newTarget) {
      if (argumentsList.at(-1) === source) throw failure;
      const result: unknown = Reflect.construct(target, argumentsList, newTarget);
      if (typeof result !== "function") throw new Error("Invalid evaluator");
      return result;
    },
  });
  let namespace: typeof ModuleLoader;
  try { namespace = await import("./module-loader.js"); }
  finally { globalThis.Function = OriginalFunction; }
  const pinnedCompiler = compiler;
  const observedCompiler: AssistanceCompiler = {
    hasDynamicImport: value => pinnedCompiler.hasDynamicImport(value),
    transform(value, options) { transforms++; return pinnedCompiler.transform(value, options); },
  };
  const loader = namespace.createLocalModuleLoader(observedCompiler, systemSource,
    {resolve:path=>path, read:()=>({format:"commonjs",source})},
    {effects:{run:()=>{effects++;}}});
  expect(()=>loader.require("/rejected.cjs")).toThrow(failure);
  expect({transforms,effects}).toEqual({transforms:0,effects:0});
});
const forms = [
  ["named", "function named/* original */(value = 7){return value + 2;}", 9],
  ["arrow", "(value = 7) => /* original */ value + 3", 10],
  ["nested closure", "function factory(){ const offset=11; return function inner/*keep*/(value=7){return offset+value;}; }", "function inner/*keep*/(value=7){return offset+value;}"] ,
  ["method", "run/* original */(value = 7){return value + 5;}", 12],
  ["generator", "function* items/* original */(){yield 7;}", 7],
] as const;
for (const [name, original, expected] of forms) it("preserves original synchronous CommonJS " + name + " source and behavior", () => {
  if (compiler === undefined) throw new Error("Compiler was not initialized");
  const source = name === "method" ? "module.exports = ({" + original + "}).run;" : "module.exports = (" + original + ");";
  const loader = createLocalModuleLoader(compiler, systemSource, {resolve:path=>path, read:()=>({format:"commonjs",source})});
  const exported: unknown = loader.require("/source.cjs");
  if (typeof exported !== "function") throw new Error("Missing function export");
  if (name === "nested closure") {
    const nested: unknown = Reflect.apply(exported, undefined, []);
    if (typeof nested !== "function") throw new Error("Missing nested function");
    expect(Function.prototype.toString.call(nested)).toBe(expected);
    expect(Reflect.apply(nested, undefined, [])).toBe(18);
  } else {
    expect(Function.prototype.toString.call(exported)).toBe(original);
    const result: unknown = Reflect.apply(exported, undefined, []);
    if (name === "generator") {
      if (typeof result !== "object" || result === null || !("next" in result) || typeof result.next !== "function") throw new Error("Missing generator iterator");
      const item: unknown = Reflect.apply(result.next, result, []);
      expect(item).toEqual({value:expected,done:false});
    } else expect(result).toBe(expected);
  }
});
