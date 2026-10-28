import { expect, it } from "vitest";
import { VMError } from "../errors.js";
import { WORKSPACE_PUBLICATION_BYTES, workspacePublicationTransfers, type WorkspacePublication } from "../protocol/workspace-publication.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import { UserspaceStorageClient } from "./userspace-storage-channel.js";
import { serveUserspaceStorage } from "./userspace-storage-server.js";
import { WorkspacePublications } from "./workspace-publication.js";
import { openWorkspaceRead } from "./workspace-read-client.js";
import { WorkspaceStore, type WorkspaceStoreBackend } from "./workspace-store.js";
import { retireWorkspaceTransfer, transferWorkspaceStream } from "./workspace-transfer.js";
import { workspaceBytesInput, type WorkspaceStreamInput } from "./workspace-stream.js";

const base = "a".repeat(64);
const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
const signal = (): AbortSignal => new AbortController().signal;
function stream(bytes: number): WorkspaceStreamInput {
  return { bytes, source: () => {
    const frames = (async function* () {
      for (let offset = 0; offset < bytes; offset += 65536) yield await Promise.resolve(new Uint8Array(Math.min(65536, bytes - offset)).fill(7));
    })();
    return { frames, retire: async () => { await frames.return(undefined); } };
  } };
}
function fixture(pauseAt?: string) {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const received: WorkspacePublication[] = [];
  const entered = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  const cancelled = Promise.withResolvers<undefined>();
  const backend: WorkspaceStoreBackend = {
    list: async function* (prefix) { for (const path of files.keys()) if (path.startsWith(prefix)) yield await Promise.resolve(path); },
    read: path => Promise.resolve(files.get(path)?.slice()),
    write: async (path, bytes) => {
      files.set(path, bytes.slice());
      if (pauseAt !== undefined && path.startsWith(pauseAt)) { entered.resolve(undefined); await proceed.promise; }
    },
    remove: path => { files.delete(path); return Promise.resolve(); },
  };
  const store = new WorkspaceStore(backend), owner = new WorkspacePublications();
  const channel = new MessageChannel();
  const server = serveUserspaceStorage(channel.port2, (request, signal) => {
    signal.addEventListener("abort", () => cancelled.resolve(undefined), { once: true });
    if (request.type !== "workspace") throw new Error("Unexpected workspace storage request");
    if (request.request.type === "commit-workspace-streams") received.push(request.request.publication);
    if(request.request.type==="inspect-workspace-base")throw new Error("This fixture has no foreign image source");
    return owner.handle(store, request.request, signal);
  });
  const client = new UserspaceStorageClient(channel.port1);
  const traffic = new AssistanceTraffic(7);
  const grant = () => traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
  return { store, files, owner, client, traffic, grant, entered, proceed, cancelled, received,
    close: async () => { proceed.resolve(undefined); client.close(); await server.close(); await owner.closeRead(); } };
}

it("streams over 128 MiB through the Userspace channel and confirms source/final retirement", async () => {
  const f = fixture(), bytes = 129 * 1024 * 1024 + 17;
  await f.store.commitStreams(base, { snapshot: stream(bytes), delta: stream(12), dependencies: { inputsSha256: "b".repeat(64), tree: stream(33) } }, signal());
  try {
    const read = await openWorkspaceRead(f.client, { workspaceBaseSha256: base, credit: f.grant() }, signal());
    if (read.selection?.snapshot === undefined) throw new Error("Snapshot missing");
    const producer = read.selection.snapshot.source(signal());
    let received = 0;
    for await (const frame of producer.frames) { expect(frame.length).toBeLessThanOrEqual(65536); expect(frame[0]).toBe(7); received += frame.length; }
    expect(received).toBe(bytes);
    await producer.retire();
    f.traffic.returnCredit(await read.retire());
    expect(f.traffic.pendingBytes).toBe(0);
    expect(read.selection.dependencies?.inputsSha256).toBe("b".repeat(64));
  } finally { await f.close(); }
}, 30_000);

