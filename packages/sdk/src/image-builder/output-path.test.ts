import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildImage } from "./build.js";
import { generateImageKey } from "./keys.js";

it.each(["root", "author.pem", ".."])("refuses distribution output %s before building or replacing inputs", async outDir => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-output-safety-"));
  try {
    await mkdir(join(directory, "root")); await writeFile(join(directory, "root/input"), "retained");
    const key = await generateImageKey(join(directory, "author.pem"));
    const originalKey = await readFile(key.privateKeyPath); const progress: string[] = [];
    await expect(buildImage({ id: "safety", version: "1", mode: "userspace", sourceDateEpoch: 1,
      source: { kind: "directory", path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 },
      evidence: { sbom: { kind: "file", path: "missing.json" }, noticesFile: "notices.json", correspondingSourcesFile: "sources.json", licensePolicyFile: "review.json" } },
    { recipeDir: directory, signingKeyFile: "author.pem", outDir, purpose: "distribution", onProgress: event => progress.push(event.phase) })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(progress).toEqual([]); expect(await readFile(key.privateKeyPath)).toEqual(originalKey);
    expect(await readFile(join(directory, "root/input"), "utf8")).toBe("retained");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
