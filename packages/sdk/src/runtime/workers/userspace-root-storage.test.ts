import { expect, it, vi } from "vitest";
import { UserspaceRootStorage } from "./userspace-root-storage.js";
import { openUserspaceRootStore } from "./userspace-root-store.js";
import { decodeUserspaceStorageIncoming, UserspaceStorageClient } from "./userspace-storage-channel.js";
import { serveUserspaceStorage } from "./userspace-storage-server.js";
import { opfsWorkspaceStoreBackend } from "./workspace-backend.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import { transferWorkspaceStream } from "./workspace-transfer.js";
import { workspaceBytesInput } from "./workspace-stream.js";

const root = "a".repeat(64);
const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };

it("returns a selected root read for confirmed retirement when cancellation races opening", async () => {
  const backend = opfsWorkspaceStoreBackend(new MemoryDirectory());
  const store = await openUserspaceRootStore(backend, root);
  await store.commitStreams(root, { snapshot: workspaceBytesInput(new Uint8Array([42])),
    delta: workspaceBytesInput(new Uint8Array()) }, new AbortController().signal);
  const owner = new UserspaceRootStorage(backend), channel = new MessageChannel();
  const opened = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<undefined>();
  const server = serveUserspaceStorage(channel.port2, async (request, signal) => {
    const value = await owner.handle(request, signal);
    if (request.type === "open-root-overlay") { opened.resolve(signal); await release.promise; }
    return value;
  });
  const client = new UserspaceStorageClient(channel.port1), cancellation = new AbortController();
  const pending = client.openRootOverlay(root, binding, cancellation.signal);
  const settled = pending.catch(() => {});
  try {
    const opening = await opened.promise;
    cancellation.abort();
    await vi.waitFor(() => expect(opening.aborted).toBe(true));
    release.resolve(undefined);
    const selected = await pending;
    expect(selected).toBeDefined();
    if (selected === undefined) throw new Error("missing read retirement identity");
    await client.closeRootOverlay(selected.id);
    await expect(client.openRootOverlay(root, binding)).resolves.toBeDefined();
  } finally { release.resolve(undefined); await settled; client.close(); await server.close(); await owner.close(); }
});

it("retires a transferred root when the storage request queue is full", async () => {
  const channel = new MessageChannel();
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const server = serveUserspaceStorage(channel.port2, async () => {
    entered.resolve(undefined); await release.promise; return new Uint8Array([1]);
  });
  const client = new UserspaceStorageClient(channel.port1);
  const received = Promise.withResolvers<undefined>();
  channel.port2.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (decodeUserspaceStorageIncoming(event.data).type === "commit-root-overlay") received.resolve(undefined);
  });
  const traffic = new AssistanceTraffic();
  const reads = Array.from({ length: 128 }, () => client.readWorkspace("/held"));
  const settled = Promise.allSettled(reads);
  try {
    await entered.promise;
    const transfer = transferWorkspaceStream(workspaceBytesInput(new Uint8Array([1])), binding, 1, traffic);
    const commit = expect(client.commitRootOverlay(root, transfer.descriptor)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    const second = transferWorkspaceStream(workspaceBytesInput(new Uint8Array([2])), binding, 2, traffic);
    const secondCommit = expect(client.commitRootOverlay(root, second.descriptor)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await received.promise;
    release.resolve(undefined);
    await Promise.all([commit, secondCommit, transfer.finished, second.finished]);
    expect(traffic.pendingBytes).toBe(0);
    await server.close();
    await expect(client.readWorkspace("/after-fence")).rejects.toMatchObject({ code: "ABORTED" });
    const unsent = transferWorkspaceStream(workspaceBytesInput(new Uint8Array([1])), binding, 3, traffic);
    await expect(client.commitRootOverlay(root, unsent.descriptor)).rejects.toMatchObject({ code: "ABORTED" });
    await unsent.finished;
    expect(traffic.pendingBytes).toBe(0);
  } finally { release.resolve(undefined); await settled; await server.close(); client.close(); }
}, 1500);

it("retires a root publication rejected by a pre-aborted client request", async () => {
  const channel = new MessageChannel();
  const client = new UserspaceStorageClient(channel.port1);
  const traffic = new AssistanceTraffic();
  try {
    const transfer = transferWorkspaceStream(workspaceBytesInput(new Uint8Array([1])), binding, 1, traffic);
    const cancellation = new AbortController(); cancellation.abort();
    await expect(client.commitRootOverlay(root, transfer.descriptor, cancellation.signal)).rejects.toMatchObject({ code: "ABORTED" });
    await transfer.finished;
    expect(traffic.pendingBytes).toBe(0);
  } finally { client.close(); channel.port2.close(); }
}, 1500);

