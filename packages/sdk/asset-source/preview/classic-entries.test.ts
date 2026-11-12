import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext, Script } from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import { bundleClassicEntry, CLASSIC_FILES, classicEntryFor } from "./classic-entries";

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

  describe("built script", () => {
    it.each(CLASSIC_FILES)("%s compiles as a classic script without a source map", async (file) => {
      const code = await bundleClassicEntry(import.meta.dirname, file, true);
      expect(() => new Script(code)).not.toThrow();
      expect(code).not.toContain("sourceMappingURL");
    });

    it("keeps top-level names out of the page's global scope", async () => {
      const root = fixture("const a = 1; let s = 2; class c {}");
      const page = createContext({});
      runInContext(await bundleClassicEntry(root, "location.js", true), page);
      runInContext("const a = 'app'; let s = 'app'; class c {}", page);
      const value: unknown = runInContext("a", page);
      expect(value).toBe("app");
    });

    it("fails the build when a classic source uses import.meta", async () => {
      const root = fixture("console.log(new URL('./x.json', import.meta.url));");
      await expect(bundleClassicEntry(root, "location.js", true)).rejects.toThrow("location.js must be a classic script");
    });
  });
});

/** The fixture roots a test made; each is removed after its test. */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "classic-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/location.ts"), `${source}\n`);
  return root;
}
