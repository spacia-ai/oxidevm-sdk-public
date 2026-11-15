import { posix } from "node:path";
import { expect, it } from "vitest";
import { createCommonJSLoader } from "./commonjs.js";
import { ExecutableSources } from "./executable-sources.js";
import type { LocalModuleFiles } from "./module-files.js";

function fixture() {
  const counts = { resolve: 0, admit: 0, read: 0 };
  const sources = new Map([["/workspace/a.js", "first"], ["/workspace/b.js", "second"], ["/other/a.js", "other"]]);
  let cwd = "/workspace";
  const files: LocalModuleFiles = {
    resolve: path => path,
    read(path) {
      counts.read++;
      const source = sources.get(path);
      if (source === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { source, format: "commonjs" };
    },
  };
  const loader = createCommonJSLoader(files, {}, (request, parent) => {
    counts.resolve++;
    if (typeof request !== "string") throw new TypeError("Invalid module request");
    return posix.resolve(parent === undefined ? cwd : posix.dirname(parent), request);
  }, () => { counts.admit++; }, (source, _filename, module) => {
    if (source === "fail") throw new Error("compile failed");
    module.exports = { source };
  }, { cwd: () => cwd, sources: new ExecutableSources() });
  return { loader, counts, sources, cwd: (value: string) => { cwd = value; } };
}

it("returns already admitted cached exports without another filesystem resolution", () => {
  const { loader, counts } = fixture();
  const require = loader.Module.createRequire("/workspace/main.js");
  const first = require("./a.js"), before = { ...counts };
  for (let index = 0; index < 10; index++) expect(require("./a.js")).toBe(first);
  expect(counts).toEqual(before);
  expect(require.resolve("./a.js")).toBe("/workspace/a.js");
  expect(counts.resolve).toBe(before.resolve + 1);
});

it("observes cache replacement and deletion while preserving loaded mutable source semantics", () => {
  const { loader, sources } = fixture();
  const require = loader.Module.createRequire("/workspace/main.js"), first = require("./a.js");
  sources.set("/workspace/a.js", "edited");
  expect(require("./a.js")).toBe(first);
  const replacement = { changed: true };
  loader.Module._cache["/workspace/a.js"] = { exports: replacement };
  expect(require("./a.js")).toBe(replacement);
  Reflect.deleteProperty(loader.Module._cache, "/workspace/a.js");
  expect(require("./a.js")).toEqual({ source: "edited" });
});

it("runs a replaced resolver hook even when the request has a cached result", () => {
  const { loader } = fixture(), require = loader.Module.createRequire("/workspace/main.js");
  expect(require("./a.js")).toEqual({ source: "first" });
  const original = loader.Module._resolveFilename.bind(loader.Module);
  loader.Module._resolveFilename = () => "/workspace/b.js";
  expect(require("./a.js")).toEqual({ source: "second" });
  loader.Module._resolveFilename = original;
  expect(require("./a.js")).toEqual({ source: "first" });
});

it("keeps resolution scoped to parent, cwd and process and retries only a failed module load", () => {
  const test = fixture();
  expect(test.loader.require("./a.js")).toEqual({ source: "first" });
  test.cwd("/other");
  expect(test.loader.require("./a.js")).toEqual({ source: "other" });
  const other = fixture();
  other.sources.set("/workspace/a.js", "fail");
  expect(() => other.loader.require("./a.js")).toThrow("compile failed");
  other.sources.set("/workspace/a.js", "fixed");
  expect(other.loader.require("./a.js")).toEqual({ source: "fixed" });
  expect(other.counts.resolve).toBe(2);
});

it("preloads --require modules from the working directory under Node's dummy parent, before the main module (ADR 0026, 1.11)", () => {
  const { loader, cwd } = fixture();
  cwd("/other");
  loader.preload(["./a.js"]);
  expect(loader.Module._cache["/other/a.js"]).toMatchObject({ id: "/other/a.js", exports: { source: "other" }, parent: { id: "internal/preload", paths: ["/other/node_modules", "/node_modules"] } });
  cwd("/workspace");
  // A preload never becomes the main module; the entry still does.
  expect(loader.require("./b.js")).toEqual({ source: "second" });
  expect(loader.Module._cache["/workspace/b.js"]).toMatchObject({ id: "." });
});

it("names a late failure when require meets an ES module, which Node 24 would load", () => {
  const files: LocalModuleFiles = { resolve: path => path, read: () => ({ source: "export default 1", format: "module" }) };
  const loader = createCommonJSLoader(files, {}, request => { if (typeof request !== "string") throw new TypeError("Invalid module request"); return posix.resolve("/workspace", request); },
    () => undefined, () => undefined, { cwd: () => "/workspace", sources: new ExecutableSources() });
  let thrown: unknown;
  try { loader.Module.createRequire("/workspace/main.js")("./esm.js"); } catch (error) { thrown = error; }
  expect(thrown).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { lateFailure: "unavailable-builtin", subject: "require(esm)", path: "/workspace/esm.js" } });
});
