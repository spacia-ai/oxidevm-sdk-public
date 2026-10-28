import { expect, it } from "vitest";
import { WORKSPACE_PUBLICATION_BYTES, decodeWorkspacePublicationResult, decodeWorkspacePublication } from "../protocol/workspace-publication.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import { WorkspacePublications } from "./workspace-publication.js";
import { transferWorkspaceStream, retireWorkspaceTransfer } from "./workspace-transfer.js";

it("strictly decodes snapshot reuse without admitting a second stream or a stale protocol", async () => {
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const traffic = new AssistanceTraffic(6);
  const credit = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
  const input = { bytes: 0, source: () => ({ frames: (async function* () {})(), retire: () => Promise.resolve() }) };
  const delta = transferWorkspaceStream(input, binding, 1, traffic);
  try {
    const publication = { workspaceBaseSha256: "a".repeat(64), credit, snapshot: { reuse: 3 }, delta: delta.descriptor };
    expect(decodeWorkspacePublication(publication).snapshot).toEqual({ reuse: 3 });
    for (const snapshot of [{ reuse: 0 }, { reuse: 1.1 }, { reuse: "3" }, { reuse: 3, stream: delta.descriptor.stream }]) {
      expect(() => decodeWorkspacePublication({ ...publication, snapshot })).toThrow();
    }
    expect(() => decodeWorkspacePublication({ ...publication, delta: { ...delta.descriptor, version: 79 } })).toThrow();
  } finally { await retireWorkspaceTransfer(delta.descriptor); await delta.finished; traffic.returnCredit({ ...credit, kind: "return" }); }
});

it.each([
  { method: "commit", cancelled: false }, { method: "commit", cancelled: true },
  { method: "stage", cancelled: false }, { method: "stage", cancelled: true },
] as const)("retires all transferred producers when $method admission fails (cancelled=$cancelled)", async ({ method, cancelled }) => {
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const traffic = new AssistanceTraffic(6);
  const credit = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
  let retired = 0;
  const input = { bytes: 1, source: () => ({
    frames: (async function* () { yield await Promise.resolve(new Uint8Array([1])); })(),
    retire: () => { retired += 1; return Promise.resolve(); },
  }) };
  const snapshot = transferWorkspaceStream(input, binding, 1, traffic);
  const delta = transferWorkspaceStream(input, binding, 2, traffic);
  const controller = new AbortController();
  if (cancelled) controller.abort();
  const owner = new WorkspacePublications();
  const publication = {
    workspaceBaseSha256: "a".repeat(64), credit, snapshot: snapshot.descriptor, delta: delta.descriptor,
  };
  const received = await owner[method](undefined, publication, controller.signal);
  if ("kind" in received && received.kind === "staged") throw new Error("unexpected staging");
  const result = decodeWorkspacePublicationResult("kind" in received ? received.result : received);
  expect(result).toMatchObject({ retired: true, outcome: { kind: "failed", error: { code: cancelled ? "ABORTED" : "STORAGE_ERROR" } } });
  if (!result.retired) throw new Error("missing retirement");
  traffic.returnCredit(result.credit);
  await Promise.all([snapshot.finished, delta.finished]);
  expect(retired).toBe(2);
  expect(traffic.pendingBytes).toBe(0);
  const staleSnapshot = transferWorkspaceStream(input, binding, 3, traffic);
  const staleDelta = transferWorkspaceStream(input, binding, 4, traffic);
  await expect(owner[method](undefined, { ...publication, snapshot: staleSnapshot.descriptor,
    delta: staleDelta.descriptor }, controller.signal)).rejects.toThrow("Stale workspace publication credit");
  await Promise.all([staleSnapshot.finished, staleDelta.finished]);
  expect(retired).toBe(4);
  expect(traffic.pendingBytes).toBe(0);
  expect(() => owner.assertActive()).toThrow("reopen the VM");
});

it.each(["commit", "stage"] as const)("fences %s and keeps credit when producer retirement is uncertain", async method => {
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const traffic = new AssistanceTraffic(6);
  const credit = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
  const input = { bytes: 1, source: () => ({
    frames: (async function* () { yield await Promise.resolve(new Uint8Array([1])); })(),
    retire: () => Promise.reject(new Error("native retirement lost")),
  }) };
  const snapshot = transferWorkspaceStream(input, binding, 1, traffic);
  const delta = transferWorkspaceStream(input, binding, 2, traffic);
  const owner = new WorkspacePublications();
  const received = await owner[method](undefined, {
    workspaceBaseSha256: "a".repeat(64), credit, snapshot: snapshot.descriptor, delta: delta.descriptor,
  }, new AbortController().signal);
  if ("kind" in received && received.kind === "staged") throw new Error("unexpected staging");
  const result = "kind" in received ? received.result : received;
  expect(result).toMatchObject({ retired: false, outcome: { kind: "failed", error: { detail: { cleanupFailed: true } } } });
  expect(() => owner.assertActive()).toThrow("uncertain");
  expect((await Promise.allSettled([snapshot.finished, delta.finished])).every(result => result.status === "rejected")).toBe(true);
  expect(traffic.pendingBytes).toBeGreaterThan(WORKSPACE_PUBLICATION_BYTES);
});

