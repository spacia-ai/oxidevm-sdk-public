import { expect, it, vi } from "vitest";
import { VMError } from "../../errors.js";
import { WORKSPACE_PUBLICATION_BYTES } from "../../protocol/workspace-publication.js";
import { WorkspaceStore } from "../workspace-store.js";
import { WorkspacePublications } from "../workspace-publication.js";
import { SnapshotStorageClient } from "../snapshot-channel.js";
import { serveSnapshotStorage } from "../snapshot-storage-server.js";
import { transferWorkspaceStream } from "../workspace-transfer.js";
import { AssistanceTraffic } from "./assistance-traffic.js";
import type { GuestAgent } from "./guest-agent.js";
import { activateInstallationPublication } from "./installation-publication.js";

it.each(["success", "native-failure", "cancel", "publication-failure", "wrong-identity"] as const)("keeps native activation and durable publication ordered through %s", async outcome => {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  let rejectCommit = false;
  const store = new WorkspaceStore({
    async *list(prefix) { for (const key of files.keys()) if (key.startsWith(prefix)) yield await Promise.resolve(key); },
    read: key => Promise.resolve(files.get(key)?.slice()),
    write: (key, bytes) => {
      if (rejectCommit && key === "active.json") return Promise.reject(new Error("publication failed"));
      files.set(key, bytes.slice()); return Promise.resolve();
    },
    remove: key => { files.delete(key); return Promise.resolve(); },
  });
  const base = "a".repeat(64); const inputs = "b".repeat(64);
  await store.commit(base, new Uint8Array([42]));
  const previous = files.get("active.json")?.slice();
  const owner = new WorkspacePublications(); const channel = new MessageChannel();
  const client = new SnapshotStorageClient(channel.port2);
  const operations: string[] = [];
  const server = serveSnapshotStorage(channel.port1, async (request, signal) => {
    operations.push(request.type);
    if (request.type === "stage-workspace-streams") return owner.stage(store, request.publication, signal);
    if (request.type === "read-workspace-frame") return owner.read(request.identity, request.source, request.offset, signal);
    if (request.type === "retire-workspace-source") return owner.retireReadSource(request.identity, request.source);
    if (request.type === "finish-workspace-stage") {
      const result = await owner.finishStage(request.identity, request.decision);
      return outcome === "wrong-identity" && result.outcome.kind === "committed"
        ? { ...result, outcome: { ...result.outcome, dependencyGeneration: "c".repeat(64) } } : result;
    }
    throw new Error("unexpected operation");
  }, () => owner.close());
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const traffic = new AssistanceTraffic(7);
  const credit = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
  const transfers = [1, 2, 3].map(value => transferWorkspaceStream({ bytes: 12, source: () => ({
    frames: (async function* () { yield await Promise.resolve(new Uint8Array(12).fill(value)); })(), retire: () => Promise.resolve(),
  }) }, binding, value, traffic));
  const [snapshot, delta, tree] = transfers;
  if (snapshot === undefined || delta === undefined || tree === undefined) throw new Error("missing stream");
  const started = Promise.withResolvers<undefined>(); const retire = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  const agent: Pick<GuestAgent, "cancel"> = { cancel: vi.fn() };
  const activate = async (identity: { readonly generation: string; readonly inputsSha256: string }): Promise<void> => {
    // Storage assigned the generation to the captured bytes; Linux activates its own copy under it.
    expect(/^[0-9a-f]{64}$/u.test(identity.generation)).toBe(true);
    expect(identity.inputsSha256).toBe(inputs);
    started.resolve(undefined); await retire.promise;
    if (outcome === "native-failure") throw new VMError("STORAGE_ERROR", "native activation failed");
    if (outcome === "cancel") throw new VMError("ABORTED", "native activation retired");
    rejectCommit = outcome === "publication-failure";
  };
  try {
    const work = activateInstallationPublication(client, {
      workspaceBaseSha256: base, credit, snapshot: snapshot.descriptor, delta: delta.descriptor,
      dependencies: { inputsSha256: inputs, tree: tree.descriptor },
    }, { agent, requestId: 42, activate }, controller.signal);
    await started.promise;
    expect(files.get("active.json")).toEqual(previous);
    expect(operations).not.toContain("finish-workspace-stage");
    if (outcome === "cancel") { controller.abort(); expect(agent.cancel).toHaveBeenCalledWith(42); }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(operations).not.toContain("finish-workspace-stage");
    retire.resolve(undefined);
    const result = await work;
    await Promise.all(transfers.map(transfer => transfer.finished));
    if (outcome === "success") {
      expect(result).toMatchObject({ retired: true, outcome: { kind: "committed", generation: 2 } });
      expect(files.get("active.json")).not.toEqual(previous);
    } else {
      expect(result).toMatchObject({ outcome: { kind: "failed", error: { detail: { activationUncertain: true } } } });
      if (outcome === "wrong-identity") expect(files.get("active.json")).not.toEqual(previous);
      else expect(files.get("active.json")).toEqual(previous);
    }
    if (result.retired) { traffic.returnCredit(result.credit); expect(traffic.pendingBytes).toBe(0); }
    else expect(traffic.pendingBytes).toBe(WORKSPACE_PUBLICATION_BYTES);
  } finally {
    retire.resolve(undefined); client.close();
    if (outcome === "publication-failure") await expect(server.close()).rejects.toBeDefined();
    else await server.close();
  }
});
