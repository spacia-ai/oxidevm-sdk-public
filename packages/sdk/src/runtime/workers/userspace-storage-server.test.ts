import { expect, it } from "vitest";
import { decodeUserspaceStorageIncoming, UserspaceStorageClient } from "./userspace-storage-channel.js";
import { serveUserspaceStorage } from "./userspace-storage-server.js";
import { WorkspaceStore, type WorkspaceStoreBackend } from "./workspace-store.js";

it.each(["blobs/", "active.json"])("returns the actual cancellation outcome at %s and drains before close", async pauseAt => {
  const entered = Promise.withResolvers<undefined>();
  const retire = Promise.withResolvers<undefined>();
  const cancelled = Promise.withResolvers<undefined>();
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const backend: WorkspaceStoreBackend = {
    list: async function* (prefix) { for (const path of files.keys()) if (path.startsWith(prefix)) yield await Promise.resolve(path); },
    read: path => Promise.resolve(files.get(path)?.slice()),
    write: async (path, bytes) => {
      files.set(path, bytes.slice());
      if (path.startsWith(pauseAt)) { entered.resolve(undefined); await retire.promise; }
    },
    remove: path => { files.delete(path); return Promise.resolve(); },
  };
  const store = new WorkspaceStore(backend);
  const channel = new MessageChannel();
  const server = serveUserspaceStorage(channel.port2, (request, signal) => {
    if (request.type !== "commit-workspace-snapshot") throw new Error("unexpected request");
    signal.addEventListener("abort", () => cancelled.resolve(undefined), { once: true });
    return store.commit(request.workspaceBaseSha256, request.data, undefined, signal);
  });
  const client = new UserspaceStorageClient(channel.port1);
  try {
    const controller = new AbortController();
    const pending = client.commitWorkspaceSnapshot("b".repeat(64), new Uint8Array([42]), controller.signal);
    const outcome = pauseAt === "blobs/" ? expect(pending).rejects.toMatchObject({ code: "ABORTED" }) : expect(pending).resolves.toBe(1);
    await entered.promise;
    controller.abort();
    await cancelled.promise;
    let closed = false;
    const closing = server.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    retire.resolve(undefined);
    await outcome;
    await closing;
    expect(files.has("active.json")).toBe(pauseAt === "active.json");
    expect(files.has("intent.json")).toBe(false);
  } finally { retire.resolve(undefined); client.close(); await server.close(); }
});

it("cancels queued requests without invoking the storage producer", async () => {
  const entered = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  const observed: string[] = [];
  const channel = new MessageChannel();
  const server = serveUserspaceStorage(channel.port2, async request => {
    observed.push(request.type);
    entered.resolve(undefined);
    await proceed.promise;
    return { sha256: "b".repeat(64), bytes: new Uint8Array([42]) };
  });
  const receivedCancel = Promise.withResolvers<undefined>();
  channel.port2.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (decodeUserspaceStorageIncoming(event.data).type === "cancel") receivedCancel.resolve(undefined);
  });
  const client = new UserspaceStorageClient(channel.port1);
  try {
    const first = client.readRootfs("/first");
    await entered.promise;
    const controller = new AbortController();
    const second = client.readRootfs("/second", controller.signal);
    const cancelled = expect(second).rejects.toMatchObject({ code: "ABORTED" });
    controller.abort();
    await receivedCancel.promise;
    // Closing aborts all queued requests and drains the running producer.
    const closing = server.close();
    const firstCancelled = expect(first).rejects.toMatchObject({ code: "ABORTED" });
    proceed.resolve(undefined);
    await Promise.all([cancelled, firstCancelled, closing]);
    expect(observed).toEqual(["read-rootfs"]);
  } finally { proceed.resolve(undefined); client.close(); await server.close(); }
});
