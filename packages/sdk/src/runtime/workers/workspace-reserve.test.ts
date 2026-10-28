import { expect, it } from "vitest";
import { SpaceReserve } from "./managed-disk-reserve.js";
import { MemoryDirectory, MemoryQuota } from "./opfs-double.test-support.js";
import { opfsWorkspaceStoreBackend, reserveWorkspaceWrites } from "./workspace-backend.js";
import { SnapshotObjects } from "./snapshot-objects.js";

it("keeps the reserve for durable file writes, retries once, and refuses writes when exhausted", async () => {
  const quota = new MemoryQuota(2 * 1024 * 1024);
  const directory = new MemoryDirectory("workspace", undefined, quota);
  const reserve = await SpaceReserve.open(directory, 1024 * 1024);
  const backend = reserveWorkspaceWrites(opfsWorkspaceStoreBackend(directory), reserve);
  try {
    const snapshots = await SnapshotObjects.open(directory);
    quota.limit = quota.used + 64 * 1024;
    await expect(snapshots.put(new Uint8Array(128 * 1024).fill(3))).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(quota.used).toBe(1024 * 1024);
    const bytes = new Uint8Array(128 * 1024).fill(7);
    await backend.write("blobs/file", bytes);
    expect(await backend.read("blobs/file")).toEqual(bytes);
    expect(await reserve?.hold()).toBe(false);
    quota.limit = quota.used;
    await expect(backend.write("blobs/another", bytes)).rejects.toMatchObject({ name: "QuotaExceededError" });
    quota.limit = 4 * 1024 * 1024;
    expect(await reserve?.hold()).toBe(true);
  } finally { reserve?.close(); }
});
