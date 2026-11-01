import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GENERATED_MARKER } from "./generate.js";
import { buildReleaseFiles, type BuiltRelease } from "./release.test-support.js";
import { DEFAULT_GENERATED_FILE, STAGE_ROOT, stageModules, VENDOR_ROOT, type StageInput } from "./stage.js";
import { releaseInput } from "./stage.test-support.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "oxidevm-stage-")); directories.push(directory); return directory; }

/** Writes a release's files to a new source directory and returns the verified release with where each file is. */
async function input(release: BuiltRelease): Promise<StageInput> { return releaseInput(release, await temporary()); }
const toolRelease = () => buildReleaseFiles({ id: "tool", artifacts: { "tool.wasm": Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0), "NOTICE": new TextEncoder().encode("notice") } });

describe("staging modules", () => {
  it("lays out the verified release, a committed copy of module.json and the generated handles", async () => {
    const project = await temporary(), release = toolRelease(), one = await input(release);
    const result = await stageModules(new Map([["tool", one]]), { projectDir: project });
    const directory = join(project, STAGE_ROOT, "tool", one.release.id);
    expect((await readdir(directory)).sort()).toEqual(["NOTICE", "SHA256SUMS", "adapter.mjs", "adapter.mjs.bin", "module.json", "tool.wasm"]);
    expect(new Uint8Array(await readFile(join(directory, "adapter.mjs.bin")))).toEqual(release.files.get("adapter.mjs"));
    expect(new Uint8Array(await readFile(join(directory, "tool.wasm")))).toEqual(release.files.get("tool.wasm"));
    expect(new Uint8Array(await readFile(join(project, VENDOR_ROOT, "tool", "module.json")))).toEqual(release.manifestBytes);
    const generated = await readFile(join(project, DEFAULT_GENERATED_FILE), "utf8");
    expect(generated.startsWith(GENERATED_MARKER)).toBe(true);
    expect(generated).toContain(`new URL("../.oxidevm/modules/tool/${one.release.id}/adapter.mjs.bin", import.meta.url).href`);
    expect(result).toMatchObject({ staged: [{ id: "tool", release: one.release.id, rebuilt: true }], vendored: ["tool"], removed: [] });
  });

  it("changes nothing the second time", async () => {
    const project = await temporary(), one = await input(toolRelease());
    await stageModules(new Map([["tool", one]]), { projectDir: project });
    const before = (await stat(join(project, DEFAULT_GENERATED_FILE))).mtimeMs;
    const again = await stageModules(new Map([["tool", one]]), { projectDir: project });
    expect(again).toMatchObject({ staged: [{ rebuilt: false }], vendored: [], removed: [] });
    expect((await stat(join(project, DEFAULT_GENERATED_FILE))).mtimeMs).toBe(before);
  });

  it("rebuilds a staged release whose served copy is missing or was changed, because a development server would send the wrong bytes", async () => {
    const project = await temporary(), one = await input(toolRelease());
    await stageModules(new Map([["tool", one]]), { projectDir: project });
    const copy = join(project, STAGE_ROOT, "tool", one.release.id, "adapter.mjs.bin");
    await writeFile(copy, "export default () => 1;");
    expect((await stageModules(new Map([["tool", one]]), { projectDir: project })).staged[0]?.rebuilt).toBe(true);
    expect(new Uint8Array(await readFile(copy))).toEqual(toolRelease().files.get("adapter.mjs"));
    await rm(copy);
    expect((await stageModules(new Map([["tool", one]]), { projectDir: project })).staged[0]?.rebuilt).toBe(true);
    expect(await stat(copy)).toBeTruthy();
    expect((await stageModules(new Map([["tool", one]]), { projectDir: project })).staged[0]?.rebuilt).toBe(false);
  });

  it("serves a script artifact through a copy too, and leaves other artifacts alone", async () => {
    const project = await temporary();
    const release = buildReleaseFiles({ id: "tool", artifacts: { "worker.js": new TextEncoder().encode("export {};"), "tool.wasm": Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0) } });
    const one = await input(release);
    await stageModules(new Map([["tool", one]]), { projectDir: project });
    expect((await readdir(join(project, STAGE_ROOT, "tool", one.release.id))).sort()).toEqual(["SHA256SUMS", "adapter.mjs", "adapter.mjs.bin", "module.json", "tool.wasm", "worker.js", "worker.js.bin"]);
    const generated = await readFile(join(project, DEFAULT_GENERATED_FILE), "utf8");
    expect(generated).toContain("worker.js.bin");
    expect(generated).not.toContain("tool.wasm.bin");
  });

  it("rebuilds a staged release whose file was damaged", async () => {
    const project = await temporary(), one = await input(toolRelease());
    await stageModules(new Map([["tool", one]]), { projectDir: project });
    const damaged = join(project, STAGE_ROOT, "tool", one.release.id, "tool.wasm");
    await writeFile(damaged, "damaged");
    const result = await stageModules(new Map([["tool", one]]), { projectDir: project });
    expect(result.staged[0]?.rebuilt).toBe(true);
    expect(new Uint8Array(await readFile(damaged))).toEqual(Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0));
  });

  it("removes earlier releases of a module and modules that are no longer installed", async () => {
    const project = await temporary(), first = await input(toolRelease()), other = await input(buildReleaseFiles({ id: "other" }));
    await stageModules(new Map([["tool", first], ["other", other]]), { projectDir: project });
    const second = await input(buildReleaseFiles({ id: "tool", adapter: "export default () => ({ main: () => 1 });" }));
    const result = await stageModules(new Map([["tool", second]]), { projectDir: project });
    expect((await readdir(join(project, STAGE_ROOT))).sort()).toEqual(["tool"]);
    expect(await readdir(join(project, STAGE_ROOT, "tool"))).toEqual([second.release.id]);
    expect([...result.removed].sort()).toEqual(["other", `tool/${first.release.id}`]);
    expect(await readFile(join(project, DEFAULT_GENERATED_FILE), "utf8")).not.toContain("export const other");
  });

  it("leaves the previous release in place when the new one cannot be completed", async () => {
    const project = await temporary(), first = await input(toolRelease());
    await stageModules(new Map([["tool", first]]), { projectDir: project });
    const broken = await input(toolRelease());
    const missing = new Map(broken.paths);
    missing.delete("tool.wasm");
    const changed = await input(buildReleaseFiles({ id: "tool", adapter: "export default () => ({ main: () => 2 });" }));
    const paths = new Map(changed.paths);
    paths.delete("adapter.mjs");
    await expect(stageModules(new Map([["tool", { release: changed.release, paths }]]), { projectDir: project })).rejects.toThrow(/no verified source for adapter.mjs/u);
    expect(await readdir(join(project, STAGE_ROOT, "tool"))).toContain(first.release.id);
    expect(missing.has("tool.wasm")).toBe(false);
  });

  it("refuses to overwrite a generated-file path that someone else wrote, or one outside the project", async () => {
    const project = await temporary(), one = await input(toolRelease());
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, DEFAULT_GENERATED_FILE), "export const mine = 1;\n");
    await expect(stageModules(new Map([["tool", one]]), { projectDir: project })).rejects.toThrow(/was not generated by oxidevm/u);
    expect(await readFile(join(project, DEFAULT_GENERATED_FILE), "utf8")).toBe("export const mine = 1;\n");
    await expect(stageModules(new Map([["tool", one]]), { projectDir: project, generatedFile: "../outside.ts" })).rejects.toThrow(/inside the project/u);
  });

  it("refuses a module whose release has a different id than the one it is installed under", async () => {
    const project = await temporary(), one = await input(toolRelease());
    await expect(stageModules(new Map([["renamed", one]]), { projectDir: project })).rejects.toThrow(/is declared but its release is tool/u);
  });
});
