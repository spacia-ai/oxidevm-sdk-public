import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as compilerNamespace from "@swc/wasm-web";
import { record } from "../../decode.js";
import { initializeCompiler } from "./compiler.js";
import { createGuestModules } from "./guest-modules.js";
import { createLocalModuleLoader } from "./module-loader.js";

const control = record(JSON.parse(readFileSync(new URL("./require-esm.controls.json", import.meta.url), "utf8")), "require(esm) controls");
const fixture = fileURLToPath(new URL("../../../../../../tests/fixtures/assistance/require-esm", import.meta.url));
/** Where the replay places the fixture in the guest, as a project folder. */
const ROOT = "/workspace/require-esm";

function fixtureFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(relative(fixture, path), readFileSync(path, "utf8"));
    }
  };
  walk(fixture);
  return files;
}

it("replays the fixture the controls were recorded from", () => {
  const expected = record(control["fixtureSHA256"], "fixture hashes");
  const actual = Object.fromEntries([...fixtureFiles()].map(([path, text]) => [path, createHash("sha256").update(text).digest("hex")]));
  expect(actual).toEqual(expected);
  expect(record(control["node"], "pinned Node")).toEqual({ binarySHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", version: "v24.18.1" });
});

it("requires ES modules as pinned Node does: namespaces, module.exports, top-level await, cycles, errors and one evaluation", async () => {
  const sources = new Map([...fixtureFiles()].map(([path, text]) => [`${ROOT}/${path}`, text]));
  // The recorder ran from `node -e`, whose require is rooted at `<cwd>/[eval]`.
  sources.set(`${ROOT}/replay.cjs`, `module.exports = require("./recorder.cjs").run(require("node:module").createRequire(${JSON.stringify(`${ROOT}/[eval]`)}));`);
  const directories = new Set([...sources.keys()].flatMap(path => {
    const parts = path.split("/").slice(1, -1);
    return parts.map((_, index) => `/${parts.slice(0, index + 1).join("/")}`);
  }));
  const files = {
    readFileSync(path: string): string {
      const value = sources.get(path);
      if (value === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return value;
    },
    statSync(path: string) {
      if (sources.has(path)) return { isFile: () => true, isDirectory: () => false };
      if (directories.has(path)) return { isFile: () => false, isDirectory: () => true };
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    },
    realpathSync(path: string): string { return path; },
  };
  const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const system = await readFile(require.resolve("systemjs/dist/s.js"), "utf8");
  // A launch's dependency identity, as an admitted process has one: package specifiers resolve only with it.
  const modules = createGuestModules(files, { generation: 1n, profile: "node24-bun1-v1", roots: [{ kind: "dependencies", path: `${ROOT}/node_modules` }], runtime: "node", moduleSearchPaths: [] });
  const loader = createLocalModuleLoader(compiler, system, modules, {}, ROOT);
  const result: unknown = await loader.require(`${ROOT}/replay.cjs`);
  const expected = control["rows"];
  if (!Array.isArray(expected) || expected.length !== 23) throw new Error("Incomplete require(esm) controls");
  const actual = record(result, "replay result")["rows"];
  if (!Array.isArray(actual)) throw new Error("The replay returned no rows");
  for (const [index, row] of expected.entries()) {
    const label = record(row, "control row")["label"];
    expect(actual[index], String(label)).toEqual(row);
  }
  expect(actual).toHaveLength(expected.length);
});
