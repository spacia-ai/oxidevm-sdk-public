import { lstat, mkdir, readdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeModuleManifest } from "../../../wasm/manifest.js";
import { readReleaseDirectory } from "../release.js";
import { sha256Hex } from "../sums.js";
import { moduleSource, projects } from "./author.test-support.js";
import { buildModule, MAX_ADAPTER_BYTES } from "./build.js";
import type { BuildResult } from "./build.js";

const project = projects();
const WASM = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);

function manifest(overrides: { readonly license?: string; readonly artifacts?: string } = {}): string {
  const artifacts = overrides.artifacts ?? `[{ name: "tool.wasm", from: "upstream/tool.wasm" }, { name: "NOTICES.txt", from: "NOTICES.txt" }]`;
  return `{ id: "demo", version: "1.2.3", abi: "raw", artifacts: ${artifacts}, process: { kind: "command" }, requires: { host: ["files.sync"] }, license: ${overrides.license ?? `{ spdx: "MIT", notices: ["NOTICES.txt"] }`} }`;
}
function files(extra: Readonly<Record<string, string | Uint8Array>> = {}, source = moduleSource({ manifest: manifest() })): Record<string, string | Uint8Array> {
  return { "module.ts": source, "upstream/tool.wasm": WASM, "NOTICES.txt": "Notices\n", ...extra };
}
const errors = (result: BuildResult): string[] => result.findings.filter(item => item.severity === "error").map(item => item.code);
const warnings = (result: BuildResult): string[] => result.findings.filter(item => item.severity === "warning").map(item => item.code);
async function exists(path: string): Promise<boolean> { return lstat(path).then(() => true, () => false); }

