import { expect, it } from "vitest";
import { lowerScriptImports } from "./script-imports.ts";

it("preserves original CommonJS bytes and coordinates when no syntax needs replacement", () => {
  const source = "// import('not-a-module')\n'use strict';\nmodule.exports = async () => 'unchanged';\n";
  const result = lowerScriptImports(source, "/workspace/helper.cjs");
  expect(result.code).toBe(source);
  expect(result.map).toBeUndefined();
  expect(result.memoryException).toBe(false);
  expect(result.requiresAsyncLowering).toBe(true);
  expect(result.importName).toMatch(/^_importLocal/u);
});

it("keeps dynamic imports in the guest loader with their original source map", () => {
  const result = lowerScriptImports("const _importLocal = 1; module.exports = () => import('./helper.mjs');", "/workspace/helper.cjs");
  expect(result.code).toContain(`${result.importName}('./helper.mjs')`);
  expect(result.importName).not.toBe("_importLocal");
  expect(JSON.parse(result.map ?? "null")).toMatchObject({ version: 3, sources: ["/workspace/helper.cjs"] });
});

it("requires async lowering for nested functions, arrows, methods and generators", () => {
  for (const source of [
    "function factory(){return async function nested(){};}",
    "module.exports = async () => 17;",
    "module.exports = {async run(){return 17;}};",
    "module.exports = async function* items(){yield 17;};",
  ]) expect(lowerScriptImports(source, "/async.cjs").requiresAsyncLowering).toBe(true);
  expect(lowerScriptImports("module.exports = function* items(){yield 17;};", "/sync.cjs").requiresAsyncLowering).toBe(false);
});
