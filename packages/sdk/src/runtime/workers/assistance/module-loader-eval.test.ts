import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { expect, it } from "vitest";
import * as compilerNamespace from "@swc/wasm-web";
import { initializeCompiler } from "./compiler.js";
import { createLocalModuleLoader } from "./module-loader.js";
import { installExecutableStacks } from "./executable-stacks.js";

async function fixture() {
  const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const system = await readFile(require.resolve("systemjs/dist/s.js"), "utf8");
  const reads: string[] = [];
  const loader = createLocalModuleLoader(compiler, system, {
    resolve: (request, parent) => posix.resolve(posix.dirname(parent), request),
    read: path => {
      reads.push(path);
      if (path !== "/workspace/helper.cjs") throw new Error(`Unexpected file read: ${path}`);
      return { source: "module.exports = {value: 42};", format: "commonjs" };
    },
  }, {}, "/workspace");
  const restore: (() => void)[] = [];
  restore.push(installExecutableStacks(loader.sources, globalThis));
  return {
    reads,
    evaluate: (source: string) => loader.evaluateScript(source, (name, value) => {
      const previous = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
      restore.push(() => {
        if (previous === undefined) Reflect.deleteProperty(globalThis, name);
        else Object.defineProperty(globalThis, name, previous);
      });
    }),
    dispose: () => { for (const reset of restore.reverse()) reset(); },
  };
}

it("uses the Node eval module without reading or caching a synthetic file", async () => {
  const test = await fixture();
  try {
    expect(test.evaluate("({filename:__filename,dirname:__dirname,main:require.main??null,id:module.id,path:module.path,moduleFilename:module.filename,loaded:module.loaded,cached:Object.hasOwn(require.cache,module.filename),thisIsExports:this===exports,thisIsGlobal:this===globalThis})"))
      .toEqual({ filename: "[worker eval]", dirname: ".", main: null, id: "[worker eval]", path: ".", moduleFilename: "/workspace/[worker eval]", loaded: false, cached: false, thisIsExports: false, thisIsGlobal: true });
    expect(test.evaluate("require('./helper.cjs')")).toEqual({ value: 42 });
    expect(test.reads).toEqual(["/workspace/helper.cjs"]);
  } finally { test.dispose(); }
});

it("preserves nulls, unpaired UTF16 units, script grammar and source labels", async () => {
  const test = await fixture(), unpaired = String.fromCharCode(0xd800);
  try {
    expect(test.evaluate(`['left\0right'.charCodeAt(4),'${unpaired}'.charCodeAt(0)]`)).toEqual([0, 0xd800]);
    expect(test.evaluate(`(function original(){return '${unpaired}';}).toString().includes('${unpaired}')`)).toBe(true);
    expect(test.evaluate("'use strict'; this === globalThis")).toBe(true);
    expect(() => test.evaluate("return 7;")).toThrow("Illegal return statement");
    let syntax: unknown;
    try { test.evaluate("return 7;"); } catch (error) { syntax = error; }
    if (!(syntax instanceof SyntaxError)) throw new Error("Missing eval syntax failure");
    expect(syntax.stack).toContain("[worker eval]");
    let failure: unknown;
    try { test.evaluate("throw Object.assign(new Error('worker-eval-error'),{code:'E_WORKER_EVAL'});"); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: "Error", message: "worker-eval-error", code: "E_WORKER_EVAL" });
    if (!(failure instanceof Error)) throw new Error("Missing eval failure");
    expect(failure.stack).toContain("[worker eval]");
  } finally { test.dispose(); }
});

it("keeps eval bindings for continuations and routes imports through the guest loader", async () => {
  const test = await fixture();
  try {
    expect(await test.evaluate("import('./helper.cjs').then(value=>({value:value.default.value,filename:__filename}))"))
      .toEqual({ value: 42, filename: "[worker eval]" });
    expect(test.reads.every(path => path === "/workspace/helper.cjs")).toBe(true);
    expect(test.reads.length).toBeGreaterThan(0);
  } finally { test.dispose(); }
});
