import { expect, it, vi } from "vitest";
import { defineImage } from "./image.js";
import { canonicalUserspaceRootfsBytes, decodeUserspaceRootfsManifest, userspaceTreeIdentity } from "./runtime/userspace-rootfs.js";
import { fetchPinnedBytes } from "./engine-assets.js";
import { verifyImage } from "./verified-image.js";

vi.mock("./engine-assets.js", () => ({ fetchPinnedBytes: vi.fn() }));

const manifestUrl = "https://images.example/rootfs/manifest.json";
const hash = "a".repeat(64);

function rootfs(schemaVersion: number) {
  const ownership = { uid: 0, gid: 0 };
  return {
    schemaVersion, kind: "linux-user-rootfs", id: "legacy", version: "1", architecture: "x86_64", cpuProfile: "x86-64-v2",
    sourceDateEpoch: 1_786_060_800, rootTreeSha256: hash, workspaceBaseSha256: hash, fileCount: 2, totalBytes: 4,
    blobs: [{ sha256: hash, bytes: 4, url: "./blobs/aa" }],
    entries: [
      { type: "directory", path: "bin", mode: 0o755, ownership },
      { type: "file", path: "bin/sh", mode: 0o755, blob: hash, ownership },
    ],
    runtimes: { supportingFiles: [] },
    provenance: {
      keyId: "author", signature: "A".repeat(86), // canonical bytes blank it
      sbom: { url: "./evidence/sbom", bytes: 1, sha256: "b".repeat(64) },
      notices: { url: "./evidence/notices", bytes: 1, sha256: "c".repeat(64) },
      correspondingSources: { url: "./evidence/sources", bytes: 1, sha256: "d".repeat(64) },
      reproducibility: { url: "./evidence/reproducibility", bytes: 1, sha256: "e".repeat(64) },
    },
  };
}

async function signed(schemaVersion: number) {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const draft = rootfs(schemaVersion), decoded = decodeUserspaceRootfsManifest(draft, new URL(manifestUrl));
  const unsigned = { ...draft, ...await userspaceTreeIdentity(decoded.entries, decoded.blobs, schemaVersion) };
  const message = canonicalUserspaceRootfsBytes(decodeUserspaceRootfsManifest(unsigned, new URL(manifestUrl)));
  const signature = Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, message)).toString("base64url");
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64");
  const bytes = new TextEncoder().encode(JSON.stringify({ ...unsigned, provenance: { ...unsigned.provenance, signature } }));
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
  vi.mocked(fetchPinnedBytes).mockResolvedValue(bytes);
  return defineImage({ mode: "userspace", manifestUrl, manifestSHA256: digest, trust: { algorithm: "Ed25519", keyId: "author", publicKey: spki } });
}

it("rejects a legacy Userspace image at first open instead of after it has been retained", async () => {
  // Schema 4 signs a canonical form without the manifest URL; retained starts refuse it as a public identity.
  const legacy = verifyImage(await signed(4), "https://app.example/");
  await expect(legacy).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await expect(legacy).rejects.toThrow(/whole manifest.*oxidevm image build/u);
});

it("admits a whole-manifest signed Userspace image", async () => {
  const verified = await verifyImage(await signed(5), "https://app.example/");
  expect(verified.info).toMatchObject({ id: "legacy", mode: "userspace", signatureVerified: true });
});
