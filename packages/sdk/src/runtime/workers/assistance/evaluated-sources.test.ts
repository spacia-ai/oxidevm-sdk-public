import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import * as compilerNamespace from "@swc/wasm-web";
import { initializeCompiler } from "./compiler.js";
import { lowerEvaluatedSource } from "./evaluated-sources.js";
import { lowerScriptImports } from "./script-imports.ts";

async function compiler() {
  const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
  return initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
}

it("lowers the async functions of a source that webpack's development output hands to eval, and keeps its labels", async () => {
  const swc = await compiler();
  const map = Buffer.from(JSON.stringify({ version: 3, sources: ["webpack://app/./page.js"], names: [], mappings: "AAAA", sourcesContent: ["original"] })).toString("base64");
  const fragment = `__webpack_require__.r(__webpack_exports__);\nasync function load() { await wait(); return 7; }\n__webpack_exports__.load = load;//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${map}\n//# sourceURL=webpack-internal:///(rsc)/./page.js\n`;
  const lowered = lowerEvaluatedSource(swc, fragment, "/workspace/.next/server/app/page.js");
  if (lowered === undefined) throw new Error("The fragment was not lowered");
  // No native await is left: every continuation goes through the realm's Promise.
  expect(lowered).not.toMatch(/\bawait\b/u); expect(lowered).toContain("yield wait()");
  expect(lowered.trimEnd().endsWith("//# sourceURL=webpack-internal:///(rsc)/./page.js")).toBe(true);
  const emitted = /sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)/u.exec(lowered)?.[1];
  expect(JSON.parse(Buffer.from(emitted ?? "", "base64").toString())).toMatchObject({ version: 3, sources: ["webpack://app/./page.js"] });
  // The lowered text still runs where a direct eval runs it: against the enclosing function's bindings.
  const exports: { load?: () => Promise<number> } = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the test runs the lowered text as webpack's module factory would
  const factory = new Function("__webpack_require__", "__webpack_exports__", "wait", `"use strict"; eval(${JSON.stringify(lowered)});`);
  Reflect.apply(factory, undefined, [{ r: () => undefined }, exports, () => Promise.resolve()]);
  await expect(exports.load?.()).resolves.toBe(7);
  // A source without async functions is left exactly as it is.
  expect(lowerEvaluatedSource(swc, "module.exports = 1;", "/workspace/a.js")).toBeUndefined();
});

it("rewrites only a direct eval of a literal source in a loaded script", () => {
  const seen: string[] = [];
  const lower = (code: string) => { seen.push(code); return code.includes("async") ? "LOWERED" : undefined; };
  const bundle = `var exports = {};\nmodules = { a: (module, exports) => {\n  eval("async function a(){}");\n  eval('sync()');\n  eval(text);\n}, b: function (eval) { eval("async function b(){}"); } };`;
  const result = lowerScriptImports(bundle, "/workspace/bundle.js", undefined, lower);
  expect(seen).toEqual(["async function a(){}", "sync()"]);
  // Every other byte stays, so the script needs no source map and no second compilation.
  expect(result.code).toBe(bundle.replace(`"async function a(){}"`, `"LOWERED"`)); expect(result.map).toBeUndefined();
  // With another rewrite in the same script it is reprinted as a whole, evaluated literal included.
  expect(lowerScriptImports(`eval("async function c(){}"); import("./d.js");`, "/workspace/mixed.js", undefined, lower).code).toContain(`eval("LOWERED")`);
});
