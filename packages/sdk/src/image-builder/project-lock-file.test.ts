import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { legacyImageLocations } from "../default-images.test-support.js";
import { createProjectLock, decodeProjectConfig } from "./project.js";
import { openProjectLock, readProjectLockFile } from "./project-lock-file.js";

const config = decodeProjectConfig({ mode: "userspace", image: legacyImageLocations.userspace });
const lock = () => `${JSON.stringify(createProjectLock(config))}\n`;

async function scratch(work: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "oxvm-lock-"));
  try { await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

it("creates the canonical lock for a fresh project", async () => {
  await scratch(async directory => {
    await (await openProjectLock(directory, config, false)).commit();
    expect(JSON.parse(await readFile(join(directory, "oxvm.lock.json"), "utf8"))).toEqual(createProjectLock(config));
    await expect(readFile(join(directory, "oxidevm.lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("retains an existing legacy lock and its bytes", async () => {
  await scratch(async directory => {
    const original = lock();
    await writeFile(join(directory, "oxidevm.lock.json"), original);
    expect((await (await openProjectLock(directory, config, false)).commit()).updated).toBe(false);
    expect(await readFile(join(directory, "oxidevm.lock.json"), "utf8")).toBe(original);
    await expect(readFile(join(directory, "oxvm.lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("keeps the legacy filename when an existing legacy configuration has no lock", async () => {
  await scratch(async directory => {
    await writeFile(join(directory, "oxidevm.config.ts"), "export default {};\n");
    await (await openProjectLock(directory, config, false)).commit();
    expect(JSON.parse(await readFile(join(directory, "oxidevm.lock.json"), "utf8"))).toEqual(createProjectLock(config));
    await expect(readFile(join(directory, "oxvm.lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("refuses conflicting lock files before changing either file", async () => {
  await scratch(async directory => {
    const original = lock();
    for (const name of ["oxvm.lock.json", "oxidevm.lock.json"]) await writeFile(join(directory, name), original);
    await expect(openProjectLock(directory, config, true)).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "project-file-conflict" } });
    for (const name of ["oxvm.lock.json", "oxidevm.lock.json"]) expect(await readFile(join(directory, name), "utf8")).toBe(original);
  });
});

it("keeps lock size and symlink checks on both filenames", async () => {
  for (const name of ["oxvm.lock.json", "oxidevm.lock.json"]) await scratch(async directory => {
    await writeFile(join(directory, name), new Uint8Array(1024 ** 2 + 1));
    await expect(readProjectLockFile(directory)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await rm(join(directory, name));
    await writeFile(join(directory, "target.json"), lock());
    await symlink("target.json", join(directory, name));
    await expect(readProjectLockFile(directory)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });
});

it("does not overwrite a lock changed after staging started", async () => {
  await scratch(async directory => {
    const path = join(directory, "oxvm.lock.json");
    await writeFile(path, JSON.stringify({ ...createProjectLock(config), sdkVersion: "0.0.8" }));
    const session = await openProjectLock(directory, config, true);
    const concurrent = `${lock()}\n`;
    await writeFile(path, concurrent);
    await expect(session.commit()).rejects.toMatchObject({ code: "PERMISSION_DENIED", detail: { reason: "project-lock-changed" } });
    expect(await readFile(path, "utf8")).toBe(concurrent);
  });
});
