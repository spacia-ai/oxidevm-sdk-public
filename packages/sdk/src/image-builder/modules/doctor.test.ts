import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeModulesDeclarationBytes, encodeModulesDeclaration } from "../../wasm/declaration.js";
import { BlobCache } from "./cache.js";
import { DOCTOR_CHECKS, doctorModules, type WasmDoctorReport } from "./doctor.js";
import { githubStub } from "./github.test-support.js";
import { commitAdd, DECLARATION_FILE, LOCK_FILE, previewAdd, stageProject } from "./project.js";
import { decodeModulesLockBytes, encodeModulesLock, type LockedModule } from "../../wasm/lock.js";
import { lockedModule, resolveSource } from "./resolve.js";
import { buildReleaseFiles, writeReleaseDirectory } from "./release.test-support.js";
import { STAGE_ROOT } from "./stage.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "oxidevm-doctor-")); directories.push(directory); return directory; }

/** A project with one installed module. */
async function installed(extra: Readonly<Record<string, unknown>> = {}) {
  const dir = await temporary(), cache = new BlobCache(await temporary());
  await writeFile(join(dir, DECLARATION_FILE), encodeModulesDeclaration({ schemaVersion: 1, trusted: ["acme"], modules: [] }));
  const stub = githubStub(buildReleaseFiles({ id: "tool", extra }));
  const context = { projectDir: dir, cache, fetchImpl: stub.fetchImpl };
  const preview = await previewAdd(dir, "github:acme/tool-module@v1.0.0", context);
  await commitAdd(dir, preview, context);
  return { dir, release: preview.card.release };
}
/** A project built from a release directory without going through `add`: declaration, lock, committed manifest, staged files. */
async function assembled(release: ReturnType<typeof buildReleaseFiles>): Promise<string> {
  const dir = await temporary(), source = join(dir, "vendor", "tool");
  await writeReleaseDirectory(source, release);
  await writeFile(join(dir, DECLARATION_FILE), encodeModulesDeclaration({ schemaVersion: 1, trusted: [], modules: [{ id: "tool", from: "file:vendor/tool" }] }));
  const context = { projectDir: dir, cache: new BlobCache(await temporary()) };
  const resolution = await resolveSource({ kind: "file", path: "vendor/tool" }, context);
  await writeFile(join(dir, LOCK_FILE), encodeModulesLock({ schemaVersion: 1, modules: { tool: lockedModule(resolution) } }));
  await stageProject(dir, context);
  return dir;
}
/** Rewrite the lock's entry for `tool`, through the same codec the tool itself uses. */
async function changeLock(dir: string, change: Partial<LockedModule>): Promise<void> {
  const lock = decodeModulesLockBytes(await readFile(join(dir, LOCK_FILE)));
  const entry = lock.modules["tool"];
  if (entry === undefined) throw new Error("the fixture project has no tool entry");
  await writeFile(join(dir, LOCK_FILE), encodeModulesLock({ ...lock, modules: { ...lock.modules, tool: { ...entry, ...change } } }));
}
/** Point the declaration's `tool` entry at another source. */
async function changeDeclaration(dir: string, from: string): Promise<void> {
  const declaration = decodeModulesDeclarationBytes(await readFile(join(dir, DECLARATION_FILE)));
  await writeFile(join(dir, DECLARATION_FILE), encodeModulesDeclaration({ ...declaration, modules: [{ id: "tool", from }] }));
}
const status = (report: WasmDoctorReport, check: (typeof DOCTOR_CHECKS)[number]) => report.checks.find(entry => entry.check === check);

