// scripts/packed-archives.ts: the archive names `pnpm pack` gives the SDK and CLI follow the packages'
// current versions, so a release bump never leaves a script pointing at a stale file name.
// (`node --test scripts/packed-archives.test.ts`)
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { archiveFileName, packedArchives } from "./packed-archives.ts";

async function scratch(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-archives-test-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function writeManifests(root: string, sdk: unknown, cli: unknown): Promise<void> {
  for (const [directory, manifest] of [["packages/sdk", sdk], ["packages/cli", cli]] as const) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, "package.json"), typeof manifest === "string" ? manifest : `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

await test("names an archive the way pnpm pack does", () => {
  assert.equal(archiveFileName("@oxidevm/sdk", "0.1.0-alpha.7"), "oxidevm-sdk-0.1.0-alpha.7.tgz");
  assert.equal(archiveFileName("@oxidevm/cli", "1.2.3"), "oxidevm-cli-1.2.3.tgz");
  assert.equal(archiveFileName("left-pad", "1.3.0"), "left-pad-1.3.0.tgz");
});

await test("derives the .candidate archive paths from the packages' current versions and follows a bump", async () => {
  await scratch(async root => {
    await writeManifests(root, { name: "@oxidevm/sdk", version: "0.1.0-alpha.7" }, { name: "@oxidevm/cli", version: "0.1.0-alpha.7" });
    assert.deepEqual(await packedArchives(root), {
      sdk: join(root, ".candidate", "oxidevm-sdk-0.1.0-alpha.7.tgz"),
      cli: join(root, ".candidate", "oxidevm-cli-0.1.0-alpha.7.tgz"),
    });
    await writeManifests(root, { name: "@oxidevm/sdk", version: "0.1.0-alpha.8" }, { name: "@oxidevm/cli", version: "0.1.0-alpha.8" });
    assert.deepEqual(await packedArchives(root), {
      sdk: join(root, ".candidate", "oxidevm-sdk-0.1.0-alpha.8.tgz"),
      cli: join(root, ".candidate", "oxidevm-cli-0.1.0-alpha.8.tgz"),
    });
  });
});

await test("refuses manifests it cannot turn into a file name", async () => {
  await scratch(async root => {
    const ok = { name: "@oxidevm/cli", version: "0.1.0-alpha.7" };
    await writeManifests(root, "[]", ok);
    await assert.rejects(packedArchives(root), /packages\/sdk\/package\.json must be an object/u);
    await writeManifests(root, { name: "@oxidevm/sdk" }, ok);
    await assert.rejects(packedArchives(root), /packages\/sdk\/package\.json version must be a string/u);
    await writeManifests(root, { name: 7, version: "0.1.0-alpha.7" }, ok);
    await assert.rejects(packedArchives(root), /packages\/sdk\/package\.json name must be a string/u);
    for (const version of ["../escape", "0.1.0/alpha", "", "a b", "0.1.0-alpha.7\n"]) {
      await writeManifests(root, { name: "@oxidevm/sdk", version }, ok);
      await assert.rejects(packedArchives(root), /not a usable archive version/u, JSON.stringify(version));
    }
    await writeManifests(root, { name: "@oxidevm/sdk/../x", version: "0.1.0-alpha.7" }, ok);
    await assert.rejects(packedArchives(root), /not a usable package name/u);
    await writeManifests(root, "not json", ok);
    await assert.rejects(packedArchives(root), /packages\/sdk\/package\.json/u);
  });
});
