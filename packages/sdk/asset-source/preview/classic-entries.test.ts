import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { assertClassicChunk, bundleClassicEntry, CLASSIC_FILES, classicEntryFor, classicScript } from "./classic-entries";

describe("classic preview scripts", () => {
  it("serves the worker and page scripts under the /__oxidevm/ base", () => {
    expect(classicEntryFor("/__oxidevm/sw.js")).toBe("sw.js");
    expect(classicEntryFor("/__oxidevm/websocket.js")).toBe("websocket.js");
    expect(classicEntryFor("/__oxidevm/location.js")).toBe("location.js");
    expect(classicEntryFor("/src/service-worker.ts")).toBeUndefined();
    expect(classicEntryFor("/__oxidevm/bootstrap.js")).toBeUndefined();
  });

  it.each(CLASSIC_FILES)("bundles %s into a classic script", async (file) => {
    const code = await bundleClassicEntry(import.meta.dirname, file);
    expect(code.length).toBeGreaterThan(0);
    expect(code).not.toMatch(/^\s*(?:import|export)\b/mu);
    expect(code).not.toContain("import.meta");
  });

  it("keeps a built script's top-level names out of the page's global scope", () => {
    const page = createContext({});
    runInContext(classicScript("const a = 1; let s = 2; class c {}"), page);
    runInContext(classicScript("const a = 3;"), page);
    runInContext("const a = 'app'; let s = 'app'; class c {}", page);
    const value: unknown = runInContext("a", page);
    expect(value).toBe("app");
  });

  it("would break the app's own script without the wrapper", () => {
    const page = createContext({});
    runInContext("const a = 1;", page);
    expect(() => { runInContext("const a = 'app';", page); }).toThrow("Identifier 'a' has already been declared");
  });

  it("rejects a built classic chunk that imports or exports", () => {
    expect(() => assertClassicChunk({ fileName: "sw.js", imports: ["assets/policy-x.js"], dynamicImports: [], exports: [], code: "" }))
      .toThrow("sw.js must be a classic script");
    expect(() => assertClassicChunk({ fileName: "websocket.js", imports: [], dynamicImports: [], exports: ["default"], code: "" }))
      .toThrow("websocket.js must be a classic script");
    expect(() => assertClassicChunk({ fileName: "sw.js", imports: [], dynamicImports: [], exports: [], code: "console.log(import.meta.url)" }))
      .toThrow("sw.js must be a classic script");
    expect(() => assertClassicChunk({ fileName: "sw.js", imports: [], dynamicImports: [], exports: [], code: "self.addEventListener('fetch', () => undefined);" }))
      .not.toThrow();
  });
});
