import { describe, expect, it } from "vitest";
import { BuildFailure } from "./findings.js";
import type { Finding } from "./findings.js";
import { lintAdapter } from "./lint.js";

const codes = (findings: readonly Finding[]): string[] => findings.map(item => `${item.severity}:${item.code}`);

describe("lintAdapter", () => {
  it("accepts a self-contained adapter", () => {
    expect(lintAdapter(`const helper = value => value + 1;\nexport default host => ({ main: () => helper(0) });\n`)).toEqual([]);
  });

  it.each([
    ["a static import", `import x from "pkg";\nexport default () => x;\n`, "imports \"pkg\" at run time"],
    ["an export-all", `export * from "pkg";\nexport default () => 0;\n`, "imports \"pkg\" at run time"],
    ["a re-export", `export { x } from "pkg";\nexport default () => 0;\n`, "re-exports from \"pkg\""],
    ["a dynamic import", `export default async () => (await import("./late.js")).value;\n`, "dynamic import()"],
    ["importScripts", `export default () => importScripts("https://example.test/x.js");\n`, "importScripts()"],
  ])("rejects %s as an error", (_label, code, fragment) => {
    const found = lintAdapter(code);
    expect(codes(found)).toEqual(["error:adapter-import"]);
    expect(found[0]?.message).toContain(fragment);
  });

  it("reports each import error separately, in source order", () => {
    const found = lintAdapter(`import a from "one";\nimport b from "two";\nexport default () => [a, b];\n`);
    expect(found.map(item => item.line)).toEqual([1, 2]);
    expect(found.map(item => item.message.match(/"(\w+)"/u)?.[1])).toEqual(["one", "two"]);
  });

  it("treats a dynamic import or importScripts in dependency code as a warning, since dormant branches are common there, and the author's own as an error", () => {
    const where = (line: number): { file: string; line: number } => ({ file: line === 2 ? "src/own.ts" : "node_modules/lib/index.js", line });
    const found = lintAdapter(`const a = name => import(name);\nconst b = name => import(name);\nconst c = () => importScripts("x");\nconst d = () => importScripts("y");\nexport default () => [a, b, c, d];\n`, where);
    expect(found.map(item => `${item.severity}:${item.code}:${item.file ?? ""}`)).toEqual(["warning:adapter-import:node_modules/lib/index.js", "error:adapter-import:src/own.ts", "warning:adapter-import:node_modules/lib/index.js"]);
    expect(found[2]?.message).toContain("(2 places in this file)");
  });

  it("warns about import.meta, whose URL is the blob the adapter is loaded from", () => {
    const found = lintAdapter(`export default () => new URL("x.wasm", import.meta.url);\n`);
    expect(codes(found)).toEqual(["warning:adapter-meta"]);
    expect(found[0]?.message).toContain("host.artifacts.url");
  });

  it.each([
    ["window", `export default () => window.name;\n`],
    ["document", `export default () => document.title;\n`],
    ["localStorage", `export default () => localStorage.getItem("k");\n`],
    ["alert", `export default () => alert("x");\n`],
  ])("warns about the page-only global %s", (name, code) => {
    const found = lintAdapter(code);
    expect(codes(found)).toEqual(["warning:adapter-global"]);
    expect(found[0]?.message).toContain(name);
  });

  it("leaves alone names that only look like page globals", () => {
    expect(lintAdapter(`const document = { title: "x" };\nexport default () => document.title;\n`)).toEqual([]);
    expect(lintAdapter(`export default window => window.name;\n`)).toEqual([]);
    expect(lintAdapter(`export default () => typeof window === "undefined";\n`)).toEqual([]);
    expect(lintAdapter(`export default object => object.window + object.document;\n`)).toEqual([]);
    expect(lintAdapter(`export default () => ({ window: 1, document: 2 });\n`)).toEqual([]);
    expect(lintAdapter(`export default () => { try { return 1; } catch (alert) { return alert; } };\n`)).toEqual([]);
    expect(lintAdapter(`class window {}\nexport default () => window;\n`)).toEqual([]);
    expect(lintAdapter(`export default ({ document }) => document;\n`)).toEqual([]);
  });

  it.each([
    ["eval", `export default code => eval(code);\n`, "eval is blocked"],
    ["new Function", `export default body => new Function(body);\n`, "new Function is blocked"],
    ["Function", `export default body => Function(body);\n`, "new Function is blocked"],
  ])("warns about %s", (_label, code, fragment) => {
    const found = lintAdapter(code);
    expect(codes(found)).toEqual(["warning:adapter-eval"]);
    expect(found[0]?.message).toContain(fragment);
  });

  it("does not warn about a mention of eval or Function that is not a call", () => {
    expect(lintAdapter(`export default value => value instanceof Function && typeof eval === "function";\n`)).toEqual([]);
  });

  it("reports repeated warnings once, with the count, and keeps different ones apart", () => {
    const found = lintAdapter(`export default () => [window.a, window.b, window.c, document.d];\n`);
    expect(found.map(item => item.message)).toEqual([
      "window does not exist in a worker; the adapter fails when this runs (3 places in this file)",
      "document does not exist in a worker; the adapter fails when this runs",
    ]);
  });

  it("keeps warnings from different files apart", () => {
    const locate = (line: number): { file: string; line: number } => ({ file: line === 1 ? "a.js" : "b.js", line });
    const found = lintAdapter(`const a = window.x;\nconst b = window.y;\nexport default () => [a, b];\n`, locate);
    expect(found.map(item => item.file)).toEqual(["a.js", "b.js"]);
  });

  it("locates findings through the supplied mapping, one-based in both line and column", () => {
    const found = lintAdapter(`\n  export default () => window.x;\n`, (line, column) => ({ file: "src/adapter.ts", line: line + 10, column: column + 1 }));
    expect(found[0]).toMatchObject({ file: "src/adapter.ts", line: 12, column: 24 });
  });

  it("locates findings in the bundle itself when nothing maps them", () => {
    expect(lintAdapter(`\nimport x from "pkg";\nexport default x;\n`)[0]).toMatchObject({ file: "adapter.mjs", line: 2, column: 1 });
  });

  it("fails the build when the bundle does not parse", () => {
    expect(() => lintAdapter("export default (")).toThrow(BuildFailure);
  });
});
