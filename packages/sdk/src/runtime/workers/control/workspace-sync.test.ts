import { expect, it, vi } from "vitest";
import { WorkspaceStore } from "../workspace-store.js";
import { WorkspacePublications } from "../workspace-publication.js";
import { SnapshotStorageClient } from "../snapshot-channel.js";
import { serveSnapshotStorage } from "../snapshot-storage-server.js";
import { AssistanceTraffic } from "./assistance-traffic.js";
import { boundedByProgress, synchronizeWorkspace } from "./workspace-sync.js";
import { emptyCaptureCounts } from "../../protocol/workspace-capture.js";
import { VMError } from "../../errors.js";

it.each(["success", "quota", "capture-failure", "legacy"] as const)("stop-and-flush preserves the dependency generation through %s", async outcome => {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  let rejectWrites = false;
  const store = new WorkspaceStore({
    async *list(prefix) { for (const path of files.keys()) if (path.startsWith(prefix)) yield await Promise.resolve(path); },
    read: path => Promise.resolve(files.get(path)?.slice()),
    write: (path, bytes) => {
      if (rejectWrites && path.includes("chunks/")) return Promise.reject(new DOMException("full", "QuotaExceededError"));
      files.set(path, bytes.slice()); return Promise.resolve();
    },
    remove: path => { files.delete(path); return Promise.resolve(); },
  });
  const source = (value: number) => {
    const retire = vi.fn(() => Promise.resolve());
    return { bytes: 12, retire, source: () => ({ retire, frames: (async function* () { yield await Promise.resolve(new Uint8Array(12).fill(value)); })() }) };
  };
  const controller = new AbortController();
  const base = "a".repeat(64);
  await store.commitStreams(base, { snapshot: source(1), delta: source(2),
    dependencies: { inputsSha256: "b".repeat(64), tree: source(3) } }, controller.signal);
  const identity = await store.dependencyGeneration(base, controller.signal);
  const previous = files.get("active.json")?.slice();
  const channel = new MessageChannel();
  const owner = new WorkspacePublications();
  const client = new SnapshotStorageClient(channel.port2);
  const server = serveSnapshotStorage(channel.port1, (request, signal) => {
    if (request.type !== "commit-workspace-streams") throw new Error("Unexpected persistence operation");
    expect(request.publication.dependencies).toBeUndefined();
    return owner.commit(store, request.publication, signal);
  }, () => owner.close());
  const snapshot = source(4); const delta = source(5);
  const captureWorkspace = vi.fn((_requestId: number, format: "snapshot" | "delta") => {
    if (outcome === "capture-failure" && format === "delta") return Promise.reject(new Error("capture failed"));
    return Promise.resolve(format === "snapshot" ? snapshot : delta);
  });
  const traffic = new AssistanceTraffic(7);
  const syncFilesystems = vi.fn(() => {
    expect(snapshot.retire).toHaveBeenCalled();
    expect(delta.retire).toHaveBeenCalled();
    return Promise.resolve();
  });
  rejectWrites = outcome === "quota";
  try {
    const work = synchronizeWorkspace({ supportsStreamedRestore: outcome !== "legacy", captureWorkspace, ...{ syncFilesystems } }, client, traffic, {
      requestId: 42, base, signal: controller.signal, binding: { session: "11111111-2222-4333-8444-555555555555", generation: 1 },
    });
    if (outcome === "quota" || outcome === "capture-failure") await expect(work).rejects.toThrow();
    else await expect(work).resolves.toBe(outcome !== "legacy");
    expect(await store.dependencyGeneration(base, controller.signal)).toBe(identity);
    expect(traffic.pendingEntries).toBe(0);
    expect(traffic.pendingBytes).toBe(0);
    if (outcome === "success") expect(files.get("active.json")).not.toEqual(previous);
    else expect(files.get("active.json")).toEqual(previous);
    if (outcome === "legacy") expect(captureWorkspace).not.toHaveBeenCalled();
    else expect(snapshot.retire).toHaveBeenCalled();
    if (outcome === "success") expect(syncFilesystems).toHaveBeenCalledExactlyOnceWith(42);
    else expect(syncFilesystems).not.toHaveBeenCalled();
  } finally { client.close(); await server.close(); }
});
it("requires recovery when a stalled guest also fails to retire its openings", async () => {
  const channel = new MessageChannel();
  const client = new SnapshotStorageClient(channel.port2);
  const agent = { supportsStreamedRestore: true, syncFilesystems: () => Promise.resolve(), captureWorkspace: vi.fn(() => new Promise<never>(() => {})) };
  try {
    await expect(synchronizeWorkspace(agent, client, new AssistanceTraffic(7),
      { binding: { session: "11111111-2222-4333-8444-555555555555", generation: 1 }, base: "a".repeat(64), requestId: 1, signal: new AbortController().signal, stepMs: 20 }))
      .rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { cleanupFailed: true } });
    expect(agent.captureWorkspace).toHaveBeenCalledTimes(2);
  } finally { channel.port1.close(); channel.port2.close(); vi.useRealTimers(); }
});

