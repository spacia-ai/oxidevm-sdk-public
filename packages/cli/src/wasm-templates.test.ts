import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildModule, extractManifest } from "@oxidevm/sdk/image-builder";
import { registryConfig } from "./templates.js";
import { ADD_WASM, ciWorkflow, releaseWorkflow } from "./wasm-template-files.js";
import { initializeModule, moduleIdFor } from "./wasm-templates.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "oxidevm-cli-init-")); directories.push(directory); return directory; }

const COMMON = [".github/workflows/ci.yml", ".github/workflows/release.yml", ".gitignore", "AGENTS.md", "LICENSE", "NOTICE", "README.md", "eslint.config.js", "module.ts", "package.json", "test/module.test.ts", "test/tsconfig.json", "tsconfig.json", "upstream/add.wasm"];
async function expectedFiles(extra: readonly string[]): Promise<string[]> {
  return [...COMMON, ...extra, ...await registryConfig() === undefined ? [] : [".npmrc"]].sort();
}

/** The node globals the generated adapters touch, reached without a DOM or Node typing for WebAssembly. */
interface WebAssemblyApi { readonly Module: new (bytes: Uint8Array) => unknown }
function isWebAssemblyApi(value: unknown): value is WebAssemblyApi {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "Module") === "function";
}
function webAssembly(): WebAssemblyApi {
  const api: unknown = Reflect.get(globalThis, "WebAssembly");
  if (!isWebAssemblyApi(api)) throw new Error("no WebAssembly");
  return api;
}
function jsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not a JSON object");
  return Object.fromEntries(Object.entries(value));
}
function stringsOf(value: unknown): Record<string, string> {
  const entries = typeof value === "object" && value !== null ? Object.entries(value) : [];
  return Object.fromEntries(entries.map(([key, item]): [string, string] => { if (typeof item !== "string") throw new Error(`${key} is not a string`); return [key, item]; }));
}
async function adapterFactory(distribution: string): Promise<(host: unknown) => unknown> {
  const namespace: unknown = await import(/* @vite-ignore */ pathToFileURL(join(distribution, "adapter.mjs")).href);
  const factory: unknown = typeof namespace === "object" && namespace !== null ? Reflect.get(namespace, "default") : undefined;
  if (typeof factory !== "function") throw new Error("the adapter has no default export function");
  return host => Reflect.apply(factory, undefined, [host]) as unknown;
}
function hook(hooks: unknown, name: string): (...args: unknown[]) => unknown {
  const found: unknown = typeof hooks === "object" && hooks !== null ? Reflect.get(hooks, name) : undefined;
  if (typeof found !== "function") throw new Error(`no ${name} hook`);
  return (...args) => Reflect.apply(found, hooks, args) as unknown;
}
function host(options: { readonly written?: string[]; readonly failures?: string[] } = {}): unknown {
  return {
    artifacts: { compile: () => Promise.resolve(new (webAssembly().Module)(ADD_WASM)) },
    fs: { write: (_fd: number, bytes: Uint8Array) => { options.written?.push(new TextDecoder().decode(bytes)); return bytes.length; } },
    fail: (status: number, message: string) => { options.failures?.push(message); return status; },
  };
}

describe("moduleIdFor", () => {
  it.each([
    ["/work/My Tool", "my-tool"], ["wordfreq", "wordfreq"], ["/a/b/Word_Freq.v2", "word-freq-v2"], ["9lives", "module-9lives"],
    ["---", "my-module"], ["/", "my-module"], ["ÄÖÜ", "my-module"], [`/x/${"a".repeat(100)}`, "a".repeat(63)],
  ])("turns %j into %j", (directory, id) => {
    expect(moduleIdFor(directory)).toBe(id);
    expect(id).toMatch(/^[a-z][a-z0-9-]{0,62}$/u);
  });
});

