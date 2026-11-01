import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildModule, extractManifest } from "@oxidevm/sdk/image-builder";
import { registryConfig } from "./templates.js";
import { ADD_WASM, TEMPLATE_PLAYWRIGHT, ciWorkflow, releaseWorkflow } from "./wasm-template-files.js";
import { initText } from "./wasm-text.js";
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
    // Only writeAll: a command writes its whole output with it, so a pipe that takes part of a write loses nothing.
    fs: { writeAll: (_fd: number, bytes: Uint8Array) => { options.written?.push(new TextDecoder().decode(bytes)); } },
    fail: (status: number, message: string) => { options.failures?.push(message); return status; },
  };
}
/** What the runner hands `main`: started by the application unless `invocation` says a program in the VM ran it. */
function commandIO(args: readonly string[], invocation: unknown = { kind: "host" }): unknown {
  return { args, env: {}, cwd: "/workspace", stdin: 0, stdout: 1, stderr: 2, invocation, terminals: { stdin: false, stdout: false, stderr: false } };
}
const ranFromShell = (argv0: string): unknown => ({ kind: "command", name: "tool", path: "/usr/local/bin/tool", argv0 });

const execute = promisify(execFile);
const resolver = createRequire(import.meta.url);
/** This repository's copy of a package a generated project installs, where Node finds it from here. */
const installed = (name: string): string => dirname(resolver.resolve(`${name}/package.json`));
const SDK_PACKAGE = fileURLToPath(new URL("../../sdk", import.meta.url));

/** Gives a generated project the dependencies it declares: this SDK itself, and this repository's pinned tools. */
async function linkDependencies(project: string): Promise<void> {
  const links: readonly (readonly [string, string])[] = [
    ["@oxidevm/sdk", SDK_PACKAGE],
    ...["vitest", "typescript", "@types/node", "eslint", "@eslint/js", "typescript-eslint"].map(name => [name, installed(name)] as const),
  ];
  for (const [name, target] of links) {
    await mkdir(dirname(join(project, "node_modules", name)), { recursive: true });
    await symlink(target, join(project, "node_modules", name), "dir");
  }
}

/** Runs a tool's Node entry point in the project and returns its standard output; a failure carries everything the tool printed. */
async function runTool(project: string, entry: string, args: readonly string[]): Promise<string> {
  // The tools must not mistake this test's Vitest worker variables for their own.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")));
  try {
    return (await execute(process.execPath, [entry, ...args], { cwd: project, env, timeout: 120_000, maxBuffer: 32 * 1024 ** 2 })).stdout;
  } catch (error) {
    const output = (key: string): string => { const value: unknown = typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined; return typeof value === "string" ? value : ""; };
    throw new Error(`${entry} ${args.join(" ")} failed in ${project}:\n${output("stdout")}\n${output("stderr")}`, { cause: error });
  }
}

/** The project's own files among absolute paths a tool reports, relative and sorted; dependencies are left out. */
function ownFiles(project: string, paths: readonly string[]): string[] {
  return paths.map(path => relative(project, path)).filter(path => path !== "" && !path.startsWith("..") && !isAbsolute(path) && !path.startsWith("node_modules/")).sort();
}

/** The generated projects whose own checks run here: the add example, the same with a reserved id, and a --from skeleton. */
const PROJECTS = [
  { label: "the add example", id: "my-tool", from: false, sources: ["module.ts", "src/command.ts", "src/operands.ts"], tests: ["test/command.test.ts", "test/module.test.ts", "test/operands.test.ts"] },
  { label: "the add example with a reserved id", id: "oxidevm-tools", from: false, sources: ["module.ts", "src/command.ts", "src/operands.ts"], tests: ["test/command.test.ts", "test/module.test.ts", "test/operands.test.ts"] },
  { label: "a --from skeleton", id: "wrapped", from: true, sources: ["module.ts"], tests: ["test/module.test.ts"] },
] as const;