it("retires a producer that finishes opening after its opening bound", async () => {
  vi.useFakeTimers();
  const channel = new MessageChannel();
  const client = new SnapshotStorageClient(channel.port2);
  const retire = vi.fn(() => Promise.resolve());
  const capture = { bytes: 12, retire, source: () => ({ retire, frames: (async function* () { yield await Promise.resolve(new Uint8Array(12)); })() }) };
  const agent = { supportsStreamedRestore: true, syncFilesystems: () => Promise.resolve(), captureWorkspace: (_id: number, _format: "snapshot" | "delta", signal: AbortSignal) =>
    new Promise<typeof capture>(resolve => { signal.addEventListener("abort", () => resolve(capture), { once: true }); }) };
  try {
    const rejected = expect(synchronizeWorkspace(agent, client, new AssistanceTraffic(7),
      { binding: { session: "11111111-2222-4333-8444-555555555555", generation: 1 }, base: "a".repeat(64), requestId: 1, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { step: "capture-open" } });
    await vi.advanceTimersByTimeAsync(45_000);
    await rejected;
    expect(retire).toHaveBeenCalledTimes(2);
  } finally { channel.port1.close(); channel.port2.close(); vi.useRealTimers(); }
});

it("reports uncertain ownership if a stalled guest ignores capture cancellation", async () => {
  vi.useFakeTimers();
  const channel = new MessageChannel();
  const client = new SnapshotStorageClient(channel.port2);
  const agent = { supportsStreamedRestore: true, syncFilesystems: () => Promise.resolve(), captureWorkspace: () => new Promise<never>(() => {}) };
  try {
    const rejected = expect(synchronizeWorkspace(agent, client, new AssistanceTraffic(7),
      { binding: { session: "11111111-2222-4333-8444-555555555555", generation: 1 }, base: "a".repeat(64), requestId: 1, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { cleanupFailed: true } });
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
  } finally { channel.port1.close(); channel.port2.close(); vi.useRealTimers(); }
});

it("keeps a slow but progressing publication alive and fails only when frames stop", async () => {
  vi.useFakeTimers();
  try {
    const progress = { frames: 0 };
    let settle: ((value: string) => void) | undefined;
    const work = new Promise<string>(resolve => { settle = resolve; });
    const bounded = boundedByProgress(work, "publish", 45_000, progress);
    let outcome: string | undefined;
    bounded.then(value => { outcome = `resolved:${value}`; }, (error: unknown) => {
      outcome = error instanceof Error ? `rejected:${error.message}:${JSON.stringify(Reflect.get(error, "detail"))}` : "rejected";
    });
    // A frame every 20 s for four minutes never trips the 45 s stall bound.
    for (let second = 0; second < 240; second += 20) { progress.frames += 1; await vi.advanceTimersByTimeAsync(20_000); }
    expect(outcome).toBeUndefined();
    // Then silence: the bound fails with the progress it saw.
    await vi.advanceTimersByTimeAsync(46_000);
    expect(outcome).toBe('rejected:Workspace synchronization stalled:{"step":"publish","afterMs":45000,"frames":12}');
    settle?.("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe('rejected:Workspace synchronization stalled:{"step":"publish","afterMs":45000,"frames":12}');
    const quick = boundedByProgress(Promise.resolve("done"), "publish", 45_000, { frames: 0 });
    await expect(quick).resolves.toBe("done");
  } finally { vi.useRealTimers(); }
});

it("keeps capture planning alive only while completed native entry counters advance", async () => {
  vi.useFakeTimers();
  try {
    const progress = { frames: 0, captures: {
      snapshot: emptyCaptureCounts(), delta: emptyCaptureCounts(),
    } };
    const work = Promise.withResolvers<undefined>();
    const bounded = boundedByProgress(work.promise, "capture-open", 45_000, progress);
    let failed = false;
    void bounded.catch(() => { failed = true; });
    for (let i = 0; i < 12; i++) {
      progress.captures.snapshot.scan += 256;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(failed).toBe(false);
    }
    const rejected = expect(bounded).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: {
      step: "capture-open", frames: 0, captures: progress.captures,
    } });
    // Repeating a count is silence, even when the guest keeps sending it.
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
    work.resolve(undefined);
  } finally { vi.useRealTimers(); }
});
it("cancels and joins both native openings when progress stops", async () => {
  const channel = new MessageChannel(), client = new SnapshotStorageClient(channel.port2);
  const aborted: string[] = [];
  const agent = { supportsStreamedRestore: true, syncFilesystems: async () => {}, captureWorkspace: (_id: number, format: "snapshot" | "delta", signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted.push(format); reject(new VMError("ABORTED", "native retirement acknowledged")); }, { once: true });
    }) };
  try {
    await expect(synchronizeWorkspace(agent, client, new AssistanceTraffic(7), {
      binding: { session: "11111111-2222-4333-8444-555555555555", generation: 1 }, base: "a".repeat(64),
      requestId: 1, signal: new AbortController().signal, stepMs: 20,
    })).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { step: "capture-open" } });
    expect(aborted).toEqual(["snapshot", "delta"]);
  } finally { channel.port1.close(); channel.port2.close(); }
});

it("cancels a progressing peer immediately when another capture opening fails", async () => {
  vi.useFakeTimers();
  const channel = new MessageChannel(), client = new SnapshotStorageClient(channel.port2);
  let cancelled = false;
  const agent = { supportsStreamedRestore: true, syncFilesystems: async () => {}, captureWorkspace: (_id: number, format: "snapshot" | "delta", signal: AbortSignal) => {
    if (format === "snapshot") return Promise.reject(new Error("scan failed"));
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => { cancelled = true; reject(new VMError("ABORTED", "retired")); }, { once: true });
    });
  } };
  try {
    const pending = synchronizeWorkspace(agent, client, new AssistanceTraffic(7), {
      binding: { session: "11111111-2222-4333-8444-555555555555", generation: 1 }, base: "a".repeat(64),
      requestId: 1, signal: new AbortController().signal,
    });
    const failed = expect(pending).rejects.toThrow("scan failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toBe(true);
    await failed;
  } finally { channel.port1.close(); channel.port2.close(); vi.useRealTimers(); }
});
