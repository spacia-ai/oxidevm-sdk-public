import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildImage } from "./build.js";
import { inspectImageFiles } from "./bundle.js";
import { hash } from "./files.js";
import { generateImageKey } from "./keys.js";
import { validateDistributionBundle, validateImageDistribution } from "./distribution-validation.js";
import { assertReproduction } from "./distribution.js";

it("identifies the mismatched reproduction authority without accepting identical payload bytes alone", () => {
  const first = { inventory: [{ path: "bin/app", bytes: 1, sha256: "a".repeat(64) }], payloadSHA256: "b".repeat(64), sourceIdentity: `sha256:${"c".repeat(64)}`, buildInputs: { kind: "directory" as const, sourceSHA256: "d".repeat(64) } };
  expect(() => assertReproduction(first, first)).not.toThrow();
  expect(() => assertReproduction(first, { ...first, sourceIdentity: `sha256:${"e".repeat(64)}` })).toThrow(/source identity/u);
  expect(() => assertReproduction(first, { ...first, payloadSHA256: "f".repeat(64) })).toThrow(/payload/u);
  expect(() => assertReproduction(first, { ...first, inventory: [] })).toThrow(/inventory/u);
});

it("publishes independently reproduced candidates with their complete reviewed evidence closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-distribution-"));
  try {
    await mkdir(join(root, "root/workspace"), { recursive: true });
    await writeFile(join(root, "root/workspace/hello"), "owned fixture\n");
    const key = await generateImageKey(join(root, "author.pem"));
    const packageId = "SPDXRef-Owned-Fixture";
    const notice = "MIT License\nCopyright 2026 OxideVM fixture authors\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction, subject to inclusion of this notice. THE SOFTWARE IS PROVIDED AS IS.";
    await writeFile(join(root, "sbom.json"), JSON.stringify({ spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT",
      packages: [{ SPDXID: packageId, name: "owned-fixture", versionInfo: "1", licenseConcluded: "MIT" }],
      files: [{ SPDXID: "SPDXRef-Hello", fileName: "workspace/hello", checksums: [{ algorithm: "SHA256", checksumValue: hash("owned fixture\n") }] }],
      relationships: [{ spdxElementId: packageId, relationshipType: "CONTAINS", relatedSpdxElement: "SPDXRef-Hello" }] }));
    await writeFile(join(root, "notices.json"), JSON.stringify({ schemaVersion: 1, notices: [{ packageId, license: "MIT", text: notice }] }));
    await writeFile(join(root, "source.txt"), "Owned fixture corresponding source: owned fixture\n");
    await writeFile(join(root, "BUILD.md"), "Create workspace/hello with the exact UTF-8 bytes owned fixture followed by a newline.\n");
    await writeFile(join(root, "sources.json"), JSON.stringify({ schemaVersion: 1, packages: [{ packageId, kind: "source", archive: { path: "source.txt", sha256: hash("Owned fixture corresponding source: owned fixture\n") }, buildInstructionsFile: "BUILD.md" }] }));
    await writeFile(join(root, "review.json"), JSON.stringify({ schemaVersion: 1, approved: true, reviewer: "owned-fixture-author", packages: [{ packageId, license: "MIT", noticeSHA256: hash(notice), obligations: "source" }] }));
    const recipe = { id: "owned", version: "1", mode: "userspace" as const, sourceDateEpoch: 1,
      source: { kind: "directory" as const, path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 as const },
      evidence: { sbom: { kind: "file" as const, path: "sbom.json" }, noticesFile: "notices.json", correspondingSourcesFile: "sources.json", licensePolicyFile: "review.json" } };
    const progress: number[] = [];
    const built = await buildImage(recipe, { recipeDir: root, signingKeyFile: key.privateKeyPath, purpose: "distribution", onProgress: value => { if (value.phase === "reproduce") progress.push(value.run); } });
    expect(built.distribution).toEqual({ kind: "candidate", browserTestsRequired: true });
    expect(progress).toEqual([1, 2]);
    const verified = await inspectImageFiles(built.bundleDir, { trust: key.trust });
    expect((await validateDistributionBundle(verified.read)).inventorySHA256).toMatch(/^[a-f0-9]{64}$/u);
    const distribution = await validateImageDistribution(built.bundleDir, { trust: key.trust });
    expect(distribution.inspection.manifestSHA256).toBe(built.image.manifestSHA256);
    expect(distribution.evidence.inventorySHA256).toMatch(/^[a-f0-9]{64}$/u);
    expect(distribution.files.some(file => file.relative === "manifest.json")).toBe(true);
    for (const name of await readdir(join(built.bundleDir, "evidence"))) expect(distribution.files.some(file => file.relative === `evidence/${name}`)).toBe(true);
    for (const name of await readdir(join(built.bundleDir, "packs"))) expect(distribution.files.some(file => file.relative === `packs/${name}`)).toBe(true);
    const other = await generateImageKey(join(root, "other-author.pem"));
    await expect(validateImageDistribution(built.bundleDir, { trust: other.trust })).rejects.toThrow();
    const developmentRoot = join(root, "development"); await mkdir(developmentRoot);
    const development = await buildImage({ id: "development", version: "1", mode: "userspace", sourceDateEpoch: 1,
      source: { kind: "directory", path: join(root, "root") }, smokeTest: recipe.smokeTest }, { recipeDir: developmentRoot, signingKeyFile: key.privateKeyPath });
    await expect(validateImageDistribution(development.bundleDir, { trust: key.trust })).rejects.toThrow(/distribution/u);
    const source = verified.files.find(file => file.sha256 === hash("Owned fixture corresponding source: owned fixture\n"));
    expect(source).toBeDefined();
    const serialized = await readFile(built.manifestPath, "utf8");
    expect(serialized).not.toContain(root);
    const rebuilt = await buildImage(recipe, { recipeDir: root, signingKeyFile: key.privateKeyPath, purpose: "distribution" });
    expect(rebuilt.image.manifestSHA256).toBe(built.image.manifestSHA256);
    if (source === undefined) throw new Error("verified corresponding source was omitted");
    await writeFile(join(built.bundleDir, source.relative), "changed source");
    await expect(inspectImageFiles(built.bundleDir, { trust: key.trust })).rejects.toThrow(/integrity/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