it.each(["chunks/", "active.json"])("keeps the actual streamed publication outcome when cancellation races %s", async pauseAt => {
  const f = fixture(pauseAt), controller = new AbortController();
  const credit = f.grant();
  const snapshot = transferWorkspaceStream(workspaceBytesInput(new Uint8Array([42])), binding, 1, f.traffic);
  const delta = transferWorkspaceStream(workspaceBytesInput(new Uint8Array([43])), binding, 2, f.traffic);
  try {
    const pending = f.client.publishWorkspace({ workspaceBaseSha256: base, credit, snapshot: snapshot.descriptor, delta: delta.descriptor }, controller.signal);
    await f.entered.promise;
    controller.abort(); await f.cancelled.promise;
    f.proceed.resolve(undefined);
    const result = await pending;
    expect(result).toMatchObject({ retired: true, outcome: { kind: pauseAt === "active.json" ? "committed" : "failed" } });
    if (!result.retired) throw new Error("Retirement missing");
    f.traffic.returnCredit(result.credit);
    await Promise.all([snapshot.finished, delta.finished]);
    expect(f.traffic.pendingBytes).toBe(0);
    expect(f.files.has("active.json")).toBe(pauseAt === "active.json");
  } finally { await f.close(); }
});

it("retires both producers when the workspace request cannot be sent", async () => {
  const f = fixture();
  const credit = f.grant();
  const snapshot = transferWorkspaceStream(stream(12), binding, 1, f.traffic);
  const delta = transferWorkspaceStream(stream(12), binding, 2, f.traffic);
  f.client.close();
  try {
    await expect(f.client.publishWorkspace({ workspaceBaseSha256: base, credit, snapshot: snapshot.descriptor, delta: delta.descriptor })).rejects.toMatchObject({ code: "ABORTED" });
    await Promise.all([snapshot.finished, delta.finished]);
    expect(f.traffic.pendingBytes).toBe(WORKSPACE_PUBLICATION_BYTES);
    expect(f.files.size).toBe(0);
  } finally { await f.close(); }
});

it("fails a lost read retirement without returning another generation's credit", async () => {
  const f = fixture();
  await f.store.commit(base, new Uint8Array([42]));
  try {
    const read = await openWorkspaceRead(f.client, { workspaceBaseSha256: base, credit: f.grant() }, signal());
    f.client.close();
    await expect(read.retire()).rejects.toBeInstanceOf(VMError);
    expect(f.traffic.pendingBytes).toBe(WORKSPACE_PUBLICATION_BYTES);
  } finally { await f.close(); }
});

it.each([false, true])("retires both incoming producers before rejecting stale publication credit (uncertain=%s)", async uncertain => {
  const f = fixture(), credit = f.grant();
  const read = await openWorkspaceRead(f.client, { workspaceBaseSha256: base, credit }, signal());
  f.traffic.returnCredit(await read.retire());
  const retired = [false, false];
  const transfers = retired.map((_, index) => transferWorkspaceStream({ bytes: 12, source: () => ({
    frames: (async function* () { yield await Promise.resolve(new Uint8Array(12)); })(),
    retire: () => {
      retired[index] = true;
      return uncertain && index === 0 ? Promise.reject(new Error("native retirement lost")) : Promise.resolve();
    },
  }) }, binding, index + 1, f.traffic));
  const finished = Promise.allSettled(transfers.map(transfer => transfer.finished));
  const [snapshot, delta] = transfers;
  if (snapshot === undefined || delta === undefined) throw new Error("Missing test transfer");
  try {
    await expect(f.client.publishWorkspace({ workspaceBaseSha256: base, credit,
      snapshot: snapshot.descriptor, delta: delta.descriptor })).rejects.toMatchObject({ code: uncertain ? "STORAGE_ERROR" : "PROTOCOL_ERROR" });
    expect(retired).toEqual([true, true]);
    expect((await finished).map(result => result.status)).toEqual([uncertain ? "rejected" : "fulfilled", "fulfilled"]);
    if (uncertain) expect(f.traffic.pendingBytes).toBeGreaterThan(0);
    else expect(f.traffic.pendingBytes).toBe(0);
    expect(() => f.owner.assertActive()).toThrow("reopen the VM");
    expect(f.files.size).toBe(0);
  } finally {
    for (const publication of f.received) {
      await Promise.all(workspacePublicationTransfers(publication).filter((_, index) => retired[index] !== true).map(retireWorkspaceTransfer));
    }
    await f.close();
  }
});