it.each([false, true])("fences other storage requests after publication uncertainty or confirmed cleanup failure (%s)", async confirmed => {
  const { WorkspaceStore } = await import("./workspace-store.js");
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const store = new WorkspaceStore({
    async *list(prefix) { for (const path of files.keys()) if (path.startsWith(prefix)) yield await Promise.resolve(path); },
    read: path => Promise.resolve(files.get(path)),
    write: (path, bytes) => {
      files.set(path, bytes.slice());
      return path === "active.json" && !confirmed ? Promise.reject(new Error("lost durable receipt")) : Promise.resolve();
    },
    remove: path => {
      if (path === "intent.json" && confirmed) return Promise.reject(new Error("intent cleanup failed"));
      files.delete(path); return Promise.resolve();
    },
  });
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const traffic = new AssistanceTraffic(6);
  const credit = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
  const input = { bytes: 1, source: () => ({
    frames: (async function* () { yield await Promise.resolve(new Uint8Array([1])); })(),
    retire: () => Promise.resolve(),
  }) };
  const snapshot = transferWorkspaceStream(input, binding, 1, traffic);
  const delta = transferWorkspaceStream(input, binding, 2, traffic);
  const owner = new WorkspacePublications();
  const result = await owner.commit(store, { workspaceBaseSha256: "a".repeat(64), credit,
    snapshot: snapshot.descriptor, delta: delta.descriptor,
  }, new AbortController().signal);
  expect(result).toMatchObject({ retired: true, outcome: { kind: "failed", error: { detail: confirmed
    ? { committed: true, cleanupFailed: true } : { reason: "workspace-publication-uncertain" },
  } } });
  expect(() => owner.assertActive()).toThrow("reopen the VM");
  if (!result.retired) throw new Error("missing retirement");
  traffic.returnCredit(result.credit);
  await Promise.all([snapshot.finished, delta.finished]);
  expect(traffic.pendingBytes).toBe(0);
  expect(files.has("active.json")).toBe(true);
});

it.each([
  { method: "commit", name: "QuotaExceededError", code: "QUOTA_EXCEEDED" },
  { method: "stage", name: "QuotaExceededError", code: "QUOTA_EXCEEDED" },
  { method: "commit", name: "NotAllowedError", code: "PERMISSION_DENIED" },
  { method: "stage", name: "NotAllowedError", code: "PERMISSION_DENIED" },
] as const)("preserves $name during $method and keeps the previous generation usable", async ({ method, name, code }) => {
  const { WorkspaceStore } = await import("./workspace-store.js");
  const files = new Map<string, Uint8Array<ArrayBuffer>>(); let failWrites = false; let retired = 0;
  const store = new WorkspaceStore({
    async *list(prefix) { for (const path of files.keys()) if (path.startsWith(prefix)) yield await Promise.resolve(path); },
    read: path => Promise.resolve(files.get(path)),
    write: (path, bytes) => {
      if (failWrites && path.startsWith("chunks/")) { failWrites = false; return Promise.reject(new DOMException("Browser storage unavailable", name)); }
      files.set(path, bytes.slice()); return Promise.resolve();
    },
    remove: path => { files.delete(path); return Promise.resolve(); },
  });
  const base = "a".repeat(64); await store.commit(base, new Uint8Array([7]), new Uint8Array([8]));
  const previous = files.get("active.json")?.slice(); failWrites = true;
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const traffic = new AssistanceTraffic(6);
  const credit = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
  const input = { bytes: 1, source: () => ({ frames: (async function* () { yield await Promise.resolve(new Uint8Array([1])); })(),
    retire: () => { retired++; return Promise.resolve(); },
  }) };
  const snapshot = transferWorkspaceStream(input, binding, 1, traffic); const delta = transferWorkspaceStream(input, binding, 2, traffic);
  const owner = new WorkspacePublications();
  const received = await owner[method](store, { workspaceBaseSha256: base, credit, snapshot: snapshot.descriptor, delta: delta.descriptor }, new AbortController().signal);
  if ("kind" in received && received.kind === "staged") throw new Error("Unexpected staging success");
  const result = decodeWorkspacePublicationResult("kind" in received ? received.result : received);
  expect(result).toMatchObject({ retired: true, outcome: { kind: "failed", error: { code, detail: { name } } } });
  if (!result.retired) throw new Error("Missing retirement");
  traffic.returnCredit(result.credit); await Promise.all([snapshot.finished, delta.finished]);
  expect(retired).toBe(2); expect(traffic.pendingBytes).toBe(0); expect(() => owner.assertActive()).not.toThrow();
  failWrites = false; await expect(store.read(base)).resolves.toEqual(new Uint8Array([7]));
  expect(files.get("active.json")).toEqual(previous); await owner.close();
});
