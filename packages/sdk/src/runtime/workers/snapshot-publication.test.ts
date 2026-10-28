import { installationStreams } from "./control/installation-stream.js";
import { decodeInstallationReply, encodeInstallationReply, type InstallationReply } from "../protocol/assistance-installation-reply.js";
import { expect, it } from "vitest";
import { WORKSPACE_PUBLICATION_BYTES } from "../protocol.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import { SnapshotStorageClient } from "./snapshot-channel.js";
import { serveSnapshotStorage } from "./snapshot-storage-server.js";
import { WorkspaceStore } from "./workspace-store.js";
import { WorkspacePublications } from "./workspace-publication.js";
import { transferWorkspaceStream } from "./workspace-transfer.js";

it.each(["before", "pending", "committed"])("preserves publication outcomes and retirement across channel cancellation (%s)", async timing => {
  const ports = new MessageChannel();
  const traffic = new AssistanceTraffic(6);
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const credit = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
  let retired = 0;
  const input = { bytes: 1, source: () => ({
    frames: (async function* () { yield await Promise.resolve(new Uint8Array([1])); })(),
    retire: () => { retired += 1; return Promise.resolve(); },
  }) };
  const snapshot = transferWorkspaceStream(input, binding, 1, traffic);
  const delta = transferWorkspaceStream(input, binding, 2, traffic);
  const entered = Promise.withResolvers<undefined>();
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const store = new WorkspaceStore({
    async *list(prefix) { for (const path of files.keys()) if (path.startsWith(prefix)) yield await Promise.resolve(path); },
    read: path => Promise.resolve(files.get(path)),
    write: (path, bytes) => { files.set(path, bytes.slice()); return Promise.resolve(); },
    remove: path => { files.delete(path); return Promise.resolve(); },
  });
  const owner = new WorkspacePublications();
  const server = serveSnapshotStorage(ports.port1, async (request, signal) => {
    if (request.type !== "commit-workspace-streams") throw new Error("unexpected storage operation");
    const committed = timing === "committed" ? await owner.commit(store, request.publication, signal) : undefined;
    entered.resolve(undefined);
    if (!signal.aborted) await new Promise<undefined>(resolve => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
    return committed ?? owner.commit(undefined, request.publication, signal);
  });
  const client = new SnapshotStorageClient(ports.port2);
  const controller = new AbortController();
  if (timing === "before") controller.abort();
  try {
    const pending = client.publishWorkspace({ workspaceBaseSha256: "a".repeat(64), credit,
      snapshot: snapshot.descriptor, delta: delta.descriptor }, controller.signal);
    await entered.promise;
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ retired: true, outcome: timing === "committed"
      ? { kind: "committed", generation: 1 } : { kind: "failed", error: { code: "ABORTED" } } });
    if (!result.retired) throw new Error("missing retirement");
    traffic.returnCredit(result.credit);
    await Promise.all([snapshot.finished, delta.finished]);
    expect(retired).toBe(2);
    expect(traffic.pendingBytes).toBe(0);
  } finally { client.close(); await server.close(); }
});

it("publishes all native capture sources within one VM traffic budget", async () => {
  const traffic = new AssistanceTraffic(6);
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const identity = { ...binding, installation: 1 };
  const native = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: 3 * 1024 * 1024, entries: 6 });
  const nativeControl = traffic.grant({ ...binding, producer: "storage", process: null, pool: "control", bytes: 3 * 16 * 1024, entries: 6 });
  const offsets = new Map<string, number>();
  const pipe = installationStreams({ installation: (_id, request) => {
    const operation = request.operation;
    let result: InstallationReply["result"];
    switch (operation.kind) {
      case "retire": result = { kind: "retired" }; break;
      case "materialize": result = { kind: "materialized" }; break;
      case "activate-materialized": result = { kind: "unit" }; break;
      case "capture": case "workspace-capture": result = { kind: "capture-ready", bytes: 1024 * 1024 + 1 }; break;
      case "capture-read": case "workspace-capture-read": {
        const key = operation.kind === "workspace-capture-read" ? operation.source : "dependencies";
        const offset = offsets.get(key) ?? 0;
        const bytes = new Uint8Array(Math.min(65536, 1024 * 1024 + 1 - offset)).fill(7);
        offsets.set(key, offset + bytes.length);
        result = { kind: "data", bytes }; break;
      }
      case "capture-retire": case "workspace-capture-retire": result = { kind: "capture-retired", errno: 0 }; break;
      case "acknowledge": result = { kind: "acknowledged" }; break;
      case "stop": result = { kind: "stopped" }; break;
      case "set-build-policy": case "blocked-builds": case "validate-inputs": case "check-current": case "start": case "read": case "write": case "stdin": case "close-stdin": case "signal": case "execute": case "output-ack": throw new Error("unexpected capture operation");
    }
    return Promise.resolve(decodeInstallationReply(encodeInstallationReply({ ...identity, sequence: request.sequence, result }, 6), 6));
  } }, identity, 1, traffic);
  await pipe.retire(); await pipe.materialize();
  const inputs = await Promise.all([pipe.capture("snapshot"), pipe.capture("delta"), pipe.capture()]);
  const credit = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
  const transfers = inputs.map((input, index) => transferWorkspaceStream(input, binding, index + 1, traffic));
  const [snapshot, delta, dependencies] = transfers;
  if (snapshot === undefined || delta === undefined || dependencies === undefined) throw new Error("missing publication source");
  expect(traffic.pendingBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const store = new WorkspaceStore({
    async *list(prefix) { for (const path of files.keys()) if (path.startsWith(prefix)) yield await Promise.resolve(path); },
    read: path => Promise.resolve(files.get(path)),
    write: (path, bytes) => { files.set(path, bytes.slice()); return Promise.resolve(); },
    remove: path => { files.delete(path); return Promise.resolve(); },
  });
  const ports = new MessageChannel();
  const owner = new WorkspacePublications();
  const server = serveSnapshotStorage(ports.port1, (request, signal) => {
    if (request.type !== "commit-workspace-streams") throw new Error("unexpected operation");
    return owner.commit(store, request.publication, signal);
  });
  const client = new SnapshotStorageClient(ports.port2);
  try {
    const result = await client.publishWorkspace({ workspaceBaseSha256: "a".repeat(64), credit,
      snapshot: snapshot.descriptor, delta: delta.descriptor,
      dependencies: { inputsSha256: "b".repeat(64), tree: dependencies.descriptor } });
    expect(result.outcome).toMatchObject({ kind: "committed", generation: 1 });
    if (result.outcome.kind !== "committed") throw new Error("publication failed");
    expect(result.outcome.dependencyGeneration).toMatch(/^[a-f0-9]{64}$/u);
    if (!result.retired) throw new Error("missing retirement");
    traffic.returnCredit(result.credit);
    await Promise.all(transfers.map(transfer => transfer.finished));
    await pipe.release();
    traffic.returnCredit({ ...native, kind: "return" });
    traffic.returnCredit({ ...nativeControl, kind: "return" });
    expect(traffic.pendingBytes).toBe(0);
    expect(traffic.pendingEntries).toBe(0);
  } finally { client.close(); await server.close(); await pipe.release(); }
});
