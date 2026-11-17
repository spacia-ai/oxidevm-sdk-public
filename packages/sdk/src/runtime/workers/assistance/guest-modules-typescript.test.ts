import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import * as compilerNamespace from "@swc/wasm-web";
import { lateFailureOf, lateFailureSentence } from "../../js-process/late-failure.js";
import { initializeCompiler } from "./compiler.js";
import { createGuestModules } from "./guest-modules.js";
import { createLocalModuleLoader } from "./module-loader.js";
import { refusingModules } from "./module-refusal.js";

const typed = "export const value: number = 1;";
function fixture(runtime: "node" | "bun") {
  const sources = new Map([
    ["/workspace/package.json", '{"type":"commonjs"}'],
    ["/workspace/main.cjs", "module.exports = (name) => require(name);"],
    ["/workspace/plain.js", "module.exports = 7;"],
    ["/workspace/esm/package.json", '{"type":"module"}'],
    ["/workspace/esm/plain.js", "export const value = 8;"],
    ["/workspace/esm/static.js", "import { value } from './util.ts'; export { value };"],
    ...["/workspace/util.ts", "/workspace/util.mts", "/workspace/util.cts", "/workspace/esm/util.ts"].map(path => [path, typed] as const),
    // Without type syntax, so a loader that reads it as JavaScript runs it.
    ["/workspace/erasable.ts", "module.exports = 9;"],
    ["/workspace/esm/erasable.mts", "export const value = 10;"],
    ["/workspace/view.tsx", "module.exports = 11;"],
    ["/workspace/esm/view.tsx", "export const value = 12;"],
  ]);
  const files = {
    readFileSync(path: string): string {
      const value = sources.get(path);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
    statSync(path: string) {
      if (!sources.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isFile: () => true, isDirectory: () => false };
    },
    realpathSync(path: string): string { return path; },
  };
  const identity = { generation: 1n, profile: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/node_modules" }], runtime, moduleSearchPaths: [] } as const;
  return createGuestModules(files, identity);
}
async function loader(runtime: "node" | "bun") {
  const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const system = await readFile(require.resolve("systemjs/dist/s.js"), "utf8");
  return createLocalModuleLoader(compiler, system, fixture(runtime));
}
function thrown(work: () => unknown): unknown {
  try { work(); } catch (error) { return error; }
  throw new Error("Expected a failure");
}
async function rejected(work: Promise<unknown>): Promise<unknown> {
  try { await work; } catch (error) { return error; }
  throw new Error("Expected a rejection");
}
const stripping = { kind: "unavailable-builtin", detail: "TypeScript type stripping" } as const;

describe("TypeScript modules under Node", () => {
  it.each(["/workspace/util.ts", "/workspace/util.mts", "/workspace/util.cts", "/workspace/erasable.ts"])("refuses to read %s as JavaScript and names type stripping as the limitation", path => {
    const modules = fixture("node");
    for (const kind of [undefined, "require", "import"] as const) {
      const failure = thrown(() => modules.read(path, kind));
      expect(failure).toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
      expect(lateFailureOf(failure)).toEqual(stripping);
    }
    expect(lateFailureSentence(stripping)).toBe("This program uses TypeScript type stripping, which the fast path does not provide; its next run uses full Linux.");
  });

  it("fails require() of .ts, .mts and .cts with the typed limitation instead of a SyntaxError", async () => {
    const require = (await loader("node")).require("/workspace/main.cjs");
    if (typeof require !== "function") throw new Error("Expected the fixture's require");
    for (const name of ["./util.ts", "./util.mts", "./util.cts"]) expect(lateFailureOf(thrown(() => Reflect.apply(require, undefined, [name])))).toEqual(stripping);
    expect(Reflect.apply(require, undefined, ["./plain.js"])).toBe(7);
  });

  it("fails static and dynamic import of .ts, .mts and .cts with the typed limitation", async () => {
    const modules = await loader("node");
    for (const path of ["/workspace/util.ts", "/workspace/util.mts", "/workspace/util.cts", "/workspace/esm/static.js"]) {
      expect(lateFailureOf(await rejected(modules.import(path)))).toEqual(stripping);
    }
    expect((await modules.import("/workspace/esm/plain.js"))["value"]).toBe(8);
  });

  it("keeps the refusal a limitation the reporter does not mistake for an unadmitted module", () => {
    const admitted = refusingModules(fixture("node"));
    expect(lateFailureOf(thrown(() => admitted.modules.read("/workspace/util.ts", "import")))).toEqual(stripping);
    expect(admitted.refused()).toBeUndefined();
  });

  it("answers an imported .tsx with ERR_UNKNOWN_FILE_EXTENSION and still requires one as JavaScript, as Node 24 does", async () => {
    const modules = await loader("node");
    const failure = await rejected(modules.import("/workspace/esm/view.tsx"));
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({ code: "ERR_UNKNOWN_FILE_EXTENSION", message: 'Unknown file extension ".tsx" for /workspace/esm/view.tsx' });
    expect(lateFailureOf(failure)).toBeUndefined();
    expect(await rejected(modules.import("/workspace/view.tsx"))).toMatchObject({ code: "ERR_UNKNOWN_FILE_EXTENSION" });
    expect(modules.require("/workspace/view.tsx")).toBe(11);
  });
});

describe("TypeScript modules under Bun", () => {
  const transpilation = { kind: "unavailable-builtin", detail: "TypeScript transpilation" } as const;

  it.each(["/workspace/util.ts", "/workspace/util.mts", "/workspace/util.cts", "/workspace/erasable.ts", "/workspace/esm/view.tsx"])("refuses to read %s as JavaScript and names Bun's transpiler as the limitation", path => {
    const files = fixture("bun");
    for (const kind of [undefined, "require", "import"] as const) {
      const failure = thrown(() => files.read(path, kind));
      expect(failure).toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
      expect(lateFailureOf(failure)).toEqual(transpilation);
    }
    expect(lateFailureSentence(transpilation)).toBe("This program uses TypeScript transpilation, which the fast path does not provide; its next run uses full Linux.");
  });

  it("keeps loading JavaScript modules", async () => {
    const modules = await loader("bun");
    expect(modules.require("/workspace/plain.js")).toBe(7);
  });
});
