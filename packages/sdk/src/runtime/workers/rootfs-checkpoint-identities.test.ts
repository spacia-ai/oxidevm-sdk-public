import { afterEach, expect, it, vi } from "vitest";
import { decodeUserspaceRootfsManifest } from "../userspace-rootfs.js";
import { RootfsCheckpoints } from "./rootfs-checkpoints.js";
import { RootfsStore } from "./rootfs-store.js";
import { RootfsNetworkClient, serveRootfsNetwork } from "./rootfs-network-channel.js";
import { MemoryDirectory, MemoryFile } from "./opfs-double.test-support.js";
import { sha256Hex } from "./snapshot-content.js";
import { ROOTFS_CHECKPOINT_URL, signedCheckpointRootfsFixture } from "./rootfs-checkpoint.test-support.js";

const ports: MessagePort[] = [];
const stores: RootfsStore[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const source of stores.splice(0)) source.close();
  for (const port of ports.splice(0)) port.close();
});
function owner(index: number) {
  return { workspaceId: "identities", snapshotId: `11111111-2222-4333-8444-${String(index).padStart(12, "0")}` };
}
function store(root: MemoryDirectory): RootfsStore {
  const channel = new MessageChannel(); ports.push(channel.port1, channel.port2);
  serveRootfsNetwork(channel.port2);
  const source = RootfsStore.opfs(root, new RootfsNetworkClient(channel.port1)); stores.push(source); return source;
}
function file(root: MemoryDirectory, path: string): MemoryFile {
  const entry = root.find(path); if (!(entry instanceof MemoryFile)) throw new Error(`Missing fixture file: ${path}`); return entry;
}
async function pinFile(root: MemoryDirectory, index: number): Promise<MemoryFile> {
  const current = owner(index);
  const name = await sha256Hex(new TextEncoder().encode(JSON.stringify([current.workspaceId, current.snapshotId])));
  return file(root, `userspace-rootfs/pins/${name}.json`);
}
async function captured(root: MemoryDirectory, source: RootfsStore, index: number, version = "first") {
  const fixture = await signedCheckpointRootfsFixture(version, 6);
  await source.prepare(ROOTFS_CHECKPOINT_URL, fixture.trusted);
  const saved = await source.captureCheckpoint(owner(index));
  return { fixture, saved, blob: file(root, `userspace-rootfs/blobs/${fixture.blobHash}`) };
}

it("checks each exact signed manifest closure once even when different manifests share a root identity", async () => {
  const root = new MemoryDirectory(), source = store(root), first = await captured(root, source, 1);
  await source.captureCheckpoint(owner(2)); await source.captureCheckpoint(owner(3));
  const second = await captured(root, source, 4, "second"); await source.captureCheckpoint(owner(5));
  expect(first.saved.rootfs.rootTreeSha256).toBe(second.saved.rootfs.rootTreeSha256);
  expect(first.saved.rootfs.manifest.sha256).not.toBe(second.saved.rootfs.manifest.sha256);
  const bodyReads = vi.spyOn(first.blob, "getFile");
  expect(await source.cachedCheckpointIdentities()).toEqual(new Set([first.saved.rootfs.rootTreeSha256]));
  expect(bodyReads).toHaveBeenCalledTimes(2);
});

it("reuses a failed closure only inside one invocation and checks fresh corruption and repair", async () => {
  const root = new MemoryDirectory(), source = store(root), result = await captured(root, source, 1);
  await source.captureCheckpoint(owner(2)); await source.captureCheckpoint(owner(3));
  const reads = vi.spyOn(result.blob, "getFile");
  expect(await source.cachedCheckpointIdentities()).toContain(result.saved.rootfs.rootTreeSha256);
  expect(reads).toHaveBeenCalledOnce(); reads.mockClear();
  result.blob.setBytes(new Uint8Array([9, 9, 9]));
  expect(await source.cachedCheckpointIdentities()).toEqual(new Set());
  expect(reads).toHaveBeenCalledOnce(); reads.mockClear();
  result.blob.setBytes(new Uint8Array([1, 2, 3]));
  expect(await source.cachedCheckpointIdentities()).toContain(result.saved.rootfs.rootTreeSha256);
  expect(reads).toHaveBeenCalledOnce();
});

