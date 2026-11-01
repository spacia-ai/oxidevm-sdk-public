import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DECLARATION_FILE, LOCK_FILE, loadModulesProject, readVendoredManifest } from "./project.js";
import { readProjectFile } from "./project-files.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "oxidevm-project-files-")); directories.push(directory); return directory; }

describe("reading the files of a project", () => {
  it("returns nothing for an absent file and the bytes of a regular one", async () => {
    const directory = await temporary();
    await writeFile(join(directory, "there.json"), "{}\n");
    await expect(readProjectFile(join(directory, "absent.json"), 100)).resolves.toBeUndefined();
    expect(new TextDecoder().decode(await readProjectFile(join(directory, "there.json"), 100))).toBe("{}\n");
  });

  it("refuses a link, however it is spelled, before opening anything", async () => {
    const directory = await temporary();
    await writeFile(join(directory, "real.json"), "{}");
    await symlink(join(directory, "real.json"), join(directory, "link.json"));
    await symlink("/dev/zero", join(directory, "zero.json"));
    await symlink(join(directory, "nowhere"), join(directory, "dangling.json"));
    for (const name of ["link.json", "zero.json", "dangling.json"]) {
      await expect(readProjectFile(join(directory, name), 1000), name).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });

  it("refuses a directory and a file over its bound without reading it", async () => {
    const directory = await temporary();
    await mkdir(join(directory, "folder.json"));
    await writeFile(join(directory, "big.json"), new Uint8Array(2001));
    await expect(readProjectFile(join(directory, "folder.json"), 1000)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readProjectFile(join(directory, "big.json"), 2000)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readProjectFile(join(directory, "big.json"), 2001)).resolves.toHaveLength(2001);
  });

  it("refuses a named pipe at once instead of waiting for someone to write to it", async () => {
    const directory = await temporary();
    execFileSync("mkfifo", [join(directory, "pipe.json")]);
    await expect(readProjectFile(join(directory, "pipe.json"), 1000)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  }, 3000);

  it("names the file in the error", async () => {
    const directory = await temporary();
    await symlink("/dev/zero", join(directory, "zero.json"));
    await expect(readProjectFile(join(directory, "zero.json"), 10, "oxidevm.modules.lock.json")).rejects.toThrow(/oxidevm\.modules\.lock\.json/u);
  });
});

describe("loading a project whose files are not what they should be", () => {
  it("refuses a lock or a declaration that is a link or exceeds its bound", async () => {
    for (const file of [LOCK_FILE, DECLARATION_FILE]) {
      const linked = await temporary();
      await symlink("/dev/zero", join(linked, file));
      await expect(loadModulesProject(linked), `${file} as a link`).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      const large = await temporary();
      await writeFile(join(large, file), new Uint8Array(2 * 1024 * 1024).fill(32));
      await expect(loadModulesProject(large), `${file} oversize`).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });

  it("refuses a vendored manifest that is a link", async () => {
    const project = await temporary();
    await mkdir(join(project, "modules", "tool"), { recursive: true });
    await symlink("/dev/zero", join(project, "modules", "tool", "module.json"));
    await expect(readVendoredManifest(project, "tool")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("starts empty when neither file exists", async () => {
    expect(await loadModulesProject(await temporary())).toEqual({ declaration: { schemaVersion: 1, trusted: [], modules: [] }, lock: { schemaVersion: 1, modules: {} } });
  });
});
