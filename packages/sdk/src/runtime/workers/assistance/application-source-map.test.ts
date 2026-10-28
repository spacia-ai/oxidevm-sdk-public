import { VMError } from "../../errors.ts";
import { expect, it } from "vitest";
import { loadApplicationSourceMap } from "./application-source-map.ts";

it("loads relative maps through Linux reads and normalizes original URLs", () => {
  const reads: string[] = [];
  const source = "throw 1;\n//# sourceMappingURL=maps/app.js.map\n";
  const map = loadApplicationSourceMap("/workspace/app.js", source, path => {
    reads.push(path);
    return JSON.stringify({ version: 3, sources: ["original.ts"], sourceRoot: "../src/", names: [], mappings: "AAAA;" });
  });
  expect(reads).toEqual(["/workspace/maps/app.js.map"]);
  expect(map?.payload["sources"]).toEqual(["file:///workspace/src/original.ts"]);
  expect(map?.payload["sourceRoot"]).toBe("");
  expect(map?.lineLengths).toEqual([8, 36, 0]);
});

it("uses the last inline directive without granting network access", () => {
  const payload = JSON.stringify({ version: 3, sources: ["a.ts"], names: [], mappings: "AAAA;" });
  const source = `//# sourceMappingURL=https://host/forbidden.map\n//# sourceMappingURL=data:application/json;base64,${btoa(payload)}`;
  const read = () => { throw new Error("Unexpected file read"); };
  expect(loadApplicationSourceMap("/workspace/a.js", source, read)?.findEntry(0, 0).originalSource).toBe("file:///workspace/a.ts");
  expect(loadApplicationSourceMap("/workspace/a.js", "//# sourceMappingURL=https://host/a.map", read)).toBeUndefined();
  expect(loadApplicationSourceMap("/workspace/a.js", "//# sourceMappingURL=data:application/json;base64,eA==", read)).toBeUndefined();
});

it("ignores malformed optional metadata but preserves authority failures", () => {
  for (const payload of ["null", "[]", "1", "{}", "{"]) {
    expect(loadApplicationSourceMap("/app.js", `//# sourceMappingURL=data:application/json;base64,${btoa(payload)}`, () => "")).toBeUndefined();
  }
  const failure = new VMError("ABORTED", "Process retired");
  expect(() => loadApplicationSourceMap("/app.js", "//# sourceMappingURL=app.map", () => { throw failure; })).toThrow(failure);
});