describe("buildModule", () => {
  it("writes a complete release whose id is the digest of its SHA256SUMS", async () => {
    const dir = await project(files());
    const result = await buildModule(dir);
    expect(result).toMatchObject({ result: "built", id: "demo", version: "1.2.3", directory: join(dir, "dist"), findings: [], bundled: [] });
    const release = await readReleaseDirectory(join(dir, "dist"));
    expect(release.id).toBe(result.release);
    expect(release.id).toBe(sha256Hex(await readFile(join(dir, "dist", "SHA256SUMS"))));
    expect(decodeModuleManifest(await readFile(join(dir, "dist", "module.json")))).toMatchObject({ schemaVersion: 1, id: "demo", version: "1.2.3", artifacts: [{ name: "tool.wasm", bytes: WASM.byteLength }, { name: "NOTICES.txt" }] });
    expect((await readdir(join(dir, "dist"))).sort()).toEqual(["NOTICES.txt", "SHA256SUMS", "adapter.mjs", "module.json", "tool.wasm"]);
    expect([...await readFile(join(dir, "dist", "tool.wasm"))]).toEqual([...WASM]);
  });

  it("reports every release file, sorted by name, with the same digests the files have", async () => {
    const dir = await project(files());
    const result = await buildModule(dir);
    expect(result.files.map(file => file.name)).toEqual(["NOTICES.txt", "SHA256SUMS", "adapter.mjs", "module.json", "tool.wasm"]);
    for (const file of result.files) {
      const bytes = await readFile(join(dir, "dist", file.name));
      expect({ sha256: file.sha256, bytes: file.bytes }).toEqual({ sha256: sha256Hex(bytes), bytes: bytes.byteLength });
    }
  });

  it("builds the same release from the same inputs in a different directory", async () => {
    const [first, second] = [await project(files()), await project(files())];
    const [left, right] = [await buildModule(first), await buildModule(second)];
    expect(first).not.toBe(second);
    expect(left.release).toBe(right.release);
    expect(left.files).toEqual(right.files);
  });

  it("changes the release id when an artifact byte changes", async () => {
    const [first, second] = [await project(files()), await project(files({ "upstream/tool.wasm": Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 1) }))];
    expect((await buildModule(first)).release).not.toBe((await buildModule(second)).release);
  });

  it("verifies everything and writes nothing in check mode, naming the release the real build gives", async () => {
    const dir = await project(files());
    const checked = await buildModule(dir, { check: true });
    expect(checked).toMatchObject({ result: "checked", directory: null, findings: [] });
    expect(await exists(join(dir, "dist"))).toBe(false);
    expect(await readdir(dir)).not.toContain("dist");
    expect((await buildModule(dir)).release).toBe(checked.release);
  });

  it("builds into another directory inside the project", async () => {
    const dir = await project(files());
    const result = await buildModule(dir, { out: "build/release" });
    expect(result.directory).toBe(join(dir, "build", "release"));
    expect((await readReleaseDirectory(join(dir, "build", "release"))).id).toBe(result.release);
  });

  it("writes the declared commands into module.json as a sorted set right after process", async () => {
    const dir = await project(files({}, moduleSource({ manifest: manifest().replace("requires:", `commands: ["demo-tool", "demo"], requires:`) })));
    expect((await buildModule(dir)).result).toBe("built");
    const bytes = await readFile(join(dir, "dist", "module.json"));
    const written = decodeModuleManifest(bytes);
    expect(written).toMatchObject({ schemaVersion: 1, adapter: { api: 1 }, commands: ["demo", "demo-tool"] });
    expect(Object.keys(written)).toEqual(["schemaVersion", "id", "version", "abi", "adapter", "artifacts", "process", "commands", "requires", "license"]);
    // A module without commands writes no commands key at all.
    const plain = await project(files());
    await buildModule(plain);
    expect(await readFile(join(plain, "dist", "module.json"), "utf8")).not.toContain("commands");
  });

  it("refuses commands that would make a module require its own command", async () => {
    const own = manifest().replace("requires: { host: [\"files.sync\"] }", `commands: ["demo"], requires: { host: ["files.sync"], guest: { executables: ["/usr/local/bin/demo"] } }`);
    const result = await buildModule(await project(files({}, moduleSource({ manifest: own }))), { check: true });
    expect(result.findings[0]).toMatchObject({ code: "manifest-invalid", file: "module.ts" });
    expect(result.findings[0]?.message).toMatch(/^commands: .*\/usr\/local\/bin\/demo/u);
  });

  it("reads a module kept in a subdirectory", async () => {
    const dir = await project({ "src/module.ts": moduleSource({ manifest: manifest({ artifacts: `[]`, license: `{ spdx: "MIT" }` }) }) });
    expect((await buildModule(dir, { module: "src/module.ts", check: true })).result).toBe("checked");
  });

  describe("replacing an earlier build", () => {
    it("swaps in the new release completely and leaves no staging directories", async () => {
      const dir = await project(files());
      const first = await buildModule(dir);
      await writeFile(join(dir, "module.ts"), moduleSource({ manifest: manifest({ artifacts: `[{ name: "tool.wasm", from: "upstream/tool.wasm" }]`, license: `{ spdx: "MIT" }` }) }));
      const second = await buildModule(dir);
      expect(second.release).not.toBe(first.release);
      expect((await readdir(join(dir, "dist"))).sort()).toEqual(["SHA256SUMS", "adapter.mjs", "module.json", "tool.wasm"]);
      expect((await readdir(dir)).sort()).toEqual(["NOTICES.txt", "dist", "module.ts", "upstream"]);
    });

    it("keeps the earlier build when the new one fails", async () => {
      const dir = await project(files());
      const first = await buildModule(dir);
      await writeFile(join(dir, "module.ts"), `export default 1;\n`);
      expect((await buildModule(dir)).result).toBe("failed");
      expect((await readReleaseDirectory(join(dir, "dist"))).id).toBe(first.release);
    });

    it("does not touch the earlier build when the signal is already aborted", async () => {
      const dir = await project(files());
      const first = await buildModule(dir);
      const controller = new AbortController();
      controller.abort();
      await expect(buildModule(dir, { signal: controller.signal })).rejects.toMatchObject({ code: "ABORTED" });
      expect((await readReleaseDirectory(join(dir, "dist"))).id).toBe(first.release);
    });
  });

  describe("the module file", () => {
    it.each(["../module.ts", "/etc/module.ts", "module.js", "module.tsx", "src//module.ts", "sub/../module.ts", "", "module.ts "])("refuses the path %j", async path => {
      const dir = await project(files({ "module.js": moduleSource(), "module.tsx": moduleSource() }));
      const result = await buildModule(dir, { module: path });
      expect(result).toMatchObject({ result: "failed", id: null, directory: null });
      expect(errors(result)).toEqual(["module-source"]);
    });

    it("says what to do when there is no module file", async () => {
      const dir = await project({});
      const result = await buildModule(dir);
      expect(result.findings[0]).toMatchObject({ severity: "error", code: "module-source", file: "module.ts" });
      expect(result.findings[0]?.message).toContain("oxidevm wasm init");
    });

    it("refuses a module file that is a symbolic link", async () => {
      const dir = await project({ "real.ts": moduleSource({ manifest: manifest({ artifacts: `[]`, license: `{ spdx: "MIT" }` }) }) });
      await symlink(join(dir, "real.ts"), join(dir, "module.ts"));
      const result = await buildModule(dir);
      expect(errors(result)).toEqual(["module-source"]);
      expect(result.findings[0]?.message).toContain("regular file");
    });

    it("fails with the manifest finding, located, and no release id", async () => {
      const dir = await project(files({}, moduleSource({ manifest: manifest().replace("\"1.2.3\"", "VERSION") })));
      const result = await buildModule(dir);
      expect(result).toMatchObject({ result: "failed", id: null, version: null, release: null, files: [] });
      expect(result.findings[0]).toMatchObject({ code: "manifest-literal", file: "module.ts", line: 3 });
      expect(await exists(join(dir, "dist"))).toBe(false);
    });

    it("names the module and version of a manifest that is valid but whose build failed later", async () => {
      const dir = await project(files());
      await rm(join(dir, "NOTICES.txt"));
      const result = await buildModule(dir);
      expect(result).toMatchObject({ result: "failed", id: "demo", version: "1.2.3", release: null });
      expect(errors(result)).toEqual(["artifact-missing"]);
    });
  });

  describe("artifacts", () => {
    it("reports every missing artifact at once and writes nothing", async () => {
      const dir = await project({ "module.ts": moduleSource({ manifest: manifest() }) });
      const result = await buildModule(dir);
      expect(errors(result)).toEqual(["artifact-missing", "artifact-missing"]);
      expect(result.findings.map(item => item.file)).toEqual(["upstream/tool.wasm", "NOTICES.txt"]);
      expect(result.findings[0]?.message).toContain("tool.wasm");
      expect(await exists(join(dir, "dist"))).toBe(false);
    });

    it("refuses an artifact that is a symbolic link, even to a file inside the project", async () => {
      const dir = await project(files({ "elsewhere.wasm": WASM }));
      await rm(join(dir, "upstream", "tool.wasm"));
      await symlink(join(dir, "elsewhere.wasm"), join(dir, "upstream", "tool.wasm"));
      const result = await buildModule(dir);
      expect(errors(result)).toEqual(["artifact-unsafe"]);
      expect(result.findings[0]?.message).toContain("regular file");
    });

    it("refuses an artifact reached through a directory link that leaves the project", async () => {
      const outside = await project({ "secret.wasm": WASM });
      const dir = await project(files({}, moduleSource({ manifest: manifest({ artifacts: `[{ name: "tool.wasm", from: "linked/secret.wasm" }]`, license: `{ spdx: "MIT" }` }) })));
      await symlink(outside, join(dir, "linked"));
      const result = await buildModule(dir);
      expect(errors(result)).toEqual(["artifact-unsafe"]);
      expect(result.findings[0]?.message).toContain("outside the project");
    });

    it("refuses an artifact that is a directory", async () => {
      const dir = await project(files({}, moduleSource({ manifest: manifest({ artifacts: `[{ name: "tool.wasm", from: "upstream" }]`, license: `{ spdx: "MIT" }` }) })));
      expect(errors(await buildModule(dir))).toEqual(["artifact-unsafe"]);
    });

    it("refuses an artifact larger than a pin can describe without reading it", async () => {
      const dir = await project(files({}, moduleSource({ manifest: manifest({ artifacts: `[{ name: "tool.wasm", from: "upstream/tool.wasm" }]`, license: `{ spdx: "MIT" }` }) })));
      await truncate(join(dir, "upstream", "tool.wasm"), 512 * 1024 ** 2 + 1);
      const result = await buildModule(dir);
      expect(errors(result)).toEqual(["artifact-size"]);
      expect(result.findings[0]?.message).toContain("536870912");
    });

    it("accepts an artifact of exactly the largest size", async () => {
      const dir = await project(files({}, moduleSource({ manifest: manifest({ artifacts: `[{ name: "tool.wasm", from: "upstream/tool.wasm" }]`, license: `{ spdx: "MIT" }` }) })));
      await truncate(join(dir, "upstream", "tool.wasm"), 512 * 1024 ** 2);
      expect((await buildModule(dir, { check: true })).result).toBe("checked");
    });
  });

  describe("the adapter", () => {
    it("fails on a dynamic import it cannot bundle, with the position in the author's file", async () => {
      const dir = await project(files({ "src/late.ts": `export const late = (name: string): Promise<unknown> => import(name);\n` }, moduleSource({ manifest: manifest({ artifacts: `[]`, license: `{ spdx: "MIT" }` }), imports: `import { late } from "./src/late.ts";\n`, adapter: `() => ({ main: () => (late("x") instanceof Promise ? 0 : 1) })` })));
      const result = await buildModule(dir);
      expect(errors(result)).toEqual(["adapter-import"]);
      expect(result.findings[0]).toMatchObject({ file: "src/late.ts", line: 1 });
      expect(result).toMatchObject({ result: "failed", id: "demo" });
    });

    it("still builds with warnings, and reports them", async () => {
      const dir = await project(files({}, moduleSource({ manifest: manifest({ artifacts: `[]`, license: `{ spdx: "MIT" }` }), adapter: `() => ({ main: () => window.length })` })));
      const result = await buildModule(dir);
      expect(result.result).toBe("built");
      expect(warnings(result)).toEqual(["adapter-global"]);
    });

    it("refuses an adapter larger than the limit", async () => {
      const dir = await project(files({ "src/big.ts": `export const big = ${JSON.stringify("x".repeat(MAX_ADAPTER_BYTES))};\n` }, moduleSource({ manifest: manifest({ artifacts: `[]`, license: `{ spdx: "MIT" }` }), imports: `import { big } from "./src/big.ts";\n`, adapter: `() => ({ main: () => big.length })` })));
      const result = await buildModule(dir, { check: true });
      expect(errors(result)).toEqual(["adapter-size"]);
      expect(result.findings[0]?.message).toContain(String(MAX_ADAPTER_BYTES));
    });

    it("fails with the bundler's located message when the module imports something unresolvable", async () => {
      const dir = await project(files({}, moduleSource({ manifest: manifest({ artifacts: `[]`, license: `{ spdx: "MIT" }` }), imports: `import left from "left-pad";\n`, adapter: `() => ({ main: () => (typeof left === "function" ? 0 : 1) })` })));
      const result = await buildModule(dir);
      expect(result.findings[0]).toMatchObject({ code: "adapter-bundle", file: "module.ts", line: 2 });
      expect(result.findings[0]?.message).toContain("left-pad");
    });
  });

  describe("dependency code", () => {
    const dependent = (): Record<string, string | Uint8Array> => files({
      "node_modules/env-lib/package.json": JSON.stringify({ name: "env-lib", version: "1.0.0", license: "MIT", main: "index.js" }),
      "node_modules/env-lib/index.js": `export async function load(useNode, name) {\n  if (useNode) return [await import("node:fs"), await import("ws"), await import(name)];\n  return "browser";\n}\n`,
    }, moduleSource({ manifest: manifest({ artifacts: `[{ name: "NOTICES.txt", from: "NOTICES.txt" }]`, license: `{ spdx: "MIT", notices: ["NOTICES.txt"] }` }), imports: `import { load } from "env-lib";\n`, adapter: `() => ({ main: async () => ((await load(false, "")) === "browser" ? 0 : 1) })` }));

    it("builds, with one warning for what was replaced and one for the dynamic import it could not bundle", async () => {
      const result = await buildModule(await project(dependent()), { check: true });
      expect(result.result).toBe("checked");
      expect(warnings(result)).toEqual(["adapter-import", "adapter-stubbed"]);
      const stubbed = result.findings.find(item => item.code === "adapter-stubbed");
      expect(stubbed?.message).toContain("2 imports in dependency code were replaced with empty modules");
      expect(stubbed?.message).toContain("node:fs (env-lib), ws (env-lib)");
      expect(result.findings.find(item => item.code === "adapter-import")).toMatchObject({ severity: "warning", file: "node_modules/env-lib/index.js", line: 2 });
      expect(result.bundled).toEqual([{ name: "env-lib", version: "1.0.0", license: "MIT" }]);
    });

    it("counts a specifier once per package, however many of its files import it", async () => {
      const dir = await project(files({
        "node_modules/pair-lib/package.json": JSON.stringify({ name: "pair-lib", version: "1.0.0", license: "MIT", main: "index.js" }),
        "node_modules/pair-lib/index.js": `import { second } from "./second.js";\nexport const first = () => [import("node:fs"), second];\n`,
        "node_modules/pair-lib/second.js": `export const second = () => import("node:fs");\n`,
      }, moduleSource({ manifest: manifest({ artifacts: `[{ name: "NOTICES.txt", from: "NOTICES.txt" }]`, license: `{ spdx: "MIT", notices: ["NOTICES.txt"] }` }), imports: `import { first } from "pair-lib";\n`, adapter: `() => ({ main: () => typeof first })` })));
      const stubbed = (await buildModule(dir, { check: true })).findings.find(item => item.code === "adapter-stubbed");
      expect(stubbed?.message).toMatch(/^1 import in dependency code was replaced with an empty module, because a worker cannot provide it: node:fs \(pair-lib\)\. /u);
    });

    it("words a single replaced import in the singular", async () => {
      const dir = await project(files({
        "node_modules/cjs-lib/package.json": JSON.stringify({ name: "cjs-lib", version: "1.0.0", license: "MIT", main: "index.cjs" }),
        "node_modules/cjs-lib/index.cjs": `module.exports = { read() { try { return typeof require("fs"); } catch { return "none"; } } };\n`,
      }, moduleSource({ manifest: manifest({ artifacts: `[{ name: "NOTICES.txt", from: "NOTICES.txt" }]`, license: `{ spdx: "MIT", notices: ["NOTICES.txt"] }` }), imports: `import * as lib from "cjs-lib";\n`, adapter: `() => ({ main: () => (lib.default.read() === "object" ? 0 : 1) })` })));
      const stubbed = (await buildModule(dir, { check: true })).findings.find(item => item.code === "adapter-stubbed");
      expect(stubbed?.message).toMatch(/^1 import in dependency code was replaced with an empty module, because a worker cannot provide it: fs \(cjs-lib\)\. It matters only if that code runs; test it\.$/u);
    });

    it("says how many imports were replaced when there are many, without listing them all", async () => {
      const names = Array.from({ length: 14 }, (_, index) => `node:mod${String(index).padStart(2, "0")}`);
      const dir = await project(files({
        "node_modules/many-lib/package.json": JSON.stringify({ name: "many-lib", version: "1.0.0", license: "MIT", main: "index.js" }),
        "node_modules/many-lib/index.js": `export const all = () => Promise.all([${names.map(name => `import(${JSON.stringify(name)})`).join(", ")}]);\n`,
      }, moduleSource({ manifest: manifest({ artifacts: `[{ name: "NOTICES.txt", from: "NOTICES.txt" }]`, license: `{ spdx: "MIT", notices: ["NOTICES.txt"] }` }), imports: `import { all } from "many-lib";\n`, adapter: `() => ({ main: () => typeof all })` })));
      const stubbed = (await buildModule(dir, { check: true })).findings.find(item => item.code === "adapter-stubbed");
      expect(stubbed?.message).toContain("14 imports");
      expect(stubbed?.message).toContain("node:mod09 (many-lib), ...");
      expect(stubbed?.message).not.toContain("node:mod10");
    });
  });

  describe("licenses", () => {
    const fakeLibrary = (license: string): Record<string, string> => ({
      "node_modules/fake-lib/package.json": JSON.stringify({ name: "fake-lib", version: "1.0.0", license, main: "index.js" }),
      "node_modules/fake-lib/index.js": `export const value = 1;\n`,
    });
    const bundling = (license: string, spdx: string, notices = ""): Record<string, string | Uint8Array> => files(fakeLibrary(license), moduleSource({
      manifest: manifest({ artifacts: notices === "" ? `[]` : `[{ name: "NOTICES.txt", from: "NOTICES.txt" }]`, license: `{ spdx: ${JSON.stringify(spdx)}${notices === "" ? "" : `, notices: [${JSON.stringify(notices)}]`} }` }),
      imports: `import { value } from "fake-lib";\n`, adapter: `() => ({ main: () => value - 1 })`,
    }));

    it("requires a source for a copyleft module and accepts one", async () => {
      const copyleft = (extra: string): string => moduleSource({ manifest: manifest({ artifacts: `[]`, license: `{ spdx: "MPL-2.0"${extra} }` }) });
      const without = await project({ "module.ts": copyleft("") });
      expect(errors(await buildModule(without, { check: true }))).toEqual(["license-source"]);
      const withSource = await project({ "module.ts": copyleft(`, source: "https://example.test/source"`) });
      expect((await buildModule(withSource, { check: true })).result).toBe("checked");
    });

    it("lists a bundled package in the result and warns that the module's license and notices do not mention it", async () => {
      const result = await buildModule(await project(bundling("ISC", "MIT")), { check: true });
      expect(result.bundled).toEqual([{ name: "fake-lib", version: "1.0.0", license: "ISC" }]);
      expect(warnings(result)).toEqual(["license-bundled", "notices-missing"]);
      expect(result.findings[0]?.message).toContain("fake-lib@1.0.0 (ISC)");
    });

    it("is quiet when license.spdx names the bundled license and notices are declared", async () => {
      const result = await buildModule(await project(bundling("ISC", "MIT AND ISC", "NOTICES.txt")), { check: true });
      expect(result).toMatchObject({ result: "checked", findings: [] });
    });

    it("refuses a bundled copyleft package unless the module says where its source is", async () => {
      const result = await buildModule(await project(bundling("LGPL-3.0-only", "MIT AND LGPL-3.0-only", "NOTICES.txt")), { check: true });
      expect(errors(result)).toEqual(["license-source", "license-source"]);
      expect(result.findings[0]?.message).toContain("the module's license (MIT AND LGPL-3.0-only) is copyleft");
      expect(result.findings[1]?.message).toContain("bundles fake-lib@1.0.0 (LGPL-3.0-only), which is copyleft");
      expect(result.bundled).toHaveLength(1);
    });

    it("refuses a bundled copyleft package even when the module's own license is permissive", async () => {
      const result = await buildModule(await project(bundling("LGPL-3.0-only", "MIT", "NOTICES.txt")), { check: true });
      expect(errors(result)).toEqual(["license-source"]);
      expect(result.findings[0]?.message).toContain("fake-lib@1.0.0");
    });

    it("treats a bundled package with no usable license as unnamed, not as an error", async () => {
      const result = await buildModule(await project(bundling("SEE LICENSE IN LICENSE.md", "MIT", "NOTICES.txt")), { check: true });
      expect(errors(result)).toEqual([]);
      expect(warnings(result)).toEqual(["license-bundled"]);
    });
  });

  describe("the output directory", () => {
    it.each([".", "..", "../elsewhere", "/tmp/elsewhere"])("refuses %j", async out => {
      const dir = await project(files());
      const result = await buildModule(dir, { out });
      expect(errors(result)).toEqual(["output-unsafe"]);
      expect(result.findings[0]?.message).toContain("inside the project");
    });

    it("refuses an output directory that would contain a file the build reads", async () => {
      const dir = await project(files());
      expect(errors(await buildModule(dir, { out: "upstream" }))).toEqual(["output-unsafe"]);
      const moved = await project({ "src/module.ts": moduleSource({ manifest: manifest({ artifacts: `[]`, license: `{ spdx: "MIT" }` }) }) });
      const result = await buildModule(moved, { module: "src/module.ts", out: "src" });
      expect(errors(result)).toEqual(["output-unsafe"]);
      expect(result.findings[0]?.message).toContain("src/module.ts");
    });

    it("refuses a non-empty directory that is not an earlier build, and leaves it as it was", async () => {
      const dir = await project(files({ "dist/keep.txt": "mine\n" }));
      const result = await buildModule(dir);
      expect(errors(result)).toEqual(["output-unsafe"]);
      expect(result.findings[0]?.message).toContain("SHA256SUMS");
      expect(await readFile(join(dir, "dist", "keep.txt"), "utf8")).toBe("mine\n");
    });

    it("accepts an empty existing directory", async () => {
      const dir = await project(files());
      await mkdir(join(dir, "dist"));
      expect((await buildModule(dir)).result).toBe("built");
    });

    it("refuses an output path that is a file or a link", async () => {
      const dir = await project(files({ "dist": "a file" }));
      expect(errors(await buildModule(dir))).toEqual(["output-unsafe"]);
      const linked = await project(files());
      await mkdir(join(linked, "real"));
      await symlink(join(linked, "real"), join(linked, "dist"));
      const result = await buildModule(linked);
      expect(errors(result)).toEqual(["output-unsafe"]);
      expect(await readdir(join(linked, "real"))).toEqual([]);
    });

    it("does not check the output directory in check mode", async () => {
      const dir = await project(files({ "dist/keep.txt": "mine\n" }));
      expect((await buildModule(dir, { check: true })).result).toBe("checked");
    });
  });
});
