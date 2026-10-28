import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEvidence } from "./evidence.js";
import { hash } from "./files.js";

it("binds reviewed SPDX file coverage, notices and retrievable sources to the final inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-evidence-"));
  try {
    const text = "MIT License\nCopyright OxideVM test fixture authors\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.";
    const packageId = "SPDXRef-Package-hello";
    const sbom = { spdxVersion: "SPDX-2.3", SPDXID: "SPDXRef-DOCUMENT", dataLicense: "CC0-1.0",
      packages: [{ SPDXID: packageId, name: "hello", versionInfo: "1", licenseConcluded: "MIT" }],
      files: [{ SPDXID: "SPDXRef-File-hello", fileName: "bin/hello", checksums: [{ algorithm: "SHA256", checksumValue: hash("hello") }] }],
      relationships: [{ spdxElementId: packageId, relationshipType: "CONTAINS", relatedSpdxElement: "SPDXRef-File-hello" }] };
    const notices = { schemaVersion: 1, notices: [{ packageId, license: "MIT", text }] };
    const sources = { schemaVersion: 1, packages: [{ packageId, kind: "notice-only" }] };
    const policy = { schemaVersion: 1, reviewer: "fixture-author", approved: true, packages: [{ packageId, license: "MIT", noticeSHA256: hash(text), obligations: "notice" }] };
    await writeFile(join(root, "sbom.json"), JSON.stringify(sbom)); await writeFile(join(root, "notices.json"), JSON.stringify(notices));
    await writeFile(join(root, "sources.json"), JSON.stringify(sources)); await writeFile(join(root, "policy.json"), JSON.stringify(policy));
    const inputs = { sbom: { kind: "file" as const, path: "sbom.json" }, noticesFile: "notices.json", correspondingSourcesFile: "sources.json", licensePolicyFile: "policy.json" };
    const inventory = [{ path: "bin/hello", bytes: 5, sha256: hash("hello") }];
    expect((await validateEvidence(root, inputs, inventory)).sourceArchives).toHaveLength(0);
    const technical = { schemaVersion: 2, purpose: "technical-inventory", validator: "fixture inventory check", policySHA256: "a".repeat(64), packages: policy.packages };
    await writeFile(join(root, "policy.json"), JSON.stringify(technical));
    expect((await validateEvidence(root, inputs, inventory)).sourceArchives).toHaveLength(0);
    await writeFile(join(root, "policy.json"), JSON.stringify({ ...technical, purpose: "legal-approval" }));
    await expect(validateEvidence(root, inputs, inventory)).rejects.toThrow(/technical/u);
    await writeFile(join(root, "policy.json"), JSON.stringify(policy));
    await writeFile(join(root, "sbom.json"), JSON.stringify({ ...sbom, packages: [{ ...sbom.packages[0], name: "bun" }] }));
    await expect(validateEvidence(root, inputs, inventory)).rejects.toThrow(/nested/u);
    await writeFile(join(root, "sbom.json"), JSON.stringify(sbom));
    await expect(validateEvidence(root, inputs, [{ ...inventory[0], path: "bin/extra", bytes: 5, sha256: hash("hello") }])).rejects.toThrow(/coverage/u);
    await writeFile(join(root, "policy.json"), JSON.stringify({ ...policy, approved: false }));
    await expect(validateEvidence(root, inputs, inventory)).rejects.toThrow(/approved/u);
    await writeFile(join(root, "policy.json"), JSON.stringify(policy));
    await writeFile(join(root, "sbom.json"), JSON.stringify({ ...sbom, packages: [{ ...sbom.packages[0], licenseConcluded: "GPL-2.0-only" }] }));
    await writeFile(join(root, "policy.json"), JSON.stringify({ ...policy, packages: [{ ...policy.packages[0], license: "GPL-2.0-only", obligations: "notice" }] }));
    await expect(validateEvidence(root, inputs, inventory)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("requires source and build materials for copyleft packages and verifies every supplied archive pin", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-source-evidence-"));
  try {
    const packageId = "SPDXRef-Package-gpl"; const text = "GNU GENERAL PUBLIC LICENSE version 2, fixture copyright and full source duties.";
    const sbom = { spdxVersion: "SPDX-2.3", SPDXID: "SPDXRef-DOCUMENT", dataLicense: "CC0-1.0",
      packages: [{ SPDXID: packageId, name: "fixture", versionInfo: "1", licenseConcluded: "GPL-2.0-only" }],
      files: [{ SPDXID: "SPDXRef-File-binary", fileName: "bin/fixture", checksums: [{ algorithm: "SHA256", checksumValue: hash("binary") }] }],
      relationships: [{ spdxElementId: packageId, relationshipType: "CONTAINS", relatedSpdxElement: "SPDXRef-File-binary" }] };
    await writeFile(join(root, "sbom.json"), JSON.stringify(sbom));
    await writeFile(join(root, "notices.json"), JSON.stringify({ schemaVersion: 1, notices: [{ packageId, license: "GPL-2.0-only", text }] }));
    await writeFile(join(root, "policy.json"), JSON.stringify({ schemaVersion: 1, reviewer: "fixture-author", approved: true, packages: [{ packageId, license: "GPL-2.0-only", noticeSHA256: hash(text), obligations: "source" }] }));
    await writeFile(join(root, "source.tar"), "source-archive"); await writeFile(join(root, "BUILD.md"), "Actual complete build instructions for the fixture.\n");
    const archive = { path: "source.tar", sha256: hash("source-archive") };
    const sources = { schemaVersion: 1, packages: [{ packageId, kind: "source", archive, buildInstructionsFile: "BUILD.md" }] };
    await writeFile(join(root, "sources.json"), JSON.stringify(sources));
    const inputs = { sbom: { kind: "file" as const, path: "sbom.json" }, noticesFile: "notices.json", correspondingSourcesFile: "sources.json", licensePolicyFile: "policy.json" };
    const inventory = [{ path: "bin/fixture", bytes: 6, sha256: hash("binary") }];
    expect((await validateEvidence(root, inputs, inventory)).sourceArchives).toHaveLength(2);
    await writeFile(join(root, "source.tar"), "tampered");
    await expect(validateEvidence(root, inputs, inventory)).rejects.toThrow(/source/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
