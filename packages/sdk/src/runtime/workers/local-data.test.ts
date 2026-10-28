import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLocalDataLock, eraseOpfsLocalData } from "./local-data.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";

describe("origin-wide local data erasure", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses erasure while any workspace owns storage, then allows retry", async () => {
    const first = await acquireLocalDataLock("shared");
    const second = await acquireLocalDataLock("shared");
    try {
      await expect(acquireLocalDataLock("exclusive")).rejects.toMatchObject({
        code: "STORAGE_ERROR", detail: { reason: "local-data-in-use" },
      });
    } finally { await first(); await second(); }
    const erase = await acquireLocalDataLock("exclusive");
    try {
      await expect(acquireLocalDataLock("shared")).rejects.toMatchObject({
        code: "STORAGE_ERROR", detail: { reason: "local-data-in-use" },
      });
    } finally { await erase(); }
    const retry = await acquireLocalDataLock("shared");
    await retry();
  });

  it("removes every owned OPFS store, preserves other applications, and is repeatable", async () => {
    const root = new MemoryDirectory();
    const owned = root.directory("oxidevm", true);
    for (const name of ["workspaces", "workspace-overlays", "managed-images", "userspace-rootfs"]) {
      owned.directory(name, true).file("data", true);
    }
    root.directory("another-app", true).file("keep", true);
    const storage = { getDirectory: () => Promise.resolve(root) };
    await eraseOpfsLocalData(storage);
    await eraseOpfsLocalData(storage);
    expect(root.names()).toEqual(["another-app"]);
    const fresh = root.directory("oxidevm", true).file("fresh", true);
    const writer = await fresh.createWritable();
    await writer.write(new Uint8Array([42]));
    await writer.close();
    expect((await fresh.getFile()).size).toBe(1);
  });

  it("identifies a blocked OPFS deletion and does not report success", async () => {
    const root = new MemoryDirectory();
    const handle = await root.directory("oxidevm", true).file("disk", true).createSyncAccessHandle();
    try {
      await expect(eraseOpfsLocalData({ getDirectory: () => Promise.resolve(root) })).rejects.toMatchObject({
        code: "STORAGE_ERROR", detail: { operation: "erase-local-data", resource: "OPFS /oxidevm", cause: "NoModificationAllowedError" },
      });
    } finally { handle.close(); }
    await eraseOpfsLocalData({ getDirectory: () => Promise.resolve(root) });
    expect(root.names()).toEqual([]);
  });
});
