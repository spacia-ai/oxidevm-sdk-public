import { expect, it } from "vitest";
import { normalizeBuildkitSBOM } from "./buildkit-sbom.js";
import { hash } from "./files.js";

const packageId = "SPDXRef-Owned";
const inventory = [{ path: "bin/hello", bytes: 5, sha256: hash("hello") }];
const scan = { spdxVersion: "SPDX-2.3", SPDXID: "SPDXRef-DOCUMENT", dataLicense: "CC0-1.0",
  packages: [{ SPDXID: "SPDXRef-DocumentRoot-Directory-sbom", name: "sbom", licenseConcluded: "NOASSERTION" }], files: [], relationships: [], creationInfo: { creators: ["Tool: syft-v1.51.0"] } };
const policy = { schemaVersion: 1, approved: true, reviewer: "owned-fixture-author", packages: [{ packageId, license: "MIT", noticeSHA256: hash("notice"), obligations: "notice" }],
  additionalPackages: [{ SPDXID: packageId, name: "authored-hello", versionInfo: "1", licenseConcluded: "MIT" }],
  fileOwnership: [{ path: "bin/hello", sha256: hash("hello"), packageId }] };
it("supplements a real scanner inventory only from explicit approved ownership of the exact final bytes", () => {
  const bytes = normalizeBuildkitSBOM(new TextEncoder().encode(JSON.stringify(scan)), new TextEncoder().encode(JSON.stringify(policy)), inventory, 1);
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  expect(value).toMatchObject({ packages: policy.additionalPackages, files: [{ fileName: "bin/hello", checksums: [{ algorithm: "SHA256", checksumValue: hash("hello") }] }], creationInfo: { created: "1970-01-01T00:00:01.000Z" } });
});
it.each([
  { ...policy, approved: false }, { ...policy, fileOwnership: [] },
  { ...policy, fileOwnership: [{ path: "bin/hello", sha256: hash("other"), packageId }] },
])("rejects absent, unapproved or mismatching final file ownership", review => {
  expect(() => normalizeBuildkitSBOM(new TextEncoder().encode(JSON.stringify(scan)), new TextEncoder().encode(JSON.stringify(review)), inventory, 1)).toThrow();
});
it("refuses an unreviewed package rather than copying licenseDeclared into licenseConcluded", () => {
  const input = { ...scan, packages: [{ SPDXID: "SPDXRef-Unreviewed", name: "foreign", versionInfo: "1", licenseDeclared: "MIT", licenseConcluded: "NOASSERTION" }] };
  expect(() => normalizeBuildkitSBOM(new TextEncoder().encode(JSON.stringify(input)), new TextEncoder().encode(JSON.stringify(policy)), inventory, 1)).toThrow(/review/u);
});
it("accepts a scanner document without optional files only with reviewed final coverage", () => {
  const withoutFiles = Object.fromEntries(Object.entries(scan).filter(([key]) => key !== "files" && key !== "relationships"));
  const bytes = normalizeBuildkitSBOM(new TextEncoder().encode(JSON.stringify(withoutFiles)), new TextEncoder().encode(JSON.stringify(policy)), inventory, 1);
  expect(JSON.parse(new TextDecoder().decode(bytes)) as unknown).toMatchObject({ files: [{ fileName: "bin/hello" }] });
  expect(() => normalizeBuildkitSBOM(new TextEncoder().encode(JSON.stringify({ ...withoutFiles, files: null })), new TextEncoder().encode(JSON.stringify(policy)), inventory, 1)).toThrow();
  expect(() => normalizeBuildkitSBOM(new TextEncoder().encode(JSON.stringify(withoutFiles)), new TextEncoder().encode(JSON.stringify({ ...policy, fileOwnership: [] })), inventory, 1)).toThrow(/coverage/u);
});
