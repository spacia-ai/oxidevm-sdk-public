import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import * as compilerNamespace from "@swc/wasm-web";
import { initializeCompiler, type AssistanceCompiler } from "./compiler.js";
import { createLocalModuleLoader } from "./module-loader.js";
import { lowerModuleBindings } from "./module-bindings.js";

let compiler: AssistanceCompiler | undefined, system = "";
beforeAll(async () => {
  const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
  compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  system = await readFile(require.resolve("systemjs/dist/s.js"), "utf8");
});
async function evaluate(source: string) {
  if (compiler === undefined) throw new Error("Compiler is not initialized");
  return createLocalModuleLoader(compiler, system, { resolve: path => path, read: () => ({ format: "module", source }) }).import("/workspace/eval.mjs");
}

it("retains native lexical reads of literal identifiers, live values and function parameters", async () => {
  const result = await evaluate('let value=1;const read=()=>eval("value");export const first=read();value=2;export const second=read();function inspect(module){return eval(`module`)}export const parameter=inspect(42);');
  expect(result).toMatchObject({ first: 1, second: 2, parameter: 42 });
});

it("preserves eval value references and lexical initialization failures", async () => {
  const result = await evaluate('let early;try{eval("later")}catch(error){early=error.name}const later=42;function fn(){return this}export const receiver=eval("fn")()===undefined;export const removed=delete eval("later");export {early};');
  expect(result).toMatchObject({ receiver: true, removed: true, early: "ReferenceError" });
});

it("keeps custom eval calls observable instead of replacing them with a lexical value", async () => {
  const original = globalThis.eval;
  try {
    Reflect.set(globalThis, "eval", () => "custom");
    expect(await evaluate('const value=42;export const result=eval("value");')).toMatchObject({ result: "custom" });
  } finally { Reflect.set(globalThis, "eval", original); }
});

it.each([
  'const value="missing";eval(value);',
  'const value=42;eval("value + 1");',
  'eval("_moduleRuntime");',
  'import {value} from "./other.mjs";eval("value");',
])("keeps dynamic source and transformed import bindings gated: %s", source => {
  expect(() => lowerModuleBindings(source, "/eval.mjs")).toThrow("direct lexical eval");
});