it("validates every pin owner before borrowing an exact manifest result", async () => {
  const root = new MemoryDirectory(), source = store(root), result = await captured(root, source, 1);
  await source.captureCheckpoint(owner(2)); await source.captureCheckpoint(owner(3));
  const wrongOwner = await pinFile(root, 2);
  wrongOwner.setBytes(new TextEncoder().encode(JSON.stringify({ version: 1, owner: owner(99),
    sha256: result.saved.rootfs.manifest.sha256, bytes: result.saved.manifest.length, manifestUrl: ROOTFS_CHECKPOINT_URL })));
  const manifestReads = vi.spyOn(file(root, `userspace-rootfs/manifests/${result.saved.rootfs.manifest.sha256}.json`), "getFile");
  expect(await source.cachedCheckpointIdentities()).toContain(result.saved.rootfs.rootTreeSha256);
  expect(manifestReads).toHaveBeenCalledOnce();
  await source.releaseCheckpoint(owner(1)); await source.releaseCheckpoint(owner(3)); manifestReads.mockClear();
  expect(await source.cachedCheckpointIdentities()).toEqual(new Set());
  expect(manifestReads).not.toHaveBeenCalled();
});

it("does not rescan bodies for the already available running root, but verifies them on a full inspection", async () => {
  const root = new MemoryDirectory(), source = store(root), result = await captured(root, source, 1);
  const reads = vi.spyOn(result.blob, "getFile");
  expect(await source.cachedCheckpointIdentities(result.saved.rootfs.rootTreeSha256)).toContain(result.saved.rootfs.rootTreeSha256);
  expect(reads).not.toHaveBeenCalled();
  result.blob.setBytes(new Uint8Array([9, 9, 9]));
  expect(await source.cachedCheckpointIdentities()).toEqual(new Set());
  expect(reads).toHaveBeenCalledOnce();
});

it("verifies repeated evidence bodies once while preserving logical capture progress", async () => {
  const root = new MemoryDirectory(), source = store(root), result = await captured(root, source, 1);
  const evidenceHash = await sha256Hex(new Uint8Array([4]));
  const evidenceReads = vi.spyOn(file(root, `userspace-rootfs/blobs/${evidenceHash}`), "getFile");
  const progress = vi.fn<(completedObjects: number) => void>();
  await source.captureCheckpoint(owner(2), progress);
  expect(evidenceReads).toHaveBeenCalledOnce();
  expect(progress.mock.calls.map(([completed]) => completed)).toEqual([1, 2, 3, 4, 5]);
  evidenceReads.mockClear();
  await source.inspectCheckpoint(owner(1), result.fixture.trusted);
  expect(evidenceReads).toHaveBeenCalledOnce();
});


it("does not reuse a verified digest for a conflicting evidence length", async () => {
  const root = new MemoryDirectory(), source = store(root), result = await captured(root, source, 1);
  const manifest = decodeUserspaceRootfsManifest(JSON.parse(new TextDecoder().decode(result.fixture.bytes)) as unknown, new globalThis.URL(ROOTFS_CHECKPOINT_URL));
  const channel = new MessageChannel(); ports.push(channel.port1, channel.port2); serveRootfsNetwork(channel.port2);
  const network = new RootfsNetworkClient(channel.port1);
  const checkpoints = new RootfsCheckpoints({ kind: "opfs", root }, network);
  try {
    // Malformed owner input must not borrow the preceding one-byte SBOM admission.
    await expect(checkpoints.capture(owner(2), { bytes: result.fixture.bytes, digest:await sha256Hex(result.fixture.bytes), url: new globalThis.URL(ROOTFS_CHECKPOINT_URL),
      manifest: { ...manifest, provenance: { ...manifest.provenance, notices: { ...manifest.provenance.notices, bytes: 2 } } } })).rejects.toThrow();
    await expect(pinFile(root, 2)).rejects.toThrow("Missing fixture file");
  } finally { network.close(); }
});