it("retires a root publication when its ports cannot be transferred", async () => {
  const channel = new MessageChannel();
  const client = new UserspaceStorageClient(channel.port1);
  const traffic = new AssistanceTraffic();
  const send = vi.spyOn(channel.port1, "postMessage").mockImplementationOnce(() => {
    throw new DOMException("transfer failed", "DataCloneError");
  });
  try {
    const transfer = transferWorkspaceStream(workspaceBytesInput(new Uint8Array([1])), binding, 1, traffic);
    await expect(client.commitRootOverlay(root, transfer.descriptor)).rejects.toMatchObject({ name: "DataCloneError" });
    await transfer.finished;
    expect(traffic.pendingBytes).toBe(0);
  } finally { send.mockRestore(); client.close(); channel.port2.close(); }
}, 1500);

it("streams a root publication and restores it through bounded, offset-qualified reads", async () => {
  const backend = opfsWorkspaceStoreBackend(new MemoryDirectory());
  const storage = new UserspaceRootStorage(backend);
  const channel = new MessageChannel();
  const server = serveUserspaceStorage(channel.port2, (request, signal) => storage.handle(request, signal));
  const client = new UserspaceStorageClient(channel.port1);
  const traffic = new AssistanceTraffic();
  try {
    await expect(client.openRootOverlay(root, binding)).resolves.toBeUndefined();
    const bytes = new Uint8Array(140_000).fill(42);
    const transfer = transferWorkspaceStream(workspaceBytesInput(bytes), binding, 1, traffic);
    await expect(client.commitRootOverlay(root, transfer.descriptor)).resolves.toBe(1);
    await transfer.finished;
    expect(traffic.pendingBytes).toBe(0);
    const read = await client.openRootOverlay(root, binding);
    expect(read).toMatchObject({ generation: 1, bytes: bytes.length });
    if (read === undefined) throw new Error("root generation is missing");
    await expect(client.readRootFrame(read.id + 1, 0)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    let offset = 0;
    for (;;) {
      const frame = await client.readRootFrame(read.id, offset);
      if (frame === undefined) break;
      expect(frame.length).toBeLessThanOrEqual(65536);
      expect(frame).toEqual(bytes.slice(offset, offset + frame.length));
      offset += frame.length;
    }
    expect(offset).toBe(bytes.length);
    await client.closeRootOverlay(read.id);
    const stale = transferWorkspaceStream(workspaceBytesInput(new Uint8Array([1])), binding, 1, traffic);
    await expect(client.commitRootOverlay(root, stale.descriptor)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await stale.finished;
    expect(traffic.pendingBytes).toBe(0);
    await expect(client.readRootFrame(read.id, 0)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await expect(client.openRootOverlay("b".repeat(64), binding)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  } finally { await server.close(); client.close(); await storage.close(); }
});

it("rebinds a retired root selection and rejects the previous producer after restore", async () => {
  const backend = opfsWorkspaceStoreBackend(new MemoryDirectory());
  const owner = new UserspaceRootStorage(backend), channel = new MessageChannel();
  const server = serveUserspaceStorage(channel.port2, (request, signal) => owner.handle(request, signal));
  const client = new UserspaceStorageClient(channel.port1), traffic = new AssistanceTraffic();
  const next = { ...binding, generation: 2 }, changedRoot = "b".repeat(64);
  try {
    await client.openRootOverlay(root, binding);
    await expect(client.openRootOverlay(changedRoot, next)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await expect(client.openRootOverlay(changedRoot, next, undefined, binding)).resolves.toBeUndefined();
    const stale = transferWorkspaceStream(workspaceBytesInput(new Uint8Array([1])), binding, 1, traffic);
    await expect(client.commitRootOverlay(root, stale.descriptor)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await stale.finished;
    const current = transferWorkspaceStream(workspaceBytesInput(new Uint8Array([2])), next, 1, traffic);
    await expect(client.commitRootOverlay(changedRoot, current.descriptor)).resolves.toBe(1);
    await current.finished;
    const selected = await client.openRootOverlay(changedRoot, next);
    if (selected === undefined) throw new Error("Missing selected root");
    await expect(client.openRootOverlay(root, { ...binding, generation: 3 }, undefined, next)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await client.closeRootOverlay(selected.id);
    await expect(client.openRootOverlay(root, { ...binding, generation: 4 }, undefined, next)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await expect(client.openRootOverlay(root, { ...binding, generation: 3 }, undefined, next)).resolves.toBeUndefined();
    expect(traffic.pendingBytes).toBe(0);
  } finally { client.close(); await server.close(); await owner.close(); }
});
