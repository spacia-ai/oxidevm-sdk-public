import { describe, expect, it } from "vitest";
import { GENERATED_MARKER, moduleIdentifier, renderHandles } from "./generate.js";
import { buildReleaseFiles } from "./release.test-support.js";

describe("module identifiers", () => {
  it("turns kebab-case ids into camelCase names and rejects reserved words", () => {
    expect(moduleIdentifier("pglite")).toBe("pglite");
    expect(moduleIdentifier("my-tool")).toBe("myTool");
    expect(moduleIdentifier("a-b-c1")).toBe("aBC1");
    // `module-handle` would become `moduleHandle`, the name of the import the generated file itself uses.
    for (const id of ["delete", "class", "new", "import", "module-handle"]) expect(() => moduleIdentifier(id), id).toThrow(/cannot be exported/u);
  });
});

describe("generated handles", () => {
  const release = buildReleaseFiles({ id: "my-tool", artifacts: { "tool.wasm": Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0), "NOTICE": new TextEncoder().encode("n") } });
  const spec = (id = "my-tool", directory = "../.oxidevm/modules/my-tool/abc") => ({
    manifest: { ...release.manifest, id }, release: "r".repeat(64), directory,
    files: [{ name: "adapter.mjs", sha256: "a".repeat(64), bytes: 10 }, { name: "tool.wasm", sha256: "b".repeat(64), bytes: 8 }, { name: "NOTICE", sha256: "c".repeat(64), bytes: 1 }],
  });

  it("starts with the marker and imports only the handle constructor", () => {
    const text = renderHandles([spec()]);
    expect(text.startsWith(`${GENERATED_MARKER}\nimport { moduleHandle } from "@oxidevm/sdk/wasm";\n`)).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("exports one handle per module, ordered by id, with the manifest literal and URL-resolved pins", () => {
    const text = renderHandles([spec("zeta"), spec("alpha")]);
    expect(text.indexOf("export const alpha")).toBeGreaterThan(0);
    expect(text.indexOf("export const alpha")).toBeLessThan(text.indexOf("export const zeta"));
    expect(text).toContain('"id": "alpha"');
    expect(text).toContain('adapter: { url: new URL("../.oxidevm/modules/my-tool/abc/adapter.mjs.bin", import.meta.url).href, sha256: "' + "a".repeat(64) + '", bytes: 10 },');
    expect(text).toContain('"tool.wasm": { url: new URL("../.oxidevm/modules/my-tool/abc/tool.wasm", import.meta.url).href');
    expect(text).toContain('release: "' + "r".repeat(64) + '"');
  });

  it("points scripts, stylesheets and pages at their served copies, and everything else at the file itself", () => {
    const text = renderHandles([{ ...spec(), files: [
      { name: "adapter.mjs", sha256: "a".repeat(64), bytes: 10 }, { name: "worker.js", sha256: "d".repeat(64), bytes: 20 }, { name: "style.css", sha256: "e".repeat(64), bytes: 30 },
      { name: "tool.wasm", sha256: "b".repeat(64), bytes: 8 }, { name: "pyodide-lock.json", sha256: "f".repeat(64), bytes: 40 },
    ] }]);
    expect(text).toContain('adapter: { url: new URL("../.oxidevm/modules/my-tool/abc/adapter.mjs.bin", import.meta.url).href, sha256: "' + "a".repeat(64) + '", bytes: 10 }');
    expect(text).toContain('"worker.js": { url: new URL("../.oxidevm/modules/my-tool/abc/worker.js.bin", import.meta.url).href, sha256: "' + "d".repeat(64) + '", bytes: 20 }');
    expect(text).toContain('"style.css": { url: new URL("../.oxidevm/modules/my-tool/abc/style.css.bin", import.meta.url).href');
    expect(text).toContain('"tool.wasm": { url: new URL("../.oxidevm/modules/my-tool/abc/tool.wasm", import.meta.url).href');
    expect(text).toContain('"pyodide-lock.json": { url: new URL("../.oxidevm/modules/my-tool/abc/pyodide-lock.json", import.meta.url).href');
  });

  it("is deterministic and valid even with no modules", () => {
    expect(renderHandles([spec()])).toBe(renderHandles([spec()]));
    expect(renderHandles([])).toContain("export {};");
  });

  it("refuses two ids that would share a JavaScript name, and a release with no adapter", () => {
    expect(() => renderHandles([spec("my-tool"), spec("myTool")])).toThrow();
    expect(() => renderHandles([{ ...spec(), files: [] }])).toThrow(/no adapter.mjs/u);
  });
});
