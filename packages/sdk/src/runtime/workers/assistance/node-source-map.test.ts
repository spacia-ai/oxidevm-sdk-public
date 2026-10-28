import { expect, it } from "vitest";
import { SourceMap } from "./node-source-map.ts";

const payload = { version: 3, sources: ["original.ts"], sourceRoot: "/ignored-by-SourceMap", names: ["answer"], mappings: "AAAA,KAAEA;;EACFA", sourcesContent: ["original source"] };

it("finds zero-based mapping ranges and one-based origins across empty lines", () => {
  const map = new SourceMap(payload, { lineLengths: [10, 0, 8] });
  expect(map.findEntry(-1, 0)).toEqual({});
  expect(map.findEntry(0, 5)).toEqual({ generatedLine: 0, generatedColumn: 5, originalSource: "original.ts", originalLine: 0, originalColumn: 2, name: "answer" });
  expect(map.findOrigin(2, 8)).toEqual({ name: "answer", fileName: "original.ts", lineNumber: 2, columnNumber: 5 });
  expect(map.lineLengths).toEqual([10, 0, 8]);
  expect(map.payload).toEqual(payload);
  expect(map.payload).not.toBe(payload);
});

it("keeps source positions distinct from unmapped spans and section offsets", () => {
  const map = new SourceMap({ version: 3, sections: [
    { offset: { line: 0, column: 3 }, map: { version: 3, sources: ["one.ts"], names: [], mappings: "AAAA,K;" } },
    { offset: { line: 2, column: 1 }, map: { version: 3, sources: ["two.ts"], names: [], mappings: "AAAA;AACA" } },
  ] });
  expect(map.findEntry(0, 2)).toEqual({});
  expect(map.findEntry(0, 8)).toEqual({ generatedLine: 0, generatedColumn: 8, originalSource: undefined, originalLine: undefined, originalColumn: undefined, name: undefined });
  expect(map.findOrigin(2, 9)).toEqual({});
  expect(map.findOrigin(3, 2)).toEqual({ name: undefined, fileName: "two.ts", lineNumber: 1, columnNumber: 1 });
  expect(map.findOrigin(4, 1)).toEqual({ name: undefined, fileName: "two.ts", lineNumber: 2, columnNumber: 1 });
});

it("isolates payload arrays and rejects corrupt mapping indices and truncated VLQ", () => {
  const original = { version: 3, sources: ["source.ts"], names: [], mappings: "AAAA" };
  const map = new SourceMap(original);
  original.sources[0] = "changed.ts";
  const copy = map.payload;
  if (!Array.isArray(copy["sources"])) throw new Error("Missing sources");
  copy["sources"].push("other.ts");
  expect(map.findEntry(0, 0).originalSource).toBe("source.ts");
  expect(map.payload["sources"]).toEqual(["source.ts"]);
  for (const mappings of ["!", "g", "ACAA", "AA"])
    expect(() => new SourceMap({ ...original, mappings })).toThrow(TypeError);
});

it("preserves managed Node 24 EOF cursor behavior without rewriting payload", () => {
  for (const mappings of ["AAAA,K", "K", "AAAA"]) {
    const value = { version: 3, sources: ["one"], names: ["name"], mappings };
    const map = new SourceMap(value);
    expect(map.findEntry(10, 10)).toEqual({ generatedLine: 0, generatedColumn: mappings.includes("K") ? 5 : 0,
      originalSource: "one", originalLine: 0, originalColumn: 0, name: "name" });
    expect(map.payload).toEqual(value);
  }
  expect(new SourceMap({ version: 3, sources: ["one"], names: ["name"], mappings: "AAAA;" }).findEntry(10, 10).name).toBeUndefined();
});

it("preserves null source identities and bounds recursive sections", () => {
  expect(new SourceMap({ version: 3, sources: [null], names: [], mappings: "AAAA;" }).findOrigin(1, 1))
    .toEqual({ name: undefined, fileName: null, lineNumber: 1, columnNumber: 1 });
  const recursive: Record<string, unknown> = { version: 3 };
  recursive["sections"] = [{ offset: { line: 0, column: 0 }, map: recursive }];
  expect(() => new SourceMap(recursive)).toThrow("Source-map section depth exhausted");
});

it("maps large compiled bundles within the encoded and decoded budgets", () => {
  const count = 1_048_577;
  const map = new SourceMap({ version: 3, sources: ["bundle.mjs"], names: [], mappings: "AAAA;".repeat(count) });
  expect(map.findEntry(count - 1, 10)).toMatchObject({ generatedLine: count - 1, generatedColumn: 0, originalSource: "bundle.mjs", originalLine: 0, originalColumn: 0 });
  expect(() => new SourceMap({ version: 3, sources: [], names: [], mappings: "A".repeat(16 * 1024 * 1024 + 1) })).toThrow("Source-map encoded budget exhausted");
  expect(() => new SourceMap({ version: 3, sources: [], names: [], mappings: ";".repeat(4_194_304) })).toThrow("Source-map decoded budget exhausted");
});
