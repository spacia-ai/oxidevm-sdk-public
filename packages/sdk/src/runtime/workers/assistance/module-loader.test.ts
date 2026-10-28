import { deprecate, format, inspect } from "node:util";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import * as compilerNamespace from "@swc/wasm-web";
import { initializeCompiler } from "./compiler.js";
import { createLocalModuleLoader } from "./module-loader.js";
import { createAsyncContext } from "./async-context.js";
import { createNodeAsyncHooks } from "./node-async-hooks.js";
import { createNodeEvents } from "./node-events.js";
import { EventEmitter } from "./node-streams.js";
import { nodeV8Memory } from "./node-memory.js";

it.each(["/workspace/vite/logger.js", "/workspace/space #?%/π.js"])("uses the guest file URL for import.meta in %s", async path => {
  const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const system = await readFile(require.resolve("systemjs/dist/s.js"), "utf8");
  const loader = createLocalModuleLoader(compiler, system, {
    resolve: request => request,
    read: () => ({ source: "export const url = import.meta.url; export const directory = new URL('.', import.meta.url).href; export const dirname = import.meta.dirname; export const filename = import.meta.filename;", format: "module" }),
  });
  const namespace = await loader.import(path);
  expect(namespace["url"]).toBe(pathToFileURL(path).href);
  expect(namespace["directory"]).toBe(new URL(".", pathToFileURL(path)).href);
  expect(namespace["filename"]).toBe(path);
  expect(namespace["dirname"]).toBe(posix.dirname(path));
});

it("resolves a compiled Module without a filename from the current cwd", async () => {
  const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const system = await readFile(require.resolve("systemjs/dist/s.js"), "utf8");
  let cwd = "/workspace";
  const source = "const Module=require('node:module'); const generated=new Module('/generated/config.cjs',module); generated._compile(\"module.exports=require('./helper.cjs');\",'/generated/config.cjs'); module.exports=generated.exports;";
  const modules = new Map([["/workspace/root.cjs", source], ["/other/root.cjs", source], ["/workspace/helper.cjs", "module.exports=42;"], ["/other/helper.cjs", "module.exports=84;"]]);
  const loader = createLocalModuleLoader(compiler, system, {
    resolve: (request, parent) => posix.resolve(posix.dirname(parent), request),
    read: path => { const source = modules.get(path); if (source === undefined) throw new Error(`Missing module ${path}`); return { source, format: "commonjs" }; },
  }, {}, () => cwd);
  expect(loader.require("/workspace/root.cjs")).toBe(42);
  cwd = "/other";
  expect(loader.require("/other/root.cjs")).toBe(84);
});

it("links named builtins without invoking APIs that have no browser contract", async () => {
  const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const system = await readFile(require.resolve("systemjs/dist/s.js"), "utf8");
  const hooks = createNodeAsyncHooks(createAsyncContext(), { deprecate, format, inspect });
  const { module: events, restore } = createNodeEvents(EventEmitter, hooks);
  onTestFinished(restore);
  const Resource = events.EventEmitterAsyncResource;
  const sources = new Map([
    ["/workspace/esm.js", "import events, { EventEmitterAsyncResource, getEventListeners } from 'node:events'; import { serialize } from 'node:v8'; export const serializeType = typeof serialize; export const same = events.EventEmitterAsyncResource === EventEmitterAsyncResource; export const emitter = new EventEmitterAsyncResource({name:'ESM'}); export const listeners = getEventListeners(emitter, 'data');"],
    ["/workspace/cjs.cjs", "module.exports = require('node:events').EventEmitterAsyncResource;"],
  ]);
  const loader = createLocalModuleLoader(compiler, system, {
    resolve: request => request,
    read: path => {
      const source = sources.get(path);
      if (source === undefined) throw new Error(`Missing module ${path}`);
      return { source, format: path.endsWith(".cjs") ? "commonjs" : "module" };
    },
  }, { events, async_hooks: hooks, v8: nodeV8Memory });
  const namespace = await loader.import("/workspace/esm.js");
  expect(namespace["same"]).toBe(true);
  expect(namespace["serializeType"]).toBe("function");
  expect(namespace["emitter"]).toBeInstanceOf(Resource);
  expect(namespace["listeners"]).toEqual([]);
  expect(loader.require("/workspace/cjs.cjs")).toBe(Resource);
});

it("names an unavailable Node built-in so a late failure can be remembered", async () => {
  const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const system = await readFile(require.resolve("systemjs/dist/s.js"), "utf8");
  const loader = createLocalModuleLoader(compiler, system, {
    resolve: request => request,
    read: () => ({ source: "module.exports = require('node:sqlite');", format: "commonjs" }),
  });
  for (const specifier of ["node:sqlite", "repl"]) {
    let failure: unknown;
    try { loader.require(specifier); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { lateFailure: "unavailable-builtin", subject: specifier.startsWith("node:") ? specifier : `node:${specifier}` } });
  }
});
