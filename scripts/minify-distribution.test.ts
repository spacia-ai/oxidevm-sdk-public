import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { minifyDistribution, minifyGuestPrograms } from "./minify-distribution.ts";
import { minifyJavaScript } from "./production-javascript.ts";

void test("the packed implementation is minified without changing exports, names, licenses or declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-minify-"));
  try {
    const source = "/** @license Fixture MIT */\nexport function publicAnswer(originalArgument) { const verboseImplementationValue = originalArgument + 2; return verboseImplementationValue; }\n//# sourceMappingURL=answer.js.map\n";
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "answer.js"), source);
    await writeFile(join(root, "answer.js.map"), '{"sourcesContent":["private source"]}');
    await writeFile(join(root, "answer.d.ts.map"), "{}");
    await writeFile(join(root, "answer.d.ts"), "export declare function publicAnswer(value: number): number;\n//# sourceMappingURL=answer.d.ts.map\n");
    assert.equal(await minifyDistribution(root), 1);
    const code = await readFile(join(root, "answer.js"), "utf8");
    assert(!code.includes("verboseImplementationValue"));
    assert(!code.includes("sourceMappingURL"));
    assert(code.includes("Fixture MIT"));
    assert(!(await readdir(root)).some(name => name.endsWith(".map")));
    assert(!(await readFile(join(root, "answer.d.ts"), "utf8")).includes("sourceMappingURL"));
    const module: unknown = await import(pathToFileURL(join(root, "answer.js")).href);
    assert(isAnswerModule(module));
    assert.equal(module.publicAnswer(40), 42);
    assert.equal(module.publicAnswer.name, "publicAnswer");
  } finally { await rm(root, { recursive: true, force: true }); }
});

void test("classic worker code keeps its side effects and CLI shebangs survive", async () => {
  assert((await minifyJavaScript("#!/usr/bin/env node\nconsole.log(42);")).startsWith("#!/usr/bin/env node\n"));
  const code = await minifyJavaScript("self.onmessage = event => self.postMessage(event.data + 2);");
  assert(code.includes("self.onmessage="));
  assert(!/\b(?:import|export)\b/u.test(code));
});

function isAnswerModule(value: unknown): value is { readonly publicAnswer: (value: number) => unknown } {
  return typeof value === "object" && value !== null && "publicAnswer" in value && typeof value.publicAnswer === "function";
}

void test("fixed guest programs are minified after assembly and still execute in Node", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-guest-minify-"));
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    const directory = join(root, "runtime/workers/assistance");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "node-brotli-guest.js");
    await writeFile(path, 'export const brotliGuestSource = String.raw`const verboseGuestImplementation = 40; console.log(verboseGuestImplementation + 2);`;');
    await minifyGuestPrograms(root);
    const text = await readFile(path, "utf8");
    assert(!text.includes("verboseGuestImplementation"));
    const module: unknown = await import(pathToFileURL(path).href + "?minified");
    assert(typeof module === "object" && module !== null && "brotliGuestSource" in module && typeof module.brotliGuestSource === "string");
    assert.equal(execFileSync(process.execPath, ["-e", module.brotliGuestSource], { encoding: "utf8" }), "42\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
