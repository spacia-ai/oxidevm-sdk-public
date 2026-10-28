import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c } from "tar";
import { afterEach, expect, it } from "vitest";
import { hash } from "./files.js";
import { readOCIImageEvidence } from "./oci-attestations.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(subject = "selected", corrupt = false, nested = false) {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-oci-evidence-")); directories.push(root);
  await mkdir(join(root, "blobs/sha256"), { recursive: true });
  async function blob(value: unknown, mediaType: string) {
    const bytes = JSON.stringify(value); const digest = hash(bytes);
    await writeFile(join(root, "blobs/sha256", digest), bytes);
    return { mediaType, digest: `sha256:${digest}`, size: Buffer.byteLength(bytes) };
  }
  const config = await blob({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [] } }, "application/vnd.oci.image.config.v1+json");
  const image = await blob({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config, layers: [] }, "application/vnd.oci.image.manifest.v1+json");
  const statement = await blob({ _type: "https://in-toto.io/Statement/v0.1", subject: [{ name: "image", digest: { sha256: subject === "selected" ? image.digest.slice(7) : "a".repeat(64) } }], predicateType: "https://spdx.dev/Document", predicate: { spdxVersion: "SPDX-2.3", files: [] } }, "application/vnd.in-toto+json");
  if (corrupt) await writeFile(join(root, "blobs/sha256", statement.digest.slice(7)), "tampered");
  const attestation = await blob({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config, layers: [statement] }, "application/vnd.oci.image.manifest.v1+json");
  const index = { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ ...image, platform: { architecture: "amd64", os: "linux" } }, { ...attestation, platform: { architecture: "unknown", os: "unknown" }, annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": image.digest } }] };
  const named=await blob(index,index.mediaType);
  await writeFile(join(root, "index.json"), JSON.stringify(nested?{schemaVersion:2,mediaType:index.mediaType,manifests:[named]}:index));
  await writeFile(join(root, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
  const archive = join(root, "image.tar"); await c({ cwd: root, file: archive }, ["index.json", "oci-layout", "blobs"]);
  return { archive, config, image, named };
}

it("binds a final amd64 SPDX attestation to the verified image and config descriptors", async () => {
  const input = await fixture(); const result = await readOCIImageEvidence(input.archive);
  expect(result.configSHA256).toBe(input.config.digest.slice(7));
  expect(result.manifestSHA256).toBe(input.image.digest.slice(7));
  expect(JSON.parse(new TextDecoder().decode(result.sbom)) as unknown).toEqual({ spdxVersion: "SPDX-2.3", files: [] });
});
it("retains Docker's verified named index identity separately from the config and image manifest",async()=>{
  const input=await fixture("selected",false,true),result=await readOCIImageEvidence(input.archive);
  expect(result.indexSHA256).toBe(input.named.digest.slice(7));
  expect(result.configSHA256).toBe(input.config.digest.slice(7));
  expect(result.manifestSHA256).toBe(input.image.digest.slice(7));
});
it("rejects an SPDX statement for a different build stage", async () => {
  await expect(readOCIImageEvidence((await fixture("other")).archive)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
});
it("rejects tampered attestation bytes before interpreting their JSON", async () => {
  await expect(readOCIImageEvidence((await fixture("selected", true)).archive)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
});