describe("initializeModule", () => {
  it("creates a command module with the whole project around it", async () => {
    const root = await temporary();
    const result = await initializeModule(join(root, "word-tool"), { kind: "command" });
    expect(result).toMatchObject({ directory: join(root, "word-tool"), id: "word-tool", kind: "command", abi: "raw" });
    expect(result.files).toEqual(await expectedFiles(["src/operands.ts", "test/operands.test.ts"]));
    const found: string[] = [];
    for (const entry of await readdir(join(root, "word-tool"), { recursive: true, withFileTypes: true })) if (entry.isFile()) found.push(join(entry.parentPath, entry.name).slice(join(root, "word-tool").length + 1));
    expect(found.sort()).toEqual(result.files);
  });

  it("creates a service module with the same project and an endpoint", async () => {
    const root = await temporary();
    const result = await initializeModule(join(root, "add-service"), { kind: "service", id: "adder" });
    expect(result).toMatchObject({ id: "adder", kind: "service" });
    expect(result.files).toEqual(await expectedFiles(["src/operands.ts", "test/operands.test.ts"]));
    expect(extractManifest(await readFile(join(root, "add-service", "module.ts"), "utf8"), "module.ts")).toMatchObject({
      id: "adder", process: { kind: "service" }, expose: { add: { kind: "unix", path: "/workspace/_oxidevm/adder.sock", protocol: "adder/1" } },
    });
  });

  it.each(["command", "service"] as const)("generates a %s module that builds cleanly, with no findings", async kind => {
    const root = await temporary();
    await initializeModule(join(root, "tool"), { kind });
    const built = await buildModule(join(root, "tool"));
    expect(built).toMatchObject({ result: "built", id: "tool", version: "0.1.0", findings: [], bundled: [] });
    expect(built.files.map(file => file.name)).toEqual(["SHA256SUMS", "adapter.mjs", "add.wasm", "module.json"]);
    expect([...await readFile(join(root, "tool", "dist", "add.wasm"))]).toEqual([...ADD_WASM]);
  });

  it("generates a command whose adapter adds two numbers with the shipped WebAssembly and reports bad usage", async () => {
    const root = await temporary();
    await initializeModule(join(root, "tool"), { kind: "command" });
    await buildModule(join(root, "tool"));
    const factory = await adapterFactory(join(root, "tool", "dist"));
    const written: string[] = [], failures: string[] = [];
    const hooks = await factory(host({ written, failures }));
    const main = hook(hooks, "main");
    expect(main({ args: ["2", "-5"], stdout: 1 })).toBe(0);
    expect(main({ args: ["2147483647", "1"], stdout: 1 })).toBe(0);
    expect(written).toEqual(["-3\n", "-2147483648\n"]);
    expect(main({ args: ["2"], stdout: 1 })).toBe(2);
    expect(main({ args: ["x", "1"], stdout: 1 })).toBe(2);
    expect(failures).toEqual(["usage: tool <a> <b>  (two 32-bit integers)", "usage: tool <a> <b>  (two 32-bit integers)"]);
  });

  it("generates a service whose handler answers one line per request and closes a runaway line", async () => {
    const root = await temporary();
    await initializeModule(join(root, "tool"), { kind: "service" });
    await buildModule(join(root, "tool"));
    const hooks = await (await adapterFactory(join(root, "tool", "dist")))(host());
    const protocols: unknown = typeof hooks === "object" && hooks !== null ? Reflect.get(hooks, "protocols") : undefined;
    const handler = hook(protocols, "add");
    const connection = (chunks: readonly string[], sent: string[]): unknown => {
      const queue = chunks.map(chunk => new TextEncoder().encode(chunk));
      return { fd: 3, signal: new AbortController().signal, read: () => Promise.resolve(queue.shift() ?? new Uint8Array()), write: (bytes: Uint8Array) => { sent.push(new TextDecoder().decode(bytes)); return Promise.resolve(); } };
    };
    const sent: string[] = [];
    await handler(connection(["2 3\nx y\n4 ", "5\n"], sent));
    expect(sent).toEqual(["5\n", "error\n", "9\n"]);
    // The line is never finished within the limit, so the connection ends before the rest of it is read and answered.
    const runaway: string[] = [];
    await handler(connection(["z".repeat(2000), "\n"], runaway));
    expect(runaway).toEqual([]);
    const justInside: string[] = [];
    await handler(connection([`${"z".repeat(1000)}\n`], justInside));
    expect(justInside).toEqual(["error\n"]);
  });

  it("starts from a WebAssembly file of your own and says plainly that it has no behavior yet", async () => {
    const root = await temporary();
    await writeFile(join(root, "mine.wasm"), ADD_WASM);
    const result = await initializeModule(join(root, "wrapped"), { kind: "command", from: join(root, "mine.wasm") });
    expect(result.files).toEqual(await Promise.resolve(expectedFiles([])).then(files => files.filter(file => file !== "upstream/add.wasm").concat("upstream/mine.wasm").sort()));
    expect(extractManifest(await readFile(join(root, "wrapped", "module.ts"), "utf8"), "module.ts")).toMatchObject({ abi: "raw", artifacts: [{ name: "mine.wasm", from: "upstream/mine.wasm" }], requires: { host: [] } });
    expect([...await readFile(join(root, "wrapped", "upstream", "mine.wasm"))]).toEqual([...ADD_WASM]);
    const built = await buildModule(join(root, "wrapped"));
    expect(built).toMatchObject({ result: "built", findings: [] });
    const failures: string[] = [];
    const hooks = await (await adapterFactory(join(root, "wrapped", "dist")))({ artifacts: { compile: () => Promise.resolve(new (webAssembly().Module)(ADD_WASM)) }, fail: (status: number, message: string) => { failures.push(message); return status; } });
    expect(hook(hooks, "main")()).toBe(2);
    expect(failures).toEqual(["wrapped has no behavior yet: edit module.ts"]);
  });

  it("starts a service from a WebAssembly file of your own too", async () => {
    const root = await temporary();
    await writeFile(join(root, "mine.wasm"), ADD_WASM);
    await initializeModule(join(root, "wrapped"), { kind: "service", from: join(root, "mine.wasm") });
    expect(await buildModule(join(root, "wrapped"), { check: true })).toMatchObject({ result: "checked", findings: [] });
  });

  it("refuses an id the manifest would reject before creating anything", async () => {
    const root = await temporary();
    for (const id of ["Tool", "1tool", "a_b", "x".repeat(64), "-x", "a b"]) {
      await expect(initializeModule(join(root, "t"), { kind: "command", id })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(stat(join(root, "t"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("never overwrites: an existing directory is refused and left alone", async () => {
    const root = await temporary();
    await writeFile(join(root, "keep"), "mine\n");
    await expect(initializeModule(join(root, "keep"), { kind: "command" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await readFile(join(root, "keep"), "utf8")).toBe("mine\n");
    await initializeModule(join(root, "once"), { kind: "command" });
    await expect(initializeModule(join(root, "once"), { kind: "service" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await readFile(join(root, "once", "module.ts"), "utf8")).toContain("\"command\"");
  });

  it.each([
    ["a file that is not there", "missing.wasm", "cannot be read"],
    ["a file that is not WebAssembly", "text.wasm", "not a WebAssembly"],
    ["a name that is not a .wasm file", "mine.bin", ".wasm file"],
    ["a name with spaces", "my file.wasm", ".wasm file"],
  ])("refuses --from with %s", async (_label, name, fragment) => {
    const root = await temporary();
    await writeFile(join(root, "text.wasm"), "plain text, not WebAssembly");
    await writeFile(join(root, "mine.bin"), ADD_WASM);
    await writeFile(join(root, "my file.wasm"), ADD_WASM);
    await expect(initializeModule(join(root, "t"), { kind: "command", from: join(root, name) })).rejects.toThrow(fragment);
    await expect(stat(join(root, "t"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies the license text of the CLI, writes a notice for the module instead of the CLI's own, and keeps the machine's paths out of every file", async () => {
    const root = await temporary();
    await initializeModule(join(root, "tool"), { kind: "command" });
    expect(await readFile(join(root, "tool", "LICENSE"), "utf8")).toBe(await readFile(new URL("../LICENSE", import.meta.url), "utf8"));
    // The CLI's NOTICE names esbuild, a Go runtime and fonts that a module project does not contain; a notice must describe what it ships.
    const notice = await readFile(join(root, "tool", "NOTICE"), "utf8");
    expect(notice.startsWith("tool\n")).toBe(true);
    expect(notice).not.toMatch(/esbuild|Go |Archivo|Roboto|JetBrains|Spacia|SIL OFL/u);
    expect(notice).toContain("Replace");
    expect(notice).toContain("Copyright (c) <year> <copyright holder>");
    for (const file of ["module.ts", "package.json", "README.md", "AGENTS.md", "tsconfig.json", "eslint.config.js"]) expect(await readFile(join(root, "tool", file), "utf8")).not.toContain(root);
  });

  it("pins the same tool versions this repository tests with, so generated projects do not drift", async () => {
    const root = await temporary();
    await initializeModule(join(root, "tool"), { kind: "command" });
    const generated = jsonObject(await readFile(join(root, "tool", "package.json"), "utf8"));
    const repository = jsonObject(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
    const wanted = stringsOf(generated["devDependencies"]), have = stringsOf(repository["devDependencies"]), scripts = stringsOf(generated["scripts"]);
    for (const name of ["@eslint/js", "@types/node", "eslint", "typescript", "typescript-eslint", "vitest"]) expect(wanted[name], name).toBe(have[name]);
    expect(Object.keys(scripts).sort()).toEqual(["build", "check", "release", "test"]);
    expect(scripts["check"]).toContain("oxidevm wasm build --check");
    expect(scripts["check"]).toContain("tsc --noEmit -p test");
  });

  it("writes workflows that verify the draft before publishing it", async () => {
    const root = await temporary();
    await initializeModule(join(root, "tool"), { kind: "command" });
    const release = await readFile(join(root, "tool", ".github", "workflows", "release.yml"), "utf8");
    expect(release.indexOf("--draft")).toBeGreaterThan(-1);
    expect(release.indexOf("sha256sum --check SHA256SUMS")).toBeGreaterThan(release.indexOf("--draft"));
    expect(release.indexOf("--draft=false")).toBeGreaterThan(release.indexOf("sha256sum --check SHA256SUMS"));
    expect(release).toContain("contents: write");
    expect(await readFile(join(root, "tool", ".github", "workflows", "ci.yml"), "utf8")).toContain("contents: read");
  });
});

describe("what the generated workflows let dependency code reach", () => {
  /** The text of one job: from its `  name:` line to the next job or the end. */
  const job = (workflow: string, name: string): string => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    expect(start, `${name} job`).toBeGreaterThan(-1);
    const rest = workflow.slice(start + 1);
    const next = rest.slice(3).search(/\n {2}[a-z]+:\n/u);
    return next < 0 ? rest : rest.slice(0, next + 3);
  };

  for (const manual of [false, true]) {
    it(`runs install and build scripts with a read-only token and no stored credentials (manual: ${String(manual)})`, () => {
      const release = releaseWorkflow(manual), build = job(release, "build");
      expect(release.slice(0, release.indexOf("\njobs:"))).toContain("permissions:\n  contents: read");
      expect(build).toContain("pnpm install --frozen-lockfile");
      expect(build).toContain("persist-credentials: false");
      expect(build).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|contents: write/u);
      expect(job(ciWorkflow(manual), "check")).toContain("persist-credentials: false");
    });

    it(`gives write access only to the job that publishes, which installs and builds nothing (manual: ${String(manual)})`, () => {
      const release = releaseWorkflow(manual), publish = job(release, "release");
      expect(publish).toContain("contents: write");
      expect(publish).toContain("GH_TOKEN");
      expect(publish).toContain("needs: build");
      expect(publish).not.toMatch(/pnpm|npm |setup-node|actions\/checkout/u);
      expect(release.split("contents: write")).toHaveLength(2);
    });
  }
});

describe("workflow triggers", () => {
  it("run on pushes, pull requests and version tags when a runner can install the packages", () => {
    expect(ciWorkflow(false)).toContain("on:\n  push:\n    branches: [main]\n  pull_request:\n");
    expect(releaseWorkflow(false)).toContain('on:\n  push:\n    tags: ["v*"]\n');
    for (const workflow of [ciWorkflow(false), releaseWorkflow(false)]) expect(workflow).not.toContain("workflow_dispatch");
  });

  it("start on request only, and say why, when the packages are on a private registry", () => {
    for (const workflow of [ciWorkflow(true), releaseWorkflow(true)]) {
      expect(workflow).toContain("on:\n  workflow_dispatch:\n");
      expect(workflow).not.toMatch(/^\s+(?:push|pull_request):/mu);
      expect(workflow).toContain("private registry");
    }
    // The release check compares the tag with the version, so a run started on a branch would fail; the file says where to start it.
    expect(releaseWorkflow(true)).toContain("Start it from a tag");
  });

  it("keeps the rest of each workflow identical in both modes", () => {
    const without = (text: string) => text.split("\n").filter(line => !line.startsWith("#") && !/^(?:on:| {2}workflow_dispatch:| {2}push:| {4}branches:| {4}tags:| {2}pull_request:)/u.test(line)).join("\n");
    expect(without(ciWorkflow(true))).toBe(without(ciWorkflow(false)));
    expect(without(releaseWorkflow(true))).toBe(without(releaseWorkflow(false)));
  });

  it("makes a generated project's workflows manual exactly when the project needs an .npmrc", async () => {
    const root = await temporary();
    await initializeModule(join(root, "tool"), { kind: "command" });
    const manual = await registryConfig() !== undefined;
    for (const name of ["ci", "release"]) {
      expect((await readFile(join(root, "tool", ".github", "workflows", `${name}.yml`), "utf8")).includes("workflow_dispatch"), name).toBe(manual);
    }
  });
});
