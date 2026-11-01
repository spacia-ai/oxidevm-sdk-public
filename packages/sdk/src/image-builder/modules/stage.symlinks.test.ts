import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReleaseFiles } from "./release.test-support.js";
import { DEFAULT_GENERATED_FILE, STAGE_ROOT, stageModules, VENDOR_ROOT, type StageInput } from "./stage.js";
import { releaseInput } from "./stage.test-support.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "oxidevm-stage-links-")); directories.push(directory); return directory; }
async function input(): Promise<StageInput> {
  return releaseInput(buildReleaseFiles({ id: "tool", artifacts: { "tool.wasm": Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0) } }), await temporary());
}

/** A directory outside the project with things in it that must survive whatever happens inside the project. */
async function victim(): Promise<string> {
  const directory = await temporary();
  await mkdir(join(directory, "Documents"));
  await writeFile(join(directory, "Documents", "notes.txt"), "keep");
  await writeFile(join(directory, "passwords.txt"), "keep");
  return directory;
}
const listing = async (directory: string): Promise<string[]> => (await readdir(directory, { recursive: true })).sort();

const LAYOUTS: readonly (readonly [string, (project: string, target: string) => Promise<void>])[] = [
  [".oxidevm", async (project, target) => { await symlink(target, join(project, ".oxidevm")); }],
  [".oxidevm/modules", async (project, target) => { await mkdir(join(project, ".oxidevm")); await symlink(target, join(project, STAGE_ROOT)); }],
  [".oxidevm/modules/<id>", async (project, target) => { await mkdir(join(project, STAGE_ROOT), { recursive: true }); await symlink(target, join(project, STAGE_ROOT, "tool")); }],
  ["modules", async (project, target) => { await symlink(target, join(project, VENDOR_ROOT)); }],
  ["modules/<id>", async (project, target) => { await mkdir(join(project, VENDOR_ROOT)); await symlink(target, join(project, VENDOR_ROOT, "tool")); }],
  ["src, which holds the generated file", async (project, target) => { await symlink(target, join(project, "src")); }],
];

describe("staging in a project that contains symbolic links", () => {
  for (const [name, plant] of LAYOUTS) {
    it(`refuses a symlinked ${name} and leaves what the link points at untouched`, async () => {
      const project = await temporary(), target = await victim(), one = await input();
      await plant(project, target);
      const before = await listing(target);
      await expect(stageModules(new Map([["tool", one]]), { projectDir: project })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(await listing(target)).toEqual(before);
      expect(await readFile(join(target, "passwords.txt"), "utf8")).toBe("keep");
    });
  }

  it("refuses a symlinked staging root even when no module is installed, which is the case that used to delete everything", async () => {
    const project = await temporary(), target = await victim();
    await mkdir(join(project, ".oxidevm"));
    await symlink(target, join(project, STAGE_ROOT));
    const before = await listing(target);
    await expect(stageModules(new Map(), { projectDir: project })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await listing(target)).toEqual(before);
  });

  it("stages normally when the project directory itself is reached through a link", async () => {
    const real = await temporary(), parent = await temporary(), one = await input();
    const viaLink = join(parent, "project");
    await symlink(real, viaLink);
    await stageModules(new Map([["tool", one]]), { projectDir: viaLink });
    expect((await stat(join(real, DEFAULT_GENERATED_FILE))).isFile()).toBe(true);
  });
});

describe("cleaning up staged leftovers", () => {
  const HASH = (digit: string): string => digit.repeat(64);

  it("removes only module directories named like module ids and release directories named like release ids", async () => {
    const project = await temporary(), one = await input(), target = await victim();
    await stageModules(new Map([["tool", one]]), { projectDir: project });
    const root = join(project, STAGE_ROOT);
    // Leftovers that belong to the tool: a removed module and an old release of the installed one.
    await mkdir(join(root, "old-tool", HASH("a")), { recursive: true });
    await mkdir(join(root, "tool", HASH("b")), { recursive: true });
    // Things the tool never created: it must not touch them, however they are named.
    await writeFile(join(root, "README.txt"), "mine");
    await mkdir(join(root, "Not_An_Id"));
    await writeFile(join(root, "Not_An_Id", "work.txt"), "mine");
    await symlink(target, join(root, "elsewhere"));
    await mkdir(join(root, "tool", "my-notes"));
    await writeFile(join(root, "tool", "release.txt"), "mine");
    await symlink(target, join(root, "tool", HASH("c")));
    const before = await listing(target);

    const result = await stageModules(new Map([["tool", one]]), { projectDir: project });

    expect([...result.removed].sort()).toEqual(["old-tool", `tool/${HASH("b")}`]);
    expect((await readdir(root)).sort()).toEqual(["Not_An_Id", "README.txt", "elsewhere", "tool"]);
    expect((await readdir(join(root, "tool"))).sort()).toEqual([HASH("c"), "my-notes", one.release.id, "release.txt"].sort());
    expect(await readFile(join(root, "Not_An_Id", "work.txt"), "utf8")).toBe("mine");
    expect(await listing(target)).toEqual(before);
  });
});

describe("temporary files a killed run leaves next to what it writes", () => {
  const UUID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";

  it("removes the ones that are an hour old and named like this tool's own, and no other file", async () => {
    const project = await temporary(), one = await input();
    await stageModules(new Map([["tool", one]]), { projectDir: project });
    const generated = join(project, DEFAULT_GENERATED_FILE), vendored = join(project, VENDOR_ROOT, "tool", "module.json");
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    const orphans = [`${generated}.${UUID}.tmp`, `${vendored}.${UUID}.tmp`];
    for (const orphan of orphans) { await writeFile(orphan, "half written"); await utimes(orphan, twoHoursAgo, twoHoursAgo); }
    // A recent one may belong to a run that is still going; a differently named file is not this tool's.
    const recent = `${generated}.${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}.tmp`, mine = `${generated}.notes.tmp`, other = join(project, "src", `other.ts.${UUID}.tmp`);
    for (const path of [recent, mine, other]) { await writeFile(path, "keep"); await utimes(path, twoHoursAgo, twoHoursAgo); }
    await utimes(recent, new Date(), new Date());

    // The files are identical, so nothing is rewritten; the sweep must not depend on a rewrite.
    await stageModules(new Map([["tool", one]]), { projectDir: project });

    for (const orphan of orphans) await expect(stat(orphan), orphan).rejects.toThrow();
    for (const path of [recent, mine, other]) expect((await stat(path)).isFile(), path).toBe(true);
  });
});