describe("the module doctor", () => {
  it("passes a consistent project, listing every check once and noting the hosting requirement", async () => {
    const { dir } = await installed();
    const report = await doctorModules(dir);
    expect(report.result).toBe("passed");
    expect(report.modules).toEqual(["tool"]);
    expect(report.checks.map(entry => entry.check)).toEqual([...DOCTOR_CHECKS]);
    expect(status(report, "hosting")).toMatchObject({ status: "note", message: expect.stringContaining("self-hosted") as unknown });
  });

  it("passes a project with no modules", async () => {
    const report = await doctorModules(await temporary());
    expect(report.result).toBe("passed");
    expect(report.modules).toEqual([]);
  });

  it("finds a staged release that was deleted, damaged or replaced", async () => {
    const { dir, release } = await installed();
    await writeFile(join(dir, STAGE_ROOT, "tool", release, "tool.wasm"), "damaged");
    const report = await doctorModules(dir);
    expect(report.result).toBe("failed");
    expect(status(report, "staged")).toMatchObject({ status: "failed", message: expect.stringContaining("is not staged") as unknown });
    expect(status(report, "generated")).toMatchObject({ status: "failed" });
    await rm(join(dir, STAGE_ROOT), { recursive: true });
    expect(status(await doctorModules(dir), "staged")?.status).toBe("failed");
  });

  it("finds a served copy that was changed or removed, which a development server would send to the page", async () => {
    const { dir, release } = await installed();
    const copy = join(dir, STAGE_ROOT, "tool", release, "adapter.mjs.bin");
    expect((await doctorModules(dir)).result).toBe("passed");
    await writeFile(copy, "export default () => 1;");
    expect(status(await doctorModules(dir), "staged")).toMatchObject({ status: "failed", message: expect.stringContaining("served copy adapter.mjs.bin differs") as unknown });
    await rm(copy);
    expect(status(await doctorModules(dir), "staged")).toMatchObject({ status: "failed", message: expect.stringContaining("missing the served copy adapter.mjs.bin") as unknown });
  });

  it("finds a staged directory that holds a different, valid release", async () => {
    const { dir, release } = await installed();
    const other = buildReleaseFiles({ id: "tool", version: "2.0.0" });
    const staged = join(dir, STAGE_ROOT, "tool", release);
    await rm(staged, { recursive: true });
    await writeReleaseDirectory(staged, other);
    await writeFile(join(staged, "adapter.mjs.bin"), other.files.get("adapter.mjs") ?? new Uint8Array());
    expect(status(await doctorModules(dir), "staged")).toMatchObject({ status: "failed", message: expect.stringContaining("staged with a different release") as unknown });
  });

  it("finds generated handles that no longer match what is staged", async () => {
    const { dir } = await installed();
    const path = join(dir, "src/oxidevm.modules.generated.ts");
    await writeFile(path, `${await readFile(path, "utf8")}// hand edit\n`);
    expect(status(await doctorModules(dir), "generated")).toMatchObject({ status: "failed", message: expect.stringContaining("out of date") as unknown });
    await rm(path);
    expect(status(await doctorModules(dir), "generated")).toMatchObject({ status: "failed", message: expect.stringContaining("is missing") as unknown });
  });

  it("finds a committed module.json that is broken or differs from the lock, and a lock that lost its module", async () => {
    const { dir } = await installed();
    const vendored = join(dir, "modules", "tool", "module.json");
    const original = await readFile(vendored);
    await writeFile(vendored, "{}");
    expect(status(await doctorModules(dir), "vendored")).toMatchObject({ status: "failed", message: expect.stringContaining("missing or invalid") as unknown });
    await writeFile(vendored, buildReleaseFiles({ id: "tool", version: "9.9.9" }).manifestBytes);
    expect(status(await doctorModules(dir), "vendored")).toMatchObject({ status: "failed", message: expect.stringContaining("differs from the lock") as unknown });
    // A copy the lock does not pin cannot vouch for the lock, so the difference is reported once, by the check that found it.
    expect(status(await doctorModules(dir), "lock")?.status).toBe("passed");
    await writeFile(vendored, original);
    expect(status(await doctorModules(dir), "vendored")?.status).toBe("passed");
    await writeFile(join(dir, LOCK_FILE), '{\n  "schemaVersion": 1,\n  "modules": {}\n}\n');
    expect(status(await doctorModules(dir), "lock")).toMatchObject({ status: "failed", message: expect.stringContaining("tool is not locked") as unknown });
  });

  it("fails copyleft without a source link and notes copyleft with one", async () => {
    // `oxidevm wasm add` refuses a copyleft release that names no source, so the project is assembled the way an older
    // tool, or a person editing the lock, could have left it: the doctor is the check that remains.
    const without = await assembled(buildReleaseFiles({ id: "tool", extra: { license: { spdx: "GPL-3.0-only" } } }));
    expect(status(await doctorModules(without), "license")).toMatchObject({ status: "failed", message: expect.stringContaining("without a source link") as unknown });
    const withSource = await installed({ license: { spdx: "MPL-2.0", source: "https://example.com/tool-src" } });
    expect(status(await doctorModules(withSource.dir), "license")).toMatchObject({ status: "note" });
  });

  it("is where a copyleft release without a source is refused when it is added", async () => {
    await expect(installed({ license: { spdx: "GPL-3.0-only" } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("says what each installed module needs from the page and the image, and how many host commands can run at once", async () => {
    const { dir } = await installed({ requires: { host: ["files.sync"], browser: ["jspi", "web-locks"], guest: { executables: ["/usr/bin/python3", "/usr/bin/psql"] } } });
    const hosting = status(await doctorModules(dir), "hosting");
    expect(hosting?.status).toBe("note");
    const message = hosting?.status === "note" ? hosting.message : "";
    expect(message).toContain("tool needs the browser features jspi, web-locks");
    expect(message).toContain("the programs /usr/bin/psql, /usr/bin/python3 in the image"); // a manifest lists them sorted
    expect(message).toContain("at most 32 host commands");
    expect(message).not.toMatch(/four/u);
    // A module that asks for nothing extra adds nothing to the note.
    const plainEntry = status(await doctorModules((await installed()).dir), "hosting");
    const plain = plainEntry?.status === "note" ? plainEntry.message : "";
    expect(plain).not.toContain("needs");
    expect(plain).toContain("self-hosted runtime");
  });

  it("fails when the modules need a newer Userspace API than the SDK provides", async () => {
    const { dir } = await installed();
    // files.sync serves utimes and unsignalled writes from API 144, so API 143 is one short.
    expect(status(await doctorModules(dir, { engineApi: 143 }), "engine-api")).toMatchObject({ status: "failed", message: expect.stringContaining("Userspace API 144") as unknown });
    expect(status(await doctorModules(dir, { engineApi: 144 }), "engine-api")).toMatchObject({ status: "passed" });
  });
});

describe("the doctor cross-checks the project's three records", () => {
  it("fails when the lock claims other capabilities or another version than the committed module.json", async () => {
    const { dir } = await installed();
    await changeLock(dir, { capabilities: [] });
    expect(status(await doctorModules(dir), "lock")).toMatchObject({ status: "failed", message: expect.stringContaining("capabilities") as unknown });
    await changeLock(dir, { capabilities: ["files.sync"], version: "9.9.9" });
    expect(status(await doctorModules(dir), "lock")).toMatchObject({ status: "failed", message: expect.stringContaining("version") as unknown });
  });

  it("fails when the declaration names another source than the lock does", async () => {
    const { dir } = await installed();
    for (const from of ["github:somebody-else/other@v7", "github:acme/tool-module@v9.9.9", "file:vendor/tool"]) {
      await changeDeclaration(dir, from);
      expect(status(await doctorModules(dir), "lock"), from).toMatchObject({ status: "failed", message: expect.stringContaining("declaration") as unknown });
    }
  });

  it("fails when a declaration points at another directory than the lock pinned", async () => {
    const dir = await assembled(buildReleaseFiles({ id: "tool" }));
    expect(status(await doctorModules(dir), "lock")?.status).toBe("passed");
    await changeDeclaration(dir, "file:vendor/elsewhere");
    expect(status(await doctorModules(dir), "lock")).toMatchObject({ status: "failed", message: expect.stringContaining("declaration") as unknown });
  });

  it("reports a declared module whose id names a plain-object method as not locked when the lock has no entry for it", async () => {
    const dir = await temporary();
    await writeFile(join(dir, DECLARATION_FILE), encodeModulesDeclaration({ schemaVersion: 1, trusted: [], modules: [{ id: "constructor", from: "file:vendor/constructor" }] }));
    await writeFile(join(dir, LOCK_FILE), encodeModulesLock({ schemaVersion: 1, modules: {} }));
    expect(status(await doctorModules(dir), "lock")).toMatchObject({ status: "failed", message: expect.stringContaining("constructor is not locked") as unknown });
  });

  it("accepts a declaration that spells the owner and repository in another case", async () => {
    const { dir } = await installed();
    await changeDeclaration(dir, "github:ACME/Tool-Module@v1.0.0");
    expect(status(await doctorModules(dir), "lock")).toMatchObject({ status: "passed" });
  });
});
