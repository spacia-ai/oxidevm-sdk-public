import { afterEach, expect, it, vi } from "vitest";
import { RootfsStore } from "./rootfs-store.js";
import { RootfsNetworkClient, serveRootfsNetwork } from "./rootfs-network-channel.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { signedCheckpointRootfsFixture, ROOTFS_CHECKPOINT_URL } from "./rootfs-checkpoint.test-support.js";
import { sha256Hex } from "./snapshot-content.js";

const ports: MessagePort[] = [];
afterEach(() => { for (const port of ports.splice(0)) port.close(); vi.unstubAllGlobals(); });
function store(): RootfsStore {
  const channel = new MessageChannel(); ports.push(channel.port1, channel.port2);
  serveRootfsNetwork(channel.port2);
  return RootfsStore.opfs(new MemoryDirectory(), new RootfsNetworkClient(channel.port1));
}

it.each([3, 6] as const)("offers an uncached signed image without replacing retained schema %s, including after explicit restore", async schema => {
  const old = await signedCheckpointRootfsFixture("old", schema);
  const roots = store(), owner = { workspaceId: "update", snapshotId: "123e4567-e89b-42d3-a456-426614174101" };
  const first = await roots.prepare(ROOTFS_CHECKPOINT_URL, old.trusted);
  const checkpoint = await roots.captureCheckpoint(owner);
  const newer = await signedCheckpointRootfsFixture("new", schema, new Uint8Array([7, 8]), "bin", old.keys);
  await roots.inspectRequestedImage(ROOTFS_CHECKPOINT_URL, old.trusted);
  expect(roots.currentRootfs().rootTreeSha256).toBe(first.rootTreeSha256);
  const retained = await roots.prepare(ROOTFS_CHECKPOINT_URL, old.trusted, await sha256Hex(old.bytes), true);
  expect(retained).toMatchObject({ version: "old", update: { id: "test-rootfs", version: "new" } });
  expect((await roots.read("bin/app")).bytes).toEqual(new Uint8Array([1, 2, 3]));
  expect(newer.fetcher.mock.calls.every(([url]) => url === ROOTFS_CHECKPOINT_URL)).toBe(true);
  expect(await roots.prepare(ROOTFS_CHECKPOINT_URL, old.trusted)).toMatchObject({ version: "new" });
  expect(roots.currentRootfs().update).toBeUndefined();
  expect(await roots.prepareCheckpoint(owner, checkpoint.rootfs, checkpoint.manifest,
    { manifestUrl: ROOTFS_CHECKPOINT_URL, trusted: old.trusted })).toMatchObject({ version: "old", update: { id: "test-rootfs", version: "new" } });
  expect(await roots.activateCheckpoint(owner, old.trusted)).toMatchObject({ version: "old", update: { id: "test-rootfs", version: "new" } });
});

it("keeps a retained native image usable offline or when the offered image is untrusted", async () => {
  const old = await signedCheckpointRootfsFixture("old", 6), roots = store();
  await roots.prepare(ROOTFS_CHECKPOINT_URL, old.trusted);
  old.fetcher.mockRejectedValue(new TypeError("offline"));
  await roots.inspectRequestedImage(ROOTFS_CHECKPOINT_URL, old.trusted);
  expect(await roots.prepare(ROOTFS_CHECKPOINT_URL, old.trusted, await sha256Hex(old.bytes), true)).toMatchObject({ version: "old" });
  expect(roots.currentRootfs().update).toBeUndefined();
  await signedCheckpointRootfsFixture("untrusted", 6);
  await roots.inspectRequestedImage(ROOTFS_CHECKPOINT_URL, old.trusted);
  expect(roots.currentRootfs().version).toBe("old");
  expect(roots.currentRootfs().update).toBeUndefined();
});

it("inspects a startup update offer from cache without waiting for the network", async () => {
  const old = await signedCheckpointRootfsFixture("old", 6), roots = store();
  await roots.prepare(ROOTFS_CHECKPOINT_URL, old.trusted);
  old.fetcher.mockClear();
  await roots.inspectRequestedImage(ROOTFS_CHECKPOINT_URL, old.trusted, undefined, undefined, true);
  expect(old.fetcher).not.toHaveBeenCalled();
});
