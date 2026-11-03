import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { formatSums } from "@oxidevm/sdk/image-builder";
import { decodeResolvedManifest, encodeModuleManifest } from "@oxidevm/sdk/wasm";
import { runCLI, type CLIEnvironment } from "./run.js";
import { decodeCliReport } from "./report.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "oxidevm-cli-wasm-")); directories.push(directory); return directory; }
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A release directory the way `oxidevm wasm build` will write it, built here from SDK pieces. */
async function release(directory: string, extra: Record<string, unknown> = {}, version = "1.0.0"): Promise<void> {
  const adapter = new TextEncoder().encode("export default () => ({ main: () => 0 });"), wasm = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
  const manifest = encodeModuleManifest(decodeResolvedManifest({
    schemaVersion: 1, id: "tool", version, abi: "raw", adapter: { api: 1, sha256: sha(adapter), bytes: adapter.length }, artifacts: [{ name: "tool.wasm", sha256: sha(wasm), bytes: wasm.length }],
    process: { kind: "command" }, requires: { host: ["files.sync"] }, license: { spdx: "MIT" }, ...extra,
  }));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "module.json"), manifest);
  await writeFile(join(directory, "adapter.mjs"), adapter);
  await writeFile(join(directory, "tool.wasm"), wasm);
  await writeFile(join(directory, "SHA256SUMS"), formatSums([{ name: "module.json", sha256: sha(manifest) }, { name: "adapter.mjs", sha256: sha(adapter) }, { name: "tool.wasm", sha256: sha(wasm) }]));
}

interface Run { readonly code: number; readonly report: ReturnType<typeof decodeCliReport> | undefined; readonly stdout: string; readonly stderr: string; readonly asked: string[] }
async function run(directory: string, args: readonly string[], answer?: boolean): Promise<Run> {
  const out: string[] = [], err: string[] = [], asked: string[] = [];
  const io: CLIEnvironment = {
    directory, environment: { XDG_CACHE_HOME: join(directory, ".cache") }, signal: new AbortController().signal,
    stdout: text => { out.push(text); }, stderr: text => { err.push(text); },
    ...(answer === undefined ? {} : { confirm: question => { asked.push(question); return Promise.resolve(answer); } }),
  };
  const code = await runCLI(args, io);
  const stdout = out.join("");
  return { code, stdout, stderr: err.join(""), asked, report: args.includes("--json") ? decodeCliReport(JSON.parse(stdout) as unknown) : undefined };
}

