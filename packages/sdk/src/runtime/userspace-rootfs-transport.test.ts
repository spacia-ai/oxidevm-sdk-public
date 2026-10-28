import { expect, it } from "vitest";
import { decodeRootfsTransport, rootfsTransportURL } from "./userspace-rootfs-transport.js";
import { decodeUserspaceRootfsManifest, rootfsClosure } from "./userspace-rootfs.js";
import { signedCheckpointRootfsFixture, ROOTFS_CHECKPOINT_URL } from "./workers/rootfs-checkpoint.test-support.js";
import { packRootfsContents } from "./userspace-rootfs-packing.js";

async function fixture() {
  const original = await signedCheckpointRootfsFixture("legacy", 6);
  const base = new URL(ROOTFS_CHECKPOINT_URL);
  const manifest = decodeUserspaceRootfsManifest(JSON.parse(new TextDecoder().decode(original.bytes)) as unknown, base);
  const index = await packRootfsContents(rootfsClosure(manifest), async function*(blob) {
    yield await Promise.resolve(blob.bytes === 3 ? Uint8Array.of(1, 2, 3) : Uint8Array.of(4));
  }, async () => {});
  const packs = { index, artifacts: index.chunks.map(chunk => ({ sha256: chunk.sha256, encoding: "gzip", url: `./packs/${chunk.sha256}`, encodedBytes: 32, encodedSha256: "b".repeat(64) })) };
  return { manifest, base, value: { version: 1, manifestSHA256: "a".repeat(64), packs } };
}

it("binds a complete transport to the original manifest and image directory", async () => {
  const f = await fixture();
  expect(rootfsTransportURL(f.base, "a".repeat(64)).href).toBe(`https://profiles.example/rootfs/transport/${"a".repeat(64)}/packs-v1.json`);
  expect(decodeRootfsTransport(f.value, f.manifest, "a".repeat(64), f.base).index.blobs).toHaveLength(2);
  expect(() => decodeRootfsTransport(f.value, f.manifest, "c".repeat(64), f.base)).toThrow(/manifest/u);
});

it("rejects extra fields, incomplete closure and artifact paths outside the image", async () => {
  const f = await fixture();
  expect(() => decodeRootfsTransport({ ...f.value, trusted: true }, f.manifest, "a".repeat(64), f.base)).toThrow();
  expect(() => decodeRootfsTransport({ ...f.value, packs: { ...f.value.packs, index: { ...f.value.packs.index, blobs: [] } } }, f.manifest, "a".repeat(64), f.base)).toThrow();
  for (const url of ["../packs/x", "https://other.test/rootfs/x", "./packs/x?secret=1", "./packs/x#fragment"]) {
    const packs = { ...f.value.packs, artifacts: f.value.packs.artifacts.map(artifact => ({ ...artifact, url })) };
    expect(() => decodeRootfsTransport({ ...f.value, packs }, f.manifest, "a".repeat(64), f.base)).toThrow();
  }
});

it("rejects decoded padding that is outside the signed blob closure", async () => {
  const f = await fixture();
  const index = { ...f.value.packs.index, chunks: f.value.packs.index.chunks.map(chunk => ({ ...chunk, bytes: chunk.bytes + 1 })) };
  expect(() => decodeRootfsTransport({ ...f.value, packs: { ...f.value.packs, index } }, f.manifest, "a".repeat(64), f.base)).toThrow(/coverage/u);
});
