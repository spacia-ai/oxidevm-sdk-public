import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { UserspaceImageRecipe } from "./contracts.js";
import { lockBuildEpoch } from "./build-lock.js";

const recipe: UserspaceImageRecipe = {
  id: "boundary-docker", version: "2026.10.16-1", mode: "userspace", sourceDateEpoch: 1,
  source: { kind: "directory", path: "rootfs" },
  smokeTest: { command: "/bin/sh", expectedExitCode: 0 },
};
const directories: string[] = [];
async function directory(): Promise<string> { const made = await mkdtemp(join(tmpdir(), "oxidevm-lock-")); directories.push(made); return made; }
afterEach(async () => { await Promise.all(directories.splice(0).map(made => rm(made, { recursive: true, force: true }))); });

it("locks a recipe's first build and accepts later builds of the same version", async () => {
  const dir = await directory();
  await expect(lockBuildEpoch(recipe, dir)).resolves.toMatchObject({ sourceDateEpoch: 1 });
  expect(JSON.parse(await readFile(join(dir, "image.lock.json"), "utf8"))).toMatchObject({ schemaVersion: 2, id: "boundary-docker", version: "2026.10.16-1" });
  await expect(lockBuildEpoch(recipe, dir)).resolves.toMatchObject({ version: "2026.10.16-1" });
});

it("accepts the schema 2 author lock that a build saves for the same recipe", async () => {
  const dir = await directory();
  await writeFile(join(dir, "image.lock.json"), `${JSON.stringify({ schemaVersion: 2, kind: "build-inputs", mode: "userspace", id: "boundary-docker", version: "2026.10.16-1", sourceDateEpoch: 1 })}\n`);
  await expect(lockBuildEpoch(recipe, dir)).resolves.toMatchObject({ sourceDateEpoch: 1 });
});

it("explains a version bump instead of calling the same recipe another one", async () => {
  const dir = await directory();
  await lockBuildEpoch(recipe, dir);
  const failure = lockBuildEpoch({ ...recipe, version: "2026.10.16-2" }, dir);
  await expect(failure).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { lockedVersion: "2026.10.16-1", version: "2026.10.16-2" } });
  await expect(failure).rejects.toThrow("image.lock.json locks version 2026.10.16-1 of boundary-docker, but the recipe asks for 2026.10.16-2; delete image.lock.json to lock the new version");
});

it("still refuses a lock written for a different recipe", async () => {
  const dir = await directory();
  await writeFile(join(dir, "image.lock.json"), `${JSON.stringify({ schemaVersion: 2, kind: "build-inputs", mode: "userspace", id: "python", version: "1", sourceDateEpoch: 0 })}\n`);
  await expect(lockBuildEpoch(recipe, dir)).rejects.toThrow("image.lock.json belongs to another recipe; give each recipe its own directory");
});
