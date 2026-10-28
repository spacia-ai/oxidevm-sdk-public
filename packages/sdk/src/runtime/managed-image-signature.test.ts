import { expect, it } from "vitest";
import { canonicalManagedImageBytes, decodeManagedImageManifest, verifyManagedImageManifest } from "./managed-image.js";

it("authenticates an arbitrary Python-only System image including its command line and evidence", async () => {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
  const artifact = { url: "./a", bytes: 4096, sha256: "a".repeat(64) };
  const input = { schemaVersion: 9, id: "python", version: "1", architecture: "x86_64", sourceDateEpoch: 0, memoryMiB: 256, vcpus: { minimum: 1, maximum: 1 }, cpuProfile: "x86-64-v3", workspaceBaseSha256: "b".repeat(64), commandLine: "console=hvc0", kernel: artifact,
    disk: { bytes: 4096, blockBytes: 4096, chunkBytes: 4096, chunks: [{ ...artifact, index: 0, encoding: "gzip", encodedBytes: 128, encodedSha256: "c".repeat(64) }] },
    runtimes: { kind: "custom", versions: { python: "3.13" } },
    provenance: { keyId: "test", signature: "A".repeat(86), sbom: artifact, notices: artifact, correspondingSources: artifact, reproducibility: artifact } };
  const url = new URL("https://image.test/manifest.json");
  const unsigned = decodeManagedImageManifest(input, url);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, canonicalManagedImageBytes(unsigned)));
  const encoded = btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const signed = decodeManagedImageManifest({ ...input, provenance: { ...input.provenance, signature: encoded } }, url);
  await expect(verifyManagedImageManifest(signed, { keyId: "test", publicKey })).resolves.toBeUndefined();
  const rehosted = decodeManagedImageManifest({ ...input, provenance: { ...input.provenance, signature: encoded } }, new URL("https://another.test/nested/images/manifest.json"));
  await expect(verifyManagedImageManifest(rehosted, { keyId: "test", publicKey })).resolves.toBeUndefined();
  const expanded = decodeManagedImageManifest({ ...input, vcpus: { minimum: 1, maximum: 4 }, provenance: { ...input.provenance, signature: encoded } }, url);
  await expect(verifyManagedImageManifest(expanded, { keyId: "test", publicKey })).rejects.toThrow();
  const absolute = decodeManagedImageManifest({ ...input, kernel: { ...artifact, url: "https://image.test/a" }, provenance: { ...input.provenance, signature: encoded } }, url);
  await expect(verifyManagedImageManifest(absolute, { keyId: "test", publicKey })).rejects.toThrow();
  await expect(verifyManagedImageManifest({ ...signed, commandLine: "malicious" }, { keyId: "test", publicKey })).rejects.toThrow();
  await expect(verifyManagedImageManifest(signed, { keyId: "wrong", publicKey })).rejects.toThrow();
  expect(() => decodeManagedImageManifest({ ...input, schemaVersion: 8 }, url)).toThrow();
});
