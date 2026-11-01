import { describe, expect, it } from "vitest";
import { bundleAdapter } from "./bundle.js";
import { BuildFailure } from "./findings.js";
import type { Finding } from "./findings.js";
import { lintAdapter } from "./lint.js";
import { decodeWasmBuildResult } from "./reports.js";
import { hookOf, importAdapter, moduleSource, projects } from "./author.test-support.js";

const project = projects();
/** An import of, or a call to, the SDK left in the output (esbuild's own comment naming the stub is not one). */
const SDK_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']@oxidevm\/sdk/u;

async function failureOf(run: () => Promise<unknown>): Promise<readonly Finding[]> {
  try { await run(); } catch (error) { if (error instanceof BuildFailure) return error.findings; throw error; }
  throw new Error("expected the bundle to fail");
}

describe("bundleAdapter", () => {
  it("produces one self-contained module whose default export is the adapter factory", async () => {
    const dir = await project({ "module.ts": moduleSource() });
    const bundle = await bundleAdapter(dir, "module.ts");
    expect(bundle.text).toMatch(/export \{\s*\S+ as default\s*\};/u);
    expect(bundle.text).not.toMatch(SDK_IMPORT);
    expect(lintAdapter(bundle.text, bundle.locate)).toEqual([]);
    expect(bundle.bytes.byteLength).toBe(new TextEncoder().encode(bundle.text).byteLength);
    await expect(importAdapter(bundle.bytes)).resolves.toBeTypeOf("function");
  });

  it("runs the bundled adapter against a host", async () => {
    const dir = await project({ "module.ts": moduleSource() });
    const bundle = await bundleAdapter(dir, "module.ts");
    const written: string[] = [];
    const hooks = (await importAdapter(bundle.bytes))({ fs: { writeFile: (_path: string, bytes: Uint8Array) => { written.push(new TextDecoder().decode(bytes)); } } });
    expect(hookOf(hooks, "main")({ args: ["a", "b"] })).toBe(0);
    expect(written).toEqual(["a,b"]);
  });

  it("erases type-only imports from the SDK and bundles relative imports", async () => {
    const dir = await project({
      "module.ts": moduleSource({ imports: `import type { Connection } from "@oxidevm/sdk/wasm";\nimport { greet } from "./src/greet.ts";\ndeclare const unused: Connection | undefined;\nvoid unused;\n`, adapter: `() => ({ main: () => (greet() === "hi" ? 0 : 1) })` }),
      "src/greet.ts": `export const greet = (): string => "hi";\n`,
    });
    const bundle = await bundleAdapter(dir, "module.ts");
    expect(bundle.text).toContain("\"hi\"");
    expect(bundle.text).not.toMatch(SDK_IMPORT);
    expect(bundle.text).toContain("// src/greet.ts");
  });

  it("refuses a value import from the SDK other than defineModule, naming it and its line", async () => {
    const dir = await project({ "module.ts": moduleSource({ imports: `import { MODULE_EXIT } from "@oxidevm/sdk/wasm";\n`, adapter: `() => ({ main: () => MODULE_EXIT.adapterMax })` }) });
    const [only, ...rest] = await failureOf(() => bundleAdapter(dir, "module.ts"));
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ severity: "error", code: "adapter-bundle", file: "module.ts", line: 2 });
    expect(only?.message).toContain("MODULE_EXIT");
  });

  it.each(["@oxidevm/sdk", "@oxidevm/sdk/image-builder", "@oxidevm/sdk/wasm/kit"])("refuses the SDK entry %s and says how to import types", async entry => {
    const dir = await project({ "module.ts": moduleSource({ imports: `import { thing } from ${JSON.stringify(entry)};\n`, adapter: `() => ({ main: () => (thing ? 0 : 1) })` }) });
    const [only] = await failureOf(() => bundleAdapter(dir, "module.ts"));
    expect(only?.message).toContain(`"${entry}" cannot be bundled into an adapter`);
    expect(only?.message).toContain("import type");
    expect(only).toMatchObject({ file: "module.ts", line: 2 });
  });

  it("refuses imports no worker can resolve: Node builtins, missing packages and WebAssembly files", async () => {
    for (const [source, use, extra, fragment] of [
      [`import { readFileSync } from "node:fs";\n`, `typeof readFileSync`, {}, "node:fs"],
      [`import left from "left-pad";\n`, `typeof left`, {}, "left-pad"],
      [`import code from "./engine.wasm";\n`, `typeof code`, { "engine.wasm": "\0asm" }, "engine.wasm"],
      [`import "node:path";\n`, `typeof 0`, {}, "node:path"],
    ] as const) {
      const dir = await project({ "module.ts": moduleSource({ imports: source, adapter: `() => ({ main: () => (${use} === "undefined" ? 0 : 1) })` }), ...extra });
      const found = await failureOf(() => bundleAdapter(dir, "module.ts"));
      expect(found.length).toBeGreaterThan(0);
      expect(found.every(item => item.code === "adapter-bundle" && item.severity === "error")).toBe(true);
      expect(found.map(item => item.message).join("\n")).toContain(fragment);
    }
  });

  it("fails with a located finding when the module has a syntax error", async () => {
    const dir = await project({ "module.ts": `import { defineModule } from "@oxidevm/sdk/wasm";\nexport default defineModule({ manifest: ;\n` });
    const [only] = await failureOf(() => bundleAdapter(dir, "module.ts"));
    expect(only).toMatchObject({ code: "adapter-bundle", file: "module.ts", line: 2 });
  });

  it("lists the third-party packages that contributed code, with their licenses, and leaves out unused ones", async () => {
    const dir = await project({
      "module.ts": moduleSource({ imports: `import { used } from "fake-lib";\nimport { scoped } from "@fake/scoped";\nimport "./unused-import.ts";\n`, adapter: `() => ({ main: () => (used() + scoped() > 0 ? 0 : 1) })` }),
      "unused-import.ts": `export {};\n`,
      "node_modules/fake-lib/package.json": JSON.stringify({ name: "fake-lib", version: "2.3.4", license: "ISC", main: "index.js" }),
      "node_modules/fake-lib/index.js": `/*! fake-lib (c) Example Authors */\nexport const used = () => 1;\nexport const never = () => 2;\n`,
      "node_modules/@fake/scoped/package.json": JSON.stringify({ name: "@fake/scoped", version: "0.1.0", license: { type: "MIT" }, main: "index.js" }),
      "node_modules/@fake/scoped/index.js": `export const scoped = () => 1;\n`,
      "node_modules/unused-lib/package.json": JSON.stringify({ name: "unused-lib", version: "9.9.9", license: "GPL-3.0-only", main: "index.js" }),
      "node_modules/unused-lib/index.js": `export const nothing = 0;\n`,
    });
    const bundle = await bundleAdapter(dir, "module.ts");
    expect(bundle.packages).toEqual([{ name: "@fake/scoped", version: "0.1.0", license: "MIT" }, { name: "fake-lib", version: "2.3.4", license: "ISC" }]);
    expect(bundle.text).not.toContain("never");
    expect(bundle.text).toContain("fake-lib (c) Example Authors");
  });

  it("lists only packages whose own code is in the output: not one that merely re-exports another's, nor one tree-shaken away", async () => {
    const dir = await project({
      "module.ts": moduleSource({ imports: `import { value } from "dropped-lib";\nimport { used } from "wrapper-lib";\nconst neverCalled = (): number => value;\n`, adapter: `() => ({ main: () => used() - 1 })` }),
      "node_modules/dropped-lib/package.json": JSON.stringify({ name: "dropped-lib", version: "1.0.0", license: "MIT", main: "index.js", sideEffects: false }),
      "node_modules/dropped-lib/index.js": `export const value = 41;\n`,
      "node_modules/wrapper-lib/package.json": JSON.stringify({ name: "wrapper-lib", version: "1.0.0", license: "MIT", main: "index.js" }),
      "node_modules/wrapper-lib/index.js": `export { used } from "inner-lib";\n`,
      "node_modules/inner-lib/package.json": JSON.stringify({ name: "inner-lib", version: "2.0.0", license: "ISC", main: "index.js" }),
      "node_modules/inner-lib/index.js": `export const used = () => 1;\n`,
    });
    const bundle = await bundleAdapter(dir, "module.ts");
    expect(bundle.text).not.toContain("41");
    expect(bundle.packages).toEqual([{ name: "inner-lib", version: "2.0.0", license: "ISC" }]);
  });

  it("describes a package whose metadata is longer than the build report allows as unknown, instead of failing the build", async () => {
    const dir = await project({
      "module.ts": moduleSource({ imports: `import { used } from "long-lib";\n`, adapter: `() => ({ main: () => (used() > 0 ? 0 : 1) })` }),
      "node_modules/long-lib/package.json": JSON.stringify({ name: "n".repeat(215), version: "1".repeat(129), license: "L".repeat(257), main: "index.js" }),
      "node_modules/long-lib/index.js": `export const used = () => 1;\n`,
    });
    const bundle = await bundleAdapter(dir, "module.ts");
    expect(bundle.packages).toEqual([{ name: "long-lib", version: "unknown", license: "UNKNOWN" }]);
    // The report decoder is the contract: what the bundle lists must be something it accepts.
    expect(decodeWasmBuildResult({ result: "failed", id: null, version: null, release: null, directory: null, files: [], bundled: bundle.packages, findings: [{ severity: "error", code: "adapter-bundle", message: "x" }] }).bundled).toEqual(bundle.packages);
  });

  it("refuses a bundle of more packages than the build report can carry, with an error that says so", async () => {
    const count = 257, names = Array.from({ length: count }, (_, index) => `p${String(index)}`);
    const dir = await project({
      "module.ts": moduleSource({ imports: names.map(name => `import { ${name} } from "${name}-lib";\n`).join(""), adapter: `() => ({ main: () => (${names.join(" + ")} > 0 ? 0 : 1) })` }),
      ...Object.fromEntries(names.flatMap(name => [
        [`node_modules/${name}-lib/package.json`, JSON.stringify({ name: `${name}-lib`, version: "1.0.0", license: "MIT", main: "index.js" })],
        [`node_modules/${name}-lib/index.js`, `export const ${name} = 1;\n`],
      ])),
    });
    const findings = await failureOf(() => bundleAdapter(dir, "module.ts"));
    expect(findings).toMatchObject([{ severity: "error", code: "adapter-bundle", message: expect.stringContaining("257 third-party packages") as unknown }]);
  });

  it("describes a bundled package with no readable metadata as UNKNOWN", async () => {
    const dir = await project({
      "module.ts": moduleSource({ imports: `import { used } from "bare-lib";\nimport { other } from "odd-lib";\n`, adapter: `() => ({ main: () => (used() + other() > 0 ? 0 : 1) })` }),
      "node_modules/bare-lib/index.js": `export const used = () => 1;\n`,
      "node_modules/odd-lib/package.json": `{ "name": 7, "version": 7, "license": 7, "main": "index.js" }`,
      "node_modules/odd-lib/index.js": `export const other = () => 1;\n`,
    });
    const bundle = await bundleAdapter(dir, "module.ts");
    expect(bundle.packages).toEqual([{ name: "bare-lib", version: "unknown", license: "UNKNOWN" }, { name: "odd-lib", version: "unknown", license: "UNKNOWN" }]);
  });

  it("is deterministic across directories and keeps absolute paths out of the output", async () => {
    const files = { "module.ts": moduleSource({ imports: `import { value } from "./src/value.ts";\nimport { lib } from "fake-lib";\n`, adapter: `() => ({ main: () => (value + lib() > 0 ? 0 : 1) })` }), "src/value.ts": `export const value = 1;\n`, "node_modules/fake-lib/package.json": `{"name":"fake-lib","version":"1.0.0","license":"MIT","main":"index.js"}`, "node_modules/fake-lib/index.js": `export const lib = () => 1;\n` };
    const [first, second] = [await project(files), await project(files)];
    const [left, right] = [await bundleAdapter(first, "module.ts"), await bundleAdapter(second, "module.ts")];
    expect(first).not.toBe(second);
    expect(left.text).toBe(right.text);
    expect(left.text).not.toContain(first);
    expect(left.text).not.toContain(second);
    expect(left.text).not.toContain("/tmp/");
  });

  it("maps positions in the bundle back to the author's files", async () => {
    const dir = await project({
      "module.ts": moduleSource({ imports: `import { read } from "./src/read.ts";\n`, adapter: `() => ({ main: () => read() })` }),
      "src/read.ts": `export function read(): number {\n  return window.length;\n}\n`,
    });
    const bundle = await bundleAdapter(dir, "module.ts");
    const found = lintAdapter(bundle.text, bundle.locate);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "warning", code: "adapter-global", file: "src/read.ts", line: 2, column: 10 });
  });

  it("does not start when the signal is already aborted, so even a module that would fail to bundle reports the abort", async () => {
    const dir = await project({ "module.ts": `import { defineModule } from "@oxidevm/sdk/wasm";\nexport default defineModule({ manifest: ;\n` });
    const controller = new AbortController();
    controller.abort();
    await expect(bundleAdapter(dir, "module.ts", controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("does not return output when the signal aborts while bundling", async () => {
    const dir = await project({ "module.ts": moduleSource() });
    const controller = new AbortController();
    const pending = bundleAdapter(dir, "module.ts", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  describe("dependency code that mentions what a worker cannot provide", () => {
    const library = (name: string, files: Record<string, string>, extra: Record<string, unknown> = {}): Record<string, string> => ({
      [`node_modules/${name}/package.json`]: JSON.stringify({ name, version: "1.0.0", license: "MIT", main: files["index.js"] === undefined ? "index.cjs" : "index.js", ...extra }),
      ...Object.fromEntries(Object.entries(files).map(([path, text]) => [`node_modules/${name}/${path}`, text])),
    });
    const using = (name: string, expression: string): string => moduleSource({ imports: `import * as lib from ${JSON.stringify(name)};\n`, adapter: `() => ({ main: async () => ${expression} })` });

    it("replaces Node built-ins and unavailable optional packages with empty modules, lists them, and the adapter still runs", async () => {
      const dir = await project({
        "module.ts": using("env-lib", `(await lib.load(false)) === "browser" && (await lib.load(true)) === "objectobject" ? 0 : 1`),
        ...library("env-lib", { "index.js": `export async function load(useNode) {\n  if (useNode) {\n    const fs = await import("node:fs");\n    const ws = await import("ws");\n    return typeof fs.default + typeof ws.default;\n  }\n  return "browser";\n}\n` }),
      });
      const bundle = await bundleAdapter(dir, "module.ts");
      expect(bundle.stubbed).toEqual([{ specifier: "node:fs", importer: "node_modules/env-lib/index.js" }, { specifier: "ws", importer: "node_modules/env-lib/index.js" }]);
      expect(await hookOf((await importAdapter(bundle.bytes))({}), "main")()).toBe(0);
    });

    it("does the same for require() of a built-in in a CommonJS dependency", async () => {
      const dir = await project({
        "module.ts": using("cjs-lib", `lib.default.read() === "empty" ? 0 : 1`),
        ...library("cjs-lib", { "index.cjs": `module.exports = { read() { try { return require("fs").readFileSync ? "node" : "empty"; } catch { return "none"; } } };\n` }),
      });
      const bundle = await bundleAdapter(dir, "module.ts");
      expect(bundle.stubbed).toEqual([{ specifier: "fs", importer: "node_modules/cjs-lib/index.cjs" }]);
      expect(await hookOf((await importAdapter(bundle.bytes))({}), "main")()).toBe(0);
    });

    it("also replaces a static import of a built-in, with or without the node: prefix", async () => {
      const dir = await project({
        "module.ts": using("static-lib", `lib.kind() === "none" ? 0 : 1`),
        ...library("static-lib", { "index.js": `import nodePath from "node:path";\nimport plainOs from "os";\nexport const kind = () => (nodePath.sep ?? plainOs.EOL ?? "none");\n` }),
      });
      const bundle = await bundleAdapter(dir, "module.ts");
      expect(bundle.stubbed).toEqual([{ specifier: "node:path", importer: "node_modules/static-lib/index.js" }, { specifier: "os", importer: "node_modules/static-lib/index.js" }]);
      expect(await hookOf((await importAdapter(bundle.bytes))({}), "main")()).toBe(0);
    });

    it("also replaces imports that esbuild tolerates inside try/catch, which it would otherwise leave in the bundle", async () => {
      const dir = await project({
        "module.ts": moduleSource({ imports: `import { load } from "guarded-lib";\nimport legacy from "guarded-lib/legacy.cjs";\n`, adapter: `() => ({ main: async () => (typeof await load() === "object" && legacy.read() === "empty" ? 0 : 1) })` }),
        ...library("guarded-lib", {
          "index.js": `export async function load() {\n  try { return await import("ws"); } catch { return null; }\n}\n`,
          "legacy.cjs": `module.exports = { read() { try { return require("net").connect ? "node" : "empty"; } catch { return "none"; } } };\n`,
        }),
      });
      const bundle = await bundleAdapter(dir, "module.ts");
      expect(bundle.stubbed).toEqual([{ specifier: "net", importer: "node_modules/guarded-lib/legacy.cjs" }, { specifier: "ws", importer: "node_modules/guarded-lib/index.js" }]);
      expect(bundle.text).not.toMatch(/import\(\s*["']ws["']\s*\)|require\(\s*["']net["']\s*\)/u);
      expect(await hookOf((await importAdapter(bundle.bytes))({}), "main")()).toBe(0);
    });

    it("leaves a package that disables its own Node imports through the package.json browser field to esbuild, as Pyodide does", async () => {
      const dir = await project({
        "module.ts": using("browser-lib", `(await lib.load()).length === 2 ? 0 : 1`),
        ...library("browser-lib", { "index.js": `export async function load() {\n  return [await import("ws"), await import("node:fs")];\n}\n` }, { browser: { ws: false, fs: false } }),
      });
      const bundle = await bundleAdapter(dir, "module.ts");
      expect(bundle.stubbed).toEqual([{ specifier: "node:fs", importer: "node_modules/browser-lib/index.js" }]);
      expect(await hookOf((await importAdapter(bundle.bytes))({}), "main")()).toBe(0);
    });

    it("does not list a package that the browser field replaced with an empty module, because none of its code is in the output", async () => {
      const dir = await project({
        "module.ts": using("browser-lib", `(await lib.load()).length === 1 ? 0 : 1`),
        ...library("browser-lib", { "index.js": `export async function load() {\n  return [await import("ws")];\n}\n` }, { browser: { ws: false } }),
        "node_modules/browser-lib/node_modules/ws/package.json": JSON.stringify({ name: "ws", version: "8.22.0", license: "MIT", main: "index.js" }),
        "node_modules/browser-lib/node_modules/ws/index.js": `module.exports = { server: 1 };\n`,
      });
      const bundle = await bundleAdapter(dir, "module.ts");
      expect(bundle.packages).toEqual([{ name: "browser-lib", version: "1.0.0", license: "MIT" }]);
      expect(bundle.text).not.toContain("server");
    });

    it("lists each specifier once per importing file, sorted", async () => {
      const dir = await project({
        "module.ts": moduleSource({ imports: `import { one } from "multi-lib";\n`, adapter: `() => ({ main: () => typeof one })` }),
        ...library("multi-lib", {
          "index.js": `import { two } from "./two.js";\nexport const one = async () => [await import("node:path"), await import("node:fs"), await import("node:fs"), two];\n`,
          "two.js": `export const two = async () => import("node:fs");\n`,
        }),
      });
      expect((await bundleAdapter(dir, "module.ts")).stubbed).toEqual([
        { specifier: "node:fs", importer: "node_modules/multi-lib/index.js" }, { specifier: "node:fs", importer: "node_modules/multi-lib/two.js" }, { specifier: "node:path", importer: "node_modules/multi-lib/index.js" },
      ]);
    });

    it("does not replace a package that is installed, even when it is named like a built-in", async () => {
      const dir = await project({
        "module.ts": using("dep-lib", `lib.make() === "polyfill" ? 0 : 1`),
        ...library("dep-lib", { "index.js": `import { kind } from "events";\nexport const make = () => kind;\n` }),
        ...library("events", { "index.js": `export const kind = "polyfill";\n` }),
      });
      const bundle = await bundleAdapter(dir, "module.ts");
      expect(bundle.stubbed).toEqual([]);
      expect(await hookOf((await importAdapter(bundle.bytes))({}), "main")()).toBe(0);
    });

    it("still refuses what only dependency code could not resolve at load: a static import of a missing package", async () => {
      const dir = await project({ "module.ts": using("bad-lib", `typeof lib.value`), ...library("bad-lib", { "index.js": `import value from "nowhere-pkg";\nexport { value };\n` }) });
      const found = await failureOf(() => bundleAdapter(dir, "module.ts"));
      expect(found[0]).toMatchObject({ code: "adapter-bundle", severity: "error" });
      expect(found[0]?.message).toContain("nowhere-pkg");
    });

    it("does not extend the allowance to the author's own files", async () => {
      const dir = await project({ "module.ts": moduleSource({ imports: `const later = async (): Promise<unknown> => import("node:fs");\nvoid later;\n`, adapter: `() => ({ main: () => 0 })` }) });
      const found = await failureOf(() => bundleAdapter(dir, "module.ts"));
      expect(found[0]?.message).toContain("node:fs");
    });
  });
});
