import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLocalDataLock, eraseLocalDataStorage, eraseOpfsLocalData } from "./local-data.js";
import { embedderStorage, ORIGIN_STORAGE, storageDirectoryName, storageName } from "../storage-scope.js";
import { workspaceLockName } from "../workspace-path.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";

describe("origin-wide local data erasure", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses erasure while any workspace owns storage, then allows retry", async () => {
    const first = await acquireLocalDataLock("shared", ORIGIN_STORAGE);
    const second = await acquireLocalDataLock("shared", ORIGIN_STORAGE);
    try {
      await expect(acquireLocalDataLock("exclusive", ORIGIN_STORAGE)).rejects.toMatchObject({
        code: "STORAGE_ERROR", detail: { reason: "local-data-in-use" },
      });
    } finally { await first(); await second(); }
    const erase = await acquireLocalDataLock("exclusive", ORIGIN_STORAGE);
    try {
      await expect(acquireLocalDataLock("shared", ORIGIN_STORAGE)).rejects.toMatchObject({
        code: "STORAGE_ERROR", detail: { reason: "local-data-in-use" },
      });
    } finally { await erase(); }
    const retry = await acquireLocalDataLock("shared", ORIGIN_STORAGE);
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
    await eraseOpfsLocalData(storage, ORIGIN_STORAGE);
    await eraseOpfsLocalData(storage, ORIGIN_STORAGE);
    expect(root.names()).toEqual(["another-app"]);
    const fresh = root.directory("oxidevm", true).file("fresh", true);
    const writer = await fresh.createWritable();
    await writer.write(new Uint8Array([42]));
    await writer.close();
    expect((await fresh.getFile()).size).toBe(1);
  });

  it("keeps each storage scope's lease to itself", async () => {
    const docs = await embedderStorage("https://docs.example.com");
    const app = await embedderStorage("https://app.example.com");
    const running = await acquireLocalDataLock("shared", app);
    try {
      // docs.example.com erases its data while app.example.com's VM runs.
      const erasing = await acquireLocalDataLock("exclusive", docs);
      await erasing();
      const origin = await acquireLocalDataLock("exclusive", ORIGIN_STORAGE);
      await origin();
      await expect(acquireLocalDataLock("exclusive", app)).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "local-data-in-use" } });
    } finally { await running(); }
  });

  it("removes only its own scope's OPFS store", async () => {
    const docs = await embedderStorage("https://docs.example.com");
    const app = await embedderStorage("https://app.example.com");
    const root = new MemoryDirectory();
    for (const scope of [ORIGIN_STORAGE, docs, app]) root.directory(storageDirectoryName(scope), true).directory("workspaces", true).file("data", true);
    const storage = { getDirectory: () => Promise.resolve(root) };
    await eraseOpfsLocalData(storage, docs);
    expect([...root.names()].sort()).toEqual([storageDirectoryName(ORIGIN_STORAGE), storageDirectoryName(app)].sort());
    await eraseOpfsLocalData(storage, ORIGIN_STORAGE);
    expect(root.names()).toEqual([storageDirectoryName(app)]);
  });

  it("deletes only its scope's databases and waits only for its scope's workspaces", async () => {
    const docs = await embedderStorage("https://docs.example.com");
    const app = await embedderStorage("https://app.example.com");
    const names = [storageName(ORIGIN_STORAGE, "workspace-a"), storageName(docs, "workspace-a"), storageName(docs, "userspace-rootfs"), storageName(app, "workspace-a"), "another-app"];
    const deleted: string[] = [];
    vi.stubGlobal("indexedDB", {
      databases: () => Promise.resolve(names.map(name => ({ name, version: 1 }))),
      deleteDatabase: (name: string) => {
        deleted.push(name);
        const request: { onsuccess: (() => void) | null; onerror: (() => void) | null; onblocked: (() => void) | null } = { onsuccess: null, onerror: null, onblocked: null };
        setTimeout(() => { request.onsuccess?.(); }, 0);
        return request;
      },
    });
    const root = new MemoryDirectory();
    root.directory(storageDirectoryName(docs), true).file("disk", true);
    root.directory(storageDirectoryName(app), true).file("disk", true);
    Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: () => Promise.resolve(root) } });
    // app.example.com's VM runs: its storage worker holds app's workspace lock.
    const held = Promise.withResolvers<undefined>();
    const granted = Promise.withResolvers<undefined>();
    const lock = navigator.locks.request(workspaceLockName(app, "a"), async () => { granted.resolve(undefined); await held.promise; });
    await granted.promise;
    try {
      await eraseLocalDataStorage(new AbortController().signal, docs);
      expect(deleted).toEqual([storageName(docs, "workspace-a"), storageName(docs, "userspace-rootfs")]);
      expect(root.names()).toEqual([storageDirectoryName(app)]);
      await expect(eraseLocalDataStorage(new AbortController().signal, app)).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "local-data-in-use" } });
      expect(deleted).toHaveLength(2);
    } finally {
      held.resolve(undefined);
      await lock;
      Reflect.deleteProperty(navigator, "storage");
      vi.unstubAllGlobals();
    }
  });

  it("identifies a blocked OPFS deletion and does not report success", async () => {
    const root = new MemoryDirectory();
    const handle = await root.directory("oxidevm", true).file("disk", true).createSyncAccessHandle();
    try {
      await expect(eraseOpfsLocalData({ getDirectory: () => Promise.resolve(root) }, ORIGIN_STORAGE)).rejects.toMatchObject({
        code: "STORAGE_ERROR", detail: { operation: "erase-local-data", resource: "OPFS /oxidevm", cause: "NoModificationAllowedError" },
      });
    } finally { handle.close(); }
    await eraseOpfsLocalData({ getDirectory: () => Promise.resolve(root) }, ORIGIN_STORAGE);
    expect(root.names()).toEqual([]);
  });
});
