import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { record, string } from "../../decode.js";
import { hasModuleSyntax, typelessPackageWarning } from "./module-detection.js";

const control = record(JSON.parse(readFileSync(new URL("./module-detection.controls.json", import.meta.url), "utf8")), "module detection controls");
const recorder = fileURLToPath(new URL("../../../../../../tests/fixtures/assistance/node-module-detection.cjs", import.meta.url));

it("replays the recorder the controls came from", () => {
  expect(createHash("sha256").update(readFileSync(recorder)).digest("hex")).toBe(control["recorderSHA256"]);
  expect(record(control["node"], "pinned Node")).toEqual({ binarySHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", version: "v24.18.1" });
});

it("detects module syntax in a typeless .js file exactly where pinned Node does", () => {
  const rows = control["rows"];
  if (!Array.isArray(rows) || rows.length !== 29) throw new Error("Incomplete module detection controls");
  for (const value of rows) {
    const row = record(value, "module detection control"), name = string(row["name"], "case");
    expect({ name, format: hasModuleSyntax(string(row["source"], "source"), `/workspace/${name}.js`) ? "module" : "commonjs" }).toEqual({ name, format: row["format"] });
  }
});

it("words the typeless package warning as Node does", () => {
  expect(typelessPackageWarning("file:///workspace/a.js", "/workspace/package.json")).toBe(
    "Module type of file:///workspace/a.js is not specified and it doesn't parse as CommonJS.\n"
    + "Reparsing as ES module because module syntax was detected. This incurs a performance overhead.\n"
    + "To eliminate this warning, add \"type\": \"module\" to /workspace/package.json.");
});
