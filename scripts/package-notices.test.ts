import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedCompilerComponents } from "./package-notices.ts";

await test("bundled compiler inventories cannot hide AND terms or reuse a build-only license exception", () => {
  const allowed = new Set(["MIT", "Unicode-DFS-2016"]);
  const component = (declared: string, selected: string) => ({ type: "library", name: "fixture", licenses: [{ expression: selected }], properties: [{ name: "oxidevm:declared-license", value: declared }] });
  assert.equal(checkedCompilerComponents([component("MIT OR GPL-2.0-only", "MIT")], allowed).length, 1);
  assert.throws(() => checkedCompilerComponents([component("MIT AND Unicode-DFS-2016", "MIT")], allowed), /branch|obligations/u);
  assert.throws(() => checkedCompilerComponents([component("MPL-2.0", "MPL-2.0")], allowed), /branch|obligations/u);
  assert.throws(() => checkedCompilerComponents([{}], allowed));
});
