import { expect, it } from "vitest";
import { decodeWorkspacePublicationResult, WORKSPACE_PUBLICATION_BYTES } from "../protocol/workspace-publication.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import { WorkspaceStore } from "./workspace-store.js";
import { WorkspacePublications } from "./workspace-publication.js";
import { SnapshotStorageClient, decodeSnapshotStorageRequest, snapshotStorageResponse } from "./snapshot-channel.js";
import { serveSnapshotStorage } from "./snapshot-storage-server.js";
import { transferWorkspaceStream } from "./workspace-transfer.js";
import { receiveWorkspaceRead } from "./workspace-read-client.js";
import { AgentRestore } from "./control/agent-restore.js";

it("rejects a finalization receipt for another reservation", async () => {
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const traffic = new AssistanceTraffic(7);
  const credit = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
  const channel = new MessageChannel();
  const client = new SnapshotStorageClient(channel.port2);
  channel.port1.onmessage = (event: MessageEvent<unknown>) => {
    const request = decodeSnapshotStorageRequest(event.data);
    channel.port1.postMessage(snapshotStorageResponse(request.id, {
      retired: true, credit: { ...credit, kind: "return", reservation: credit.reservation + 1 },
      outcome: { kind: "committed", generation: 1 },
    }));
  };
  channel.port1.start();
  try {
    await expect(client.finishWorkspaceStage({ ...binding, transfer: credit.reservation }, "commit")).rejects.toMatchObject({ code: "PROTOCOL_ERROR", detail: { cleanupFailed: true } });
    expect(traffic.pendingBytes).toBe(WORKSPACE_PUBLICATION_BYTES);
  } finally { client.close(); channel.port1.close(); }
});

it.each(["commit", "abort", "close"] as const)("streams a staged generation through the storage channel before %s", async decision => {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const store = new WorkspaceStore({
    async *list(prefix) { for (const key of files.keys()) if (key.startsWith(prefix)) yield await Promise.resolve(key); },
    read: key => Promise.resolve(files.get(key)?.slice()),
    write: (key, bytes) => { files.set(key, bytes.slice()); return Promise.resolve(); },
    remove: key => { files.delete(key); return Promise.resolve(); },
  });
  const base = "a".repeat(64);
  await store.commit(base, new Uint8Array([42]));
  const previous = files.get("active.json")?.slice();
  const owner = new WorkspacePublications();
  const channel = new MessageChannel();
  const client = new SnapshotStorageClient(channel.port2);
  let queue: Promise<unknown> = Promise.resolve();
  const server = serveSnapshotStorage(channel.port1, (request, signal) => {
    const result = queue.then(async () => {
      if (request.type === "stage-workspace-streams") return owner.stage(store, request.publication, signal);
      if (request.type === "read-workspace-frame") return owner.read(request.identity, request.source, request.offset, signal);
      if (request.type === "retire-workspace-source") return owner.retireReadSource(request.identity, request.source);
      if (request.type === "retire-workspace-read") return owner.retireRead(request.identity);
      if (request.type === "finish-workspace-stage") return owner.finishStage(request.identity, request.decision);
      throw new Error("unexpected request");
    });
    queue = result.catch(() => {}); return result;
  }, () => owner.close());
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const traffic = new AssistanceTraffic(7);
  const credit = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
  const identity = { ...binding, transfer: credit.reservation };
  const transfers = [1, 2, 3].map(byte => transferWorkspaceStream({ bytes: 65_537, source: () => ({
    frames: (async function* () { yield await Promise.resolve(new Uint8Array(65_536).fill(byte)); yield new Uint8Array([byte]); })(),
    retire: () => Promise.resolve(),
  }) }, binding, byte, traffic));
  const [snapshot, delta, tree] = transfers;
  if (snapshot === undefined || delta === undefined || tree === undefined) throw new Error("missing transfer");
  try {
    const staged = await client.stageWorkspace({
      workspaceBaseSha256: base, credit, snapshot: snapshot.descriptor, delta: delta.descriptor,
      dependencies: { inputsSha256: "b".repeat(64), tree: tree.descriptor },
    });
    expect(staged.kind).toBe("staged");
    if (staged.kind !== "staged") throw new Error("staging failed");
    await Promise.all(transfers.map(transfer => transfer.finished));
    expect(files.get("active.json")).toEqual(previous);
    expect(traffic.pendingBytes).toBe(WORKSPACE_PUBLICATION_BYTES);
    await expect(client.request({ type: "finish-workspace-stage", identity: { ...identity, generation: 2 }, decision: "commit" })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await expect(client.request({ type: "retire-workspace-read", identity })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    const read = receiveWorkspaceRead(client, identity, staged.selection, new AbortController().signal);
    const selected = read.dependencies;
    if (selected === undefined) throw new Error("missing candidate dependencies");
    let offset = 0; let committed = false;
    const restore = new AgentRestore((_id, target, bytes) => {
      expect(target).toMatchObject({ kind: "dependencies" });
      expect(bytes).toBe(65_537);
      return { transfer: 9, ready: Promise.resolve("receive" as const), status: () => Promise.resolve({ state: "done" as const, applied: 0, total: 0 }), send: async (_id, operation) => {
        if (operation.kind === "chunk") {
          // Several chunk sends are in flight at once, so advance the expected offset before
          // awaiting anything.
          expect(operation.offset).toBe(offset);
          offset += operation.data.length;
          expect(operation.data.every(byte => byte === 3)).toBe(true);
          expect(operation.data.length).toBeLessThanOrEqual(65_536);
          expect(operation.sha256).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(operation.data))));
        } else if (operation.kind === "commit") { expect(offset).toBe(65_537); committed = true; }
        else throw new Error("unexpected restore operation");
        expect(files.get("active.json")).toEqual(previous);
      } };
    }, error => error);
    await restore.apply(7, { kind: "dependencies", generation: Uint8Array.from(Buffer.from(selected.generation, "hex")), inputs: new Uint8Array(32).fill(0xbb) }, selected.tree);
    expect(committed).toBe(true);
    await read.retire();
    if (decision === "close") {
      await server.close();
      expect(traffic.pendingBytes).toBe(WORKSPACE_PUBLICATION_BYTES); // no final receipt
    } else {
      const result = decodeWorkspacePublicationResult(await client.finishWorkspaceStage(identity, decision));
      expect(result).toMatchObject({ retired: true, outcome: { kind: decision === "commit" ? "committed" : "failed" } });
      if (!result.retired) throw new Error("retirement missing");
      traffic.returnCredit(result.credit);
      expect(traffic.pendingBytes).toBe(0);
      await expect(client.request({ type: "finish-workspace-stage", identity, decision })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    }
    if (decision === "commit") expect(await store.dependencyGeneration(base, new AbortController().signal)).toBe(staged.selection.dependencies?.generation);
    else expect(files.get("active.json")).toEqual(previous);
  } finally { client.close(); await server.close(); }
});