/** Generates one of PROJECTS, linked to this SDK and this repository's tools. */
async function generatedProject(entry: (typeof PROJECTS)[number]): Promise<string> {
  const root = await temporary();
  if (entry.from) await writeFile(join(root, "mine.wasm"), ADD_WASM);
  const project = join(root, entry.id);
  await initializeModule(project, { kind: "command", id: entry.id, ...(entry.from ? { from: join(root, "mine.wasm") } : {}) });
  await linkDependencies(project);
  // Tools report the paths they find from their working directory, which is the physical one.
  return await realpath(project);
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
    expect(result).toMatchObject({ directory: join(root, "word-tool"), id: "word-tool", kind: "command", abi: "raw", commands: ["word-tool"] });
    expect(result.files).toEqual(await expectedFiles(["src/command.ts", "src/operands.ts", "test/command.test.ts", "test/operands.test.ts"]));
    const found: string[] = [];
    for (const entry of await readdir(join(root, "word-tool"), { recursive: true, withFileTypes: true })) if (entry.isFile()) found.push(join(entry.parentPath, entry.name).slice(join(root, "word-tool").length + 1));
    expect(found.sort()).toEqual(result.files);
  });

  it("creates a service module with the same project and an endpoint", async () => {
    const root = await temporary();
    const result = await initializeModule(join(root, "add-service"), { kind: "service", id: "adder" });
    expect(result).toMatchObject({ id: "adder", kind: "service" });
    // A service is not a program, so its result and its project say nothing about commands, exactly as before commands existed.
    expect(Object.keys(result)).toEqual(["directory", "id", "kind", "abi", "files"]);
    expect(result.files).toEqual(await expectedFiles(["src/operands.ts", "test/operands.test.ts"]));
    expect(extractManifest(await readFile(join(root, "add-service", "module.ts"), "utf8"), "module.ts")).toMatchObject({
      id: "adder", process: { kind: "service" }, expose: { add: { kind: "unix", path: "/workspace/_oxidevm/adder.sock", protocol: "adder/1" } },
    });
    for (const file of ["module.ts", "README.md", "AGENTS.md", "test/module.test.ts"]) {
      expect(await readFile(join(root, "add-service", file), "utf8"), file).not.toMatch(/commands|invocation|enableModuleCommands|\/usr\/local\/bin/u);
    }
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
    expect(main(commandIO(["2", "-5"]))).toBe(0);
    expect(main(commandIO(["2147483647", "1"], ranFromShell("tool")))).toBe(0);
    expect(written).toEqual(["-3\n", "-2147483648\n"]);
    expect(main(commandIO(["2"]))).toBe(2);
    expect(main(commandIO(["x", "1"]))).toBe(2);
    expect(failures).toEqual(["usage: tool <a> <b>  (two 32-bit integers)", "usage: tool <a> <b>  (two 32-bit integers)"]);
  });

  it("generates a command whose usage line names the command as the program in the VM typed it", async () => {
    const root = await temporary();
    await initializeModule(join(root, "tool"), { kind: "command" });
    await buildModule(join(root, "tool"));
    const failures: string[] = [];
    const main = hook(await (await adapterFactory(join(root, "tool", "dist")))(host({ failures })), "main");
    // argv[0] is whatever the caller passed: a path, or the name of a link to the stub.
    expect(main(commandIO(["2"], ranFromShell("/usr/local/bin/tool")))).toBe(2);
    expect(main(commandIO(["x", "1"], ranFromShell("add-two")))).toBe(2);
    expect(main(commandIO([]))).toBe(2);
    expect(failures).toEqual(["usage: /usr/local/bin/tool <a> <b>  (two 32-bit integers)", "usage: add-two <a> <b>  (two 32-bit integers)", "usage: tool <a> <b>  (two 32-bit integers)"]);
  });

  it("declares the module's id as its command, right after process, and tests that it does", async () => {
    const root = await temporary();
    await initializeModule(join(root, "tool"), { kind: "command" });
    const source = await readFile(join(root, "tool", "module.ts"), "utf8");
    expect(source).toContain("    process: { kind: \"command\" },\n    commands: [\"tool\"],\n    requires: { host: [\"files.sync\"] },\n");
    expect(extractManifest(source, "module.ts")).toMatchObject({ id: "tool", commands: ["tool"] });
    // The adapter keeps the WebAssembly call in module.ts and hands it to the command, which src/command.ts defines.
    expect(source).toContain("return addCommand(host, add);");
    expect(await readFile(join(root, "tool", "test", "module.test.ts"), "utf8")).toContain("expect(definition.manifest.commands).toEqual([\"tool\"]);");
  });

  it("gives a module whose id starts with the reserved oxidevm no command, and says why", async () => {
    const root = await temporary();
    const result = await initializeModule(join(root, "tools"), { kind: "command", id: "oxidevm-tools" });
    expect(result.commands).toEqual([]);
    const source = await readFile(join(root, "tools", "module.ts"), "utf8");
    expect(source).not.toContain("commands:");
    expect(extractManifest(source, "module.ts")).not.toHaveProperty("commands");
    expect(initText(result)).toContain("It declares no commands: command names that start with \"oxidevm\" are reserved. Add commands: [\"<name>\"] after process in module.ts to let programs in a VM run it by a name of your own.\n");
    expect(await readFile(join(root, "tools", "README.md"), "utf8")).toContain("The module declares no commands: command names that start with `oxidevm` are reserved.");
    expect(await readFile(join(root, "tools", "test", "module.test.ts"), "utf8")).toContain("expect(\"commands\" in definition.manifest).toBe(false);");
    expect(await buildModule(join(root, "tools"))).toMatchObject({ result: "built", findings: [] });
  });

  it("explains in the README and AGENTS.md how programs in a VM run the command", async () => {
    const root = await temporary();
    const result = await initializeModule(join(root, "my-tool"), { kind: "command" });
    expect(initText(result)).toContain("It declares the command my-tool: once an application turns it on, programs in a VM run it as /usr/local/bin/my-tool (README.md, \"Run it from a shell\").\n");
    const readme = await readFile(join(root, "my-tool", "README.md"), "utf8");
    const shell = readme.slice(readme.indexOf("## Run it from a shell"), readme.indexOf("## Develop it"));
    for (const fragment of [
      "import { myTool } from \"./oxidevm.modules.generated\";", "const commands = await enableModuleCommands(vm, myTool);",
      "// A terminal in the VM now runs `my-tool 2 3`, which prints 5.", "await commands.disable();", "a stub at `/usr/local/bin/my-tool`",
      "lists `/usr/local/bin` before `/usr/bin`", "takes the place of an image program with the same name",
      "as the guest user, with the caller's arguments, environment, working directory and standard streams",
      "| 0-119 |", "| 120 |", "| 122 |", "| 123 |", "| 125 |", "| 126 |", "| 127 |", "| 128+n |", "130 for Ctrl+C",
    ]) expect(shell, fragment).toContain(fragment);
    const agents = await readFile(join(root, "my-tool", "AGENTS.md"), "utf8");
    for (const fragment of [
      "`io.invocation.argv0`", "`io.args` never contains argv[0]", "a terminal, a pipe, a file or empty", "until a read returns no bytes", "`io.terminals`",
      "2 for a usage error", "status 123", "`process.signals`", "`close()` does not run", "`untrap()`", "`raise()`", "shell loop stops", "atomically",
      "shadow", "consent again", "`requires.guest.executables`", "never start your own command through PATH", "start-up cheap",
    ]) expect(agents, fragment).toContain(fragment);
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
    expect(extractManifest(await readFile(join(root, "wrapped", "module.ts"), "utf8"), "module.ts")).toMatchObject({ abi: "raw", artifacts: [{ name: "mine.wasm", from: "upstream/mine.wasm" }], commands: ["wrapped"], requires: { host: [] } });
    expect(result.commands).toEqual(["wrapped"]);
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
    for (const file of ["module.ts", "src/command.ts", "test/command.test.ts", "package.json", "README.md", "AGENTS.md", "tsconfig.json", "eslint.config.js"]) expect(await readFile(join(root, "tool", file), "utf8")).not.toContain(root);
  });

  it("pins the same tool versions this repository tests with, so generated projects do not drift", async () => {
    const root = await temporary();
    await initializeModule(join(root, "tool"), { kind: "command" });
    const generated = jsonObject(await readFile(join(root, "tool", "package.json"), "utf8"));
    const repository = jsonObject(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
    const wanted = stringsOf(generated["devDependencies"]), have = stringsOf(repository["devDependencies"]), scripts = stringsOf(generated["scripts"]);
    for (const name of ["@eslint/js", "@types/node", "eslint", "typescript", "typescript-eslint", "vitest"]) expect(wanted[name], name).toBe(have[name]);
    expect(Object.keys(scripts).sort()).toEqual(["build", "check", "release", "test", "test:conformance"]);
    expect(scripts["test:conformance"]).toBe("oxidevm wasm build && oxidevm wasm test --arg 2 --arg 3");
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

/** A field of a report entry a tool printed as JSON, or undefined. */
const entryField = (entry: unknown, key: string): unknown => typeof entry === "object" && entry !== null ? Reflect.get(entry, key) : undefined;

describe.each(PROJECTS)("$label, checked with its own settings against this SDK", project => {
  it("passes its own tests (test/*.test.ts) with this repository's Vitest", async () => {
    const directory = await generatedProject(project);
    const report: unknown = JSON.parse(await runTool(directory, join(installed("vitest"), "vitest.mjs"), ["run", "--reporter=json"]));
    const results = entryField(report, "testResults");
    if (!Array.isArray(results)) throw new Error("the Vitest report has no testResults");
    const files = Array.from<unknown>(results).map(result => `${relative(directory, String(entryField(result, "name")))}: ${String(entryField(result, "status"))}`);
    expect(files.sort()).toEqual(project.tests.map(file => `${file}: passed`));
  }, 120_000);

  it("type-checks with its own tsconfig files, which cover every source and test", async () => {
    const directory = await generatedProject(project);
    const tsc = join(installed("typescript"), "bin", "tsc");
    // The two compiler runs of the project's check script: the module and its sources without Node's types, then the tests with them.
    expect(ownFiles(directory, (await runTool(directory, tsc, ["--noEmit", "--listFiles", "-p", "tsconfig.json"])).split("\n"))).toEqual([...project.sources]);
    expect(ownFiles(directory, (await runTool(directory, tsc, ["--noEmit", "--listFiles", "-p", "test"])).split("\n"))).toEqual([...project.sources, ...project.tests].sort());
  }, 120_000);

  it("passes its own ESLint settings with no warnings, every TypeScript file included", async () => {
    const directory = await generatedProject(project);
    const report: unknown = JSON.parse(await runTool(directory, join(installed("eslint"), "bin", "eslint.js"), [".", "--max-warnings", "0", "--format", "json"]));
    if (!Array.isArray(report)) throw new Error("the ESLint report is not a list");
    const linted = Array.from<unknown>(report).map(file => {
      const messages = entryField(file, "messages");
      return { file: relative(directory, String(entryField(file, "filePath"))), problems: Array.isArray(messages) ? Array.from<unknown>(messages).map(message => `${String(entryField(message, "ruleId"))}: ${String(entryField(message, "message"))}`) : ["no messages"] };
    });
    expect(linted.sort((left, right) => left.file < right.file ? -1 : 1)).toEqual([...project.sources, ...project.tests].sort().map(file => ({ file, problems: [] })));
  }, 120_000);
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

describe("the conformance step of generated projects", () => {
  it("pins the Playwright version the SDK drives, so CI installs the browser build that version expects", async () => {
    const sdk: unknown = JSON.parse(await readFile(new URL("../../sdk/package.json", import.meta.url), "utf8"));
    const dependencies = typeof sdk === "object" && sdk !== null && "dependencies" in sdk ? sdk.dependencies : undefined;
    const pinned = typeof dependencies === "object" && dependencies !== null && "playwright" in dependencies ? dependencies.playwright : undefined;
    expect(pinned).toBe(TEMPLATE_PLAYWRIGHT);
  });

  it("installs Chromium and runs oxidevm wasm test after the unit tests", () => {
    for (const manual of [false, true]) {
      const workflow = ciWorkflow(manual);
      expect(workflow.indexOf("pnpm test")).toBeLessThan(workflow.indexOf("pnpm exec playwright install --with-deps chromium"));
      expect(workflow.indexOf("pnpm exec playwright install --with-deps chromium")).toBeLessThan(workflow.indexOf("pnpm run test:conformance"));
    }
  });
});