describe("oxidevm wasm add", () => {
  it("installs a local release after --yes, writing the declaration, lock, committed module.json, staged files and handles", async () => {
    const dir = await temporary();
    await release(join(dir, "dist"));
    const added = await run(dir, ["wasm", "add", "file:dist", "--yes", "--json"]);
    expect(added.code).toBe(0);
    expect(added.report).toMatchObject({ kind: "result", command: "wasm add", result: { id: "tool", version: "1.0.0", status: "added", consent: "approved", source: "file:dist", capabilities: ["files.sync"], generatedFile: "src/oxidevm.modules.generated.ts" } });
    // A local source never touches the download cache.
    expect((await readdir(dir)).sort()).toEqual([".oxidevm", "dist", "modules", "oxidevm.modules.json", "oxidevm.modules.lock.json", "src"]);
    expect(await readFile(join(dir, "src/oxidevm.modules.generated.ts"), "utf8")).toContain("export const tool = moduleHandle(");
    const again = await run(dir, ["wasm", "add", "file:dist", "--yes", "--json"]);
    expect(again.report).toMatchObject({ result: { status: "unchanged", consent: "none-needed" } });
  });

  it("refuses to install without consent when nobody can be asked, and writes nothing", async () => {
    const dir = await temporary();
    await release(join(dir, "dist"));
    const refused = await run(dir, ["wasm", "add", "file:dist", "--json"]);
    expect(refused.code).toBe(2);
    expect(refused.report).toMatchObject({ kind: "error", command: "wasm add", error: { code: "INVALID_ARGUMENT", detail: { reason: "wasm-consent-required" } } });
    expect((await readdir(dir)).sort()).toEqual(["dist"]);
    // The way out it names must exist: nothing is written before consent, so there is no installed module.json and no dry run to read.
    const message = JSON.stringify(refused.report);
    expect(message).toContain("--yes");
    expect(message).toContain("module.json of the release");
    expect(message).not.toMatch(/dry run|modules\//u);
  });

  it("shows what the module declares and installs only after a yes", async () => {
    const dir = await temporary();
    await release(join(dir, "dist"), { requires: { host: ["files.sync", "process.spawn"], browser: ["web-locks"], guest: { executables: ["/usr/bin/python3"] } }, license: { spdx: "MPL-2.0", source: "https://example.com/src" } });
    const declined = await run(dir, ["wasm", "add", "file:dist"], false);
    expect(declined.code).toBe(1);
    expect(declined.asked).toEqual(["Install this module? [y/N] "]);
    expect(declined.stderr).toContain("Add module tool 1.0.0");
    expect(declined.stderr).toContain("process.spawn");
    expect(declined.stderr).toContain("/usr/bin/python3");
    expect(declined.stderr).toContain("copyleft");
    expect(declined.stderr).toContain("it is not a sandbox for the programs that run it");
    expect((await readdir(dir)).sort()).toEqual(["dist"]);
    const accepted = await run(dir, ["wasm", "add", "file:dist"], true);
    expect(accepted.code).toBe(0);
    expect(accepted.stdout).toContain("Added tool 1.0.0");
    expect(await readdir(join(dir, "modules", "tool"))).toEqual(["module.json"]);
  });

  it("reports the commands a module declares in the JSON add result, and keeps the previous shape for a module without them", async () => {
    const dir = await temporary();
    await release(join(dir, "dist"), { commands: ["tool-run", "tool"] });
    const added = await run(dir, ["wasm", "add", "file:dist", "--yes", "--json"]);
    expect(added.code).toBe(0);
    expect(added.report).toMatchObject({ kind: "result", command: "wasm add", result: { id: "tool", commands: ["tool", "tool-run"] } });
    const keys = (stdout: string): string[] => { const parsed: unknown = JSON.parse(stdout); const result: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "result") : undefined; return typeof result === "object" && result !== null ? Object.keys(result) : []; };
    expect(keys(added.stdout)).toEqual(["id", "version", "source", "release", "status", "consent", "license", "capabilities", "commands", "added", "removed", "generatedFile"]);
    const plain = await temporary();
    await release(join(plain, "dist"));
    expect(keys((await run(plain, ["wasm", "add", "file:dist", "--yes", "--json"])).stdout)).toEqual(["id", "version", "source", "release", "status", "consent", "license", "capabilities", "added", "removed", "generatedFile"]);
  });

  it("asks again before an update that adds a command, and shows the command it adds", async () => {
    const dir = await temporary();
    await release(join(dir, "dist"), { commands: ["tool"] });
    expect((await run(dir, ["wasm", "add", "file:dist", "--yes", "--json"])).code).toBe(0);
    await rm(join(dir, "dist"), { recursive: true });
    await release(join(dir, "dist"), { commands: ["tool", "tool-run"] }, "1.1.0");
    const declined = await run(dir, ["wasm", "add", "file:dist"], false);
    expect(declined.code).toBe(1);
    expect(declined.asked).toEqual(["Install this module? [y/N] "]);
    expect(declined.stderr).toContain("Update module tool 1.1.0");
    expect(declined.stderr).toContain("  commands tool, tool-run\n");
    expect(declined.stderr).toContain("Compared with the installed release:\n  + command:tool-run");
  });

  it("rejects a release that does not verify, naming the problem", async () => {
    const dir = await temporary();
    await release(join(dir, "dist"));
    await writeFile(join(dir, "dist", "tool.wasm"), "tampered");
    const bad = await run(dir, ["wasm", "add", "file:dist", "--yes", "--json"]);
    expect(bad.code).toBe(2);
    expect(bad.report).toMatchObject({ kind: "error", error: { code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" } } });
  });
});

describe("oxidevm wasm stage, doctor and inspect", () => {
  async function installed() {
    const dir = await temporary();
    await release(join(dir, "dist"));
    await run(dir, ["wasm", "add", "file:dist", "--yes", "--json"]);
    return dir;
  }

  it("rebuilds the staged files after a fresh checkout", async () => {
    const dir = await installed();
    await rm(join(dir, ".oxidevm"), { recursive: true });
    await rm(join(dir, "src"), { recursive: true });
    const staged = await run(dir, ["wasm", "stage", "--json"]);
    expect(staged.report).toMatchObject({ kind: "result", command: "wasm stage", result: { modules: [{ id: "tool", rebuilt: true }], generatedFile: "src/oxidevm.modules.generated.ts" } });
    expect(await readdir(join(dir, "src"))).toEqual(["oxidevm.modules.generated.ts"]);
  });

  it("passes a healthy project and exits 3 when a check fails", async () => {
    const dir = await installed();
    const healthy = await run(dir, ["wasm", "doctor", "--json"]);
    expect(healthy.code).toBe(0);
    expect(healthy.report).toMatchObject({ kind: "result", command: "wasm doctor", result: { result: "passed", modules: ["tool"] } });
    await rm(join(dir, ".oxidevm"), { recursive: true });
    const broken = await run(dir, ["wasm", "doctor", "--json"]);
    expect(broken.code).toBe(3);
    expect(broken.report).toMatchObject({ result: { result: "failed" } });
    expect((await run(dir, ["wasm", "doctor"])).stdout).toContain("FAIL  staged");
  });

  it("reports a binary's ABI and refuses a file that is not WebAssembly", async () => {
    const dir = await temporary();
    await writeFile(join(dir, "a.wasm"), Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0));
    await writeFile(join(dir, "b.wasm"), "not wasm");
    const good = await run(dir, ["wasm", "inspect", "a.wasm", "--json"]);
    expect(good.report).toMatchObject({ kind: "result", command: "wasm inspect", result: { file: "a.wasm", kind: "module", abi: "raw", bytes: 8 } });
    expect((await run(dir, ["wasm", "inspect", "a.wasm"])).stdout).toContain("core module");
    const bad = await run(dir, ["wasm", "inspect", "b.wasm", "--json"]);
    expect(bad.code).toBe(2);
    expect(bad.report).toMatchObject({ kind: "error", error: { code: "INVALID_ARGUMENT" } });
  });

  it("lists the module commands in --help", async () => {
    const dir = await temporary();
    const help = await run(dir, ["--help"]);
    expect(help.stdout).toContain("wasm add <github:owner/repo@tag | file:directory>");
    expect((await run(dir, ["wasm", "stage", "--help"])).stdout).toContain("Rebuilds the staged files");
  });
});

describe("oxidevm wasm init, build and release", () => {
  async function scaffold(kind: "command" | "service" = "command"): Promise<{ readonly dir: string; readonly tool: string }> {
    const dir = await temporary();
    const created = await run(dir, ["wasm", "init", "tool", "--kind", kind, "--json"]);
    expect(created.code).toBe(0);
    return { dir, tool: join(dir, "tool") };
  }

  it("creates a module project and says what to do next", async () => {
    const dir = await temporary();
    const created = await run(dir, ["wasm", "init", "tool", "--kind", "service", "--id", "adder", "--json"]);
    expect(created.report).toMatchObject({ kind: "result", command: "wasm init", result: { id: "adder", kind: "service", abi: "raw", directory: join(dir, "tool") } });
    expect(await stat(join(dir, "tool", "module.ts"))).toBeTruthy();
    const text = await run(await temporary(), ["wasm", "init", "tool"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("a command module named tool (abi raw)");
    expect(text.stdout).toContain("It declares the command tool: once an application turns it on, programs in a VM run it as /usr/local/bin/tool");
    expect(text.stdout).toContain("pnpm run check && pnpm test");
  });

  it("reports the command a command module declares, and why an id with the reserved prefix declares none", async () => {
    const command = await run(await temporary(), ["wasm", "init", "tool", "--json"]);
    expect(command.report).toMatchObject({ kind: "result", command: "wasm init", result: { id: "tool", kind: "command", commands: ["tool"] } });
    const reserved = await run(await temporary(), ["wasm", "init", "tools", "--id", "oxidevm-tools", "--json"]);
    expect(reserved.report).toMatchObject({ kind: "result", command: "wasm init", result: { id: "oxidevm-tools", kind: "command", commands: [] } });
    const text = await run(await temporary(), ["wasm", "init", "tools", "--id", "oxidevm-tools"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("It declares no commands: command names that start with \"oxidevm\" are reserved.");
  });

  it("refuses to create over an existing directory with exit status 2 and leaves it alone", async () => {
    const { dir, tool } = await scaffold();
    const before = await readFile(join(tool, "module.ts"), "utf8");
    const again = await run(dir, ["wasm", "init", "tool", "--json"]);
    expect(again.code).toBe(2);
    expect(JSON.parse(again.stdout)).toMatchObject({ kind: "error", command: "wasm init", error: { code: "INVALID_ARGUMENT" } });
    expect(await readFile(join(tool, "module.ts"), "utf8")).toBe(before);
  });

  it("builds a generated project and writes a verified release", async () => {
    const { dir } = await scaffold();
    const built = await run(dir, ["wasm", "build", "--project", "tool", "--json"]);
    expect(built.code).toBe(0);
    expect(built.report).toMatchObject({ kind: "result", command: "wasm build", result: { result: "built", id: "tool", version: "0.1.0", directory: join("tool", "dist"), findings: [] } });
    expect((await readdir(join(dir, "tool", "dist"))).sort()).toEqual(["SHA256SUMS", "adapter.mjs", "add.wasm", "module.json"]);
    const text = await run(dir, ["wasm", "build", "--project", "tool"]);
    expect(text.stdout).toContain(`Built tool 0.1.0 into ${join("tool", "dist")}.`);
    expect(text.stdout).toMatch(/release {2}[0-9a-f]{64}/u);
  });

  it("verifies without writing in check mode, and names the same release the build then writes", async () => {
    const { dir } = await scaffold();
    const checked = await run(dir, ["wasm", "build", "--project", "tool", "--check", "--json"]);
    expect(checked.code).toBe(0);
    expect(checked.report).toMatchObject({ result: { result: "checked", directory: null } });
    expect(await readdir(join(dir, "tool"))).not.toContain("dist");
    const built = await run(dir, ["wasm", "build", "--project", "tool", "--json"]);
    const release = (report: Run): unknown => report.report?.kind === "result" && report.report.command === "wasm build" ? report.report.result.release : undefined;
    expect(release(built)).toBe(release(checked));
    expect(release(built)).toMatch(/^[0-9a-f]{64}$/u);
    expect((await run(dir, ["wasm", "build", "--project", "tool", "--check"])).stdout).toContain("Checked tool 0.1.0: it builds, and nothing was written.");
  });

  it("exits 3 with located findings when the build fails, in JSON and in text, and writes nothing", async () => {
    const { dir, tool } = await scaffold();
    await writeFile(join(tool, "module.ts"), (await readFile(join(tool, "module.ts"), "utf8")).replace("version: \"0.1.0\"", "version: VERSION"));
    const json = await run(dir, ["wasm", "build", "--project", "tool", "--json"]);
    expect(json.code).toBe(3);
    expect(json.report).toMatchObject({ kind: "result", command: "wasm build", result: { result: "failed", release: null, files: [], findings: [{ severity: "error", code: "manifest-literal", file: "module.ts", line: 7 }] } });
    expect(await readdir(join(tool))).not.toContain("dist");
    const text = await run(dir, ["wasm", "build", "--project", "tool"]);
    expect(text.code).toBe(3);
    expect(text.stdout).toMatch(/^error {3}module\.ts:7:\d+ {2}manifest\.version must be a literal value but is a reference to VERSION.*\[manifest-literal\]$/mu);
    expect(text.stdout).toContain("The build failed with 1 error; nothing was written.");
  });

  it("prints the publishing steps for a release and runs none of them", async () => {
    const { dir, tool } = await scaffold();
    const planned = await run(dir, ["wasm", "release", "--project", "tool", "--repo", "acme/tool", "--json"]);
    expect(planned.code).toBe(0);
    expect(planned.report).toMatchObject({ command: "wasm release", result: { tag: "v0.1.0", build: { result: "built", directory: join("tool", "dist") } } });
    const steps = planned.report?.kind === "result" && planned.report.command === "wasm release" ? planned.report.result.steps : [];
    expect(steps).toHaveLength(5);
    expect(steps[1]).toContain(`gh release create v0.1.0 ${join("tool", "dist")}/* --draft`);
    expect(steps[4]).toContain("github:acme/tool@v0.1.0");
    expect((await readdir(tool)).filter(name => name.startsWith("verify"))).toEqual([]);
    const text = await run(dir, ["wasm", "release", "--project", "tool"]);
    expect(text.stdout).toContain("To publish v0.1.0 (none of this has been run):");
    expect(text.stdout).toContain("github:OWNER/REPO@v0.1.0");
  });

  it("exits 3 and prints no steps when the release cannot be built", async () => {
    const { dir } = await scaffold();
    await rm(join(dir, "tool", "upstream", "add.wasm"));
    const failed = await run(dir, ["wasm", "release", "--project", "tool", "--json"]);
    expect(failed.code).toBe(3);
    expect(failed.report).toMatchObject({ result: { tag: null, steps: [], build: { result: "failed" } } });
    const text = await run(dir, ["wasm", "release", "--project", "tool"]);
    expect(text.code).toBe(3);
    expect(text.stdout).not.toContain("To publish");
    expect(text.stdout).toContain("artifact-missing");
  });

  it("closes the loop: a release built by the author installs in a consumer project and passes doctor", async () => {
    const { dir } = await scaffold("service");
    expect((await run(dir, ["wasm", "build", "--project", "tool"])).code).toBe(0);
    const consumer = await temporary();
    await cp(join(dir, "tool", "dist"), join(consumer, "vendor", "tool"), { recursive: true });
    const added = await run(consumer, ["wasm", "add", "file:vendor/tool", "--yes", "--json"]);
    expect(added.report).toMatchObject({ result: { id: "tool", version: "0.1.0", status: "added", capabilities: [] } });
    expect((await run(consumer, ["wasm", "doctor", "--json"])).code).toBe(0);
  });

  it("starts from a WebAssembly file named relative to where the command runs", async () => {
    const dir = await temporary();
    await mkdir(join(dir, "vendor"));
    await writeFile(join(dir, "vendor", "lib.wasm"), Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0));
    const created = await run(dir, ["wasm", "init", "wrapped", "--from", "vendor/lib.wasm", "--json"]);
    expect(created.code).toBe(0);
    expect(created.report).toMatchObject({ result: { id: "wrapped", abi: "raw" } });
    expect((await readdir(join(dir, "wrapped", "upstream")))).toEqual(["lib.wasm"]);
    const missing = await run(dir, ["wasm", "init", "other", "--from", "vendor/none.wasm", "--json"]);
    expect(missing.code).toBe(2);
    await expect(stat(join(dir, "other"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("builds with an output directory and a module file named on the command line", async () => {
    const { dir, tool } = await scaffold();
    await mkdir(join(tool, "src"), { recursive: true });
    await writeFile(join(tool, "src", "definition.ts"), (await readFile(join(tool, "module.ts"), "utf8")).replace("./src/command.ts", "./command.ts").replace("id: \"tool\"", "id: \"definition\""));
    const built = await run(dir, ["wasm", "build", "--project", "tool", "--module", "src/definition.ts", "--out", "release", "--json"]);
    expect(built.code).toBe(0);
    expect(built.report).toMatchObject({ result: { result: "built", id: "definition", directory: join("tool", "release") } });
    expect((await readdir(join(tool, "release"))).sort()).toEqual(["SHA256SUMS", "adapter.mjs", "add.wasm", "module.json"]);
    expect(await readdir(tool)).not.toContain("dist");
  });

  it("shows an output directory outside where the command runs as the absolute path it is", async () => {
    const { dir, tool } = await scaffold();
    const elsewhere = await temporary();
    await writeFile(join(tool, "module.ts"), await readFile(join(tool, "module.ts"), "utf8"));
    const built = await run(elsewhere, ["wasm", "build", "--project", tool, "--json"]);
    expect(built.report).toMatchObject({ result: { result: "built", directory: join(tool, "dist") } });
    expect(dir).not.toBe(elsewhere);
  });

  it("lists the authoring commands in help", async () => {
    const help = await run(await temporary(), ["--help"]);
    for (const line of ["wasm init <directory>", "wasm build [--project", "wasm release [--project"]) expect(help.stdout).toContain(line);
    expect((await run(await temporary(), ["wasm", "build", "--help"])).stdout).toContain("wasm build [--project");
    const init = (await run(await temporary(), ["wasm", "init", "--help"])).stdout;
    expect(init).toContain("A command module declares its id in commands, so programs in a VM can run it from a shell");
    expect(init).toContain("an id that starts with oxidevm is reserved and gets none");
  });
});

describe("untrusted text in a command's output", () => {
  it("shows an export name that is an escape sequence as its code points, not to the terminal", async () => {
    const dir = await temporary();
    // (module (memory (export "\x1b[2J") 1)): magic and version, one memory, one export named ESC [ 2 J.
    await writeFile(join(dir, "hostile.wasm"), Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, 3, 1, 0, 1, 7, 8, 1, 4, 0x1b, 0x5b, 0x32, 0x4a, 2, 0));
    const text = await run(dir, ["wasm", "inspect", "hostile.wasm"]);
    expect(text.code).toBe(0);
    expect(text.stdout).not.toContain("\u001b");
    expect(text.stdout).toContain("\\u{1b}[2J");
  });
});
