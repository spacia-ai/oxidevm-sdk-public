import { expect, it, vi } from "vitest";
import { workspaceBytesInput } from "./workspace-stream.js";
import { parseJson } from "./workspace-manifest.js";
import { WorkspaceStore, type WorkspaceStoreBackend } from "./workspace-store.js";
import { VMError } from "../errors.js";
import { richWorkspaceSnapshot } from "./workspace-snapshot.test-support.js";
import { buildWorkspaceDelta } from "./workspace-delta.js";

class Backend implements WorkspaceStoreBackend {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
  largestWrite = 0;
  failAt: string | undefined;
  failAfterWrite: string | undefined;
  failRemove = false;
  async *list(prefix: string): AsyncGenerator<string> {
    for (const path of this.files.keys()) if (path.startsWith(prefix)) yield await Promise.resolve(path);
  }
  read(path: string): Promise<Uint8Array<ArrayBuffer> | undefined> { return Promise.resolve(this.files.get(path)?.slice()); }
  write(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    if (path === this.failAt) return Promise.reject(new Error("injected storage failure"));
    this.largestWrite = Math.max(this.largestWrite, bytes.byteLength);
    this.files.set(path, bytes.slice());
    if (path === this.failAfterWrite) return Promise.reject(new Error("uncertain storage completion"));
    return Promise.resolve(undefined);
  }
  remove(path: string): Promise<void> {
    if (this.failRemove) return Promise.reject(new Error("injected cleanup failure"));
    this.files.delete(path); return Promise.resolve(undefined);
  }
}

const base = "a".repeat(64);
const signal = () => new AbortController().signal;
const journal = "staging/00000000-0000-4000-8000-000000000000/0";

it("reuses a captured snapshot without reading or hashing its file chunks and rejects stale references", async () => {
  const backend = new Backend(), store = new WorkspaceStore(backend);
  const snapshot = new Uint8Array(2 * 1024 * 1024 + 1).fill(7);
  const delta = new Uint8Array([1, 2, 3]);
  await store.commitStreams(base, { snapshot: workspaceBytesInput(snapshot), delta: workspaceBytesInput(delta) }, signal());
  const read = vi.spyOn(backend, "read");
  await store.commitStreams(base, { snapshot: { reuse: 1 }, delta: workspaceBytesInput(delta) }, signal());
  expect(read.mock.calls.filter(([path]) => (backend.files.get(path)?.length ?? 0) > 65536)).toEqual([]);
  await expect(store.commitStreams(base, { snapshot: { reuse: 1 }, delta: workspaceBytesInput(delta) }, signal())).rejects.toThrow(/generation/iu);
  const recovered = new WorkspaceStore(backend);
  const restored = await recovered.readGeneration(base);
  if (restored === undefined) throw new Error("Missing recovered workspace generation");
  expect(Object.keys(restored).sort()).toEqual(["generation", "snapshot"]);
  expect(restored.generation).toBe(2);
  expect(restored.snapshot).toBeInstanceOf(Uint8Array);
  expect(restored.snapshot.byteLength).toBe(snapshot.byteLength);
  // Check every byte without constructing millions of deep matcher comparisons.
  expect(restored.snapshot.every((byte, index) => byte === snapshot[index])).toBe(true);
});

it("publishes rich records through fragmented streams and recovers after uncertain publication", async () => {
  const backend = new Backend(), store = new WorkspaceStore(backend);
  const snapshot = richWorkspaceSnapshot(), delta = await buildWorkspaceDelta(snapshot, [], []);
  const input = (bytes: Uint8Array<ArrayBuffer>) => ({ bytes: bytes.length,
    source: () => producer((async function* () {
      for (let offset = 0; offset < bytes.length; offset += 7) yield await Promise.resolve(bytes.slice(offset, offset + 7));
    })()) });
  await store.commitStreams(base, { snapshot: input(snapshot), delta: input(delta) }, signal());
  const changed = snapshot.slice(); changed[46] = (changed[46] ?? 0) ^ 1;
  backend.failAfterWrite = "active.json";
  await expect(store.commitStreams(base, { snapshot: input(changed), delta: input(await buildWorkspaceDelta(changed, [], [])) }, signal())).rejects.toThrow();
  backend.failAfterWrite = undefined;
  const recovered = new WorkspaceStore(backend);
  expect(await recovered.readGeneration(base)).toEqual({ generation: 2, snapshot: changed });
  expect(await recovered.readDelta(base)).toEqual(await buildWorkspaceDelta(changed, [], []));
});

it("holds a staged dependency generation for activation without replacing the active workspace", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  const input = (byte: number) => ({ bytes: 8, source: () => producer((async function* () { yield await Promise.resolve(new Uint8Array(8).fill(byte)); })()) });
  await store.commitStreams(base, { snapshot: input(1), delta: input(2), dependencies: { inputsSha256: "b".repeat(64), tree: input(3) } }, signal());
  const original = backend.files.get("active.json")?.slice();
  const previous = await store.dependencyGeneration(base, signal());
  const staged = await store.stageStreams(base, { snapshot: input(4), delta: input(5), dependencies: { inputsSha256: "c".repeat(64), tree: input(6) } }, signal());
  expect(staged.generation).toBe(2);
  expect(backend.files.get("active.json")).toEqual(original);
  expect(backend.files.has("intent.json")).toBe(false);
  expect(await store.dependencyGeneration(base, signal())).toBe(previous);
  await expect(store.commit(base, new Uint8Array(1))).rejects.toThrow("active metadata writer");
  const candidate = staged.openRead(signal());
  expect(candidate.dependencies?.generation).not.toBe(previous);
  const source = candidate.dependencies?.tree.source(signal());
  if (source === undefined) throw new Error("missing staged tree");
  const frames: Uint8Array[] = [];
  for await (const frame of source.frames) frames.push(frame);
  expect(frames).toEqual([new Uint8Array(8).fill(6)]);
  await source.retire();
  await staged.abort();
  await staged.abort();
  await expect(staged.commit()).rejects.toMatchObject({ code: "ABORTED" });
  expect(backend.files.get("active.json")).toEqual(original);
  expect(await store.dependencyGeneration(base, signal())).toBe(previous);
  const next = await store.stageStreams(base, { snapshot: input(4), delta: input(5), dependencies: { inputsSha256: "c".repeat(64), tree: input(6) } }, signal());
  const expected = next.openRead(signal()).dependencies?.generation;
  await expect(next.commit()).resolves.toBe(2);
  await expect(next.commit()).resolves.toBe(2);
  expect(await store.dependencyGeneration(base, signal())).toBe(expected);
  expect([...backend.files.keys()].filter(path => path.startsWith("staging/"))).toEqual([]);
});

it("cancels an activation wait and discards its candidate after storage-owner loss", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  await store.commit(base, new Uint8Array([42]));
  const original = backend.files.get("active.json")?.slice();
  const controller = new AbortController();
  const staged = await store.stageStreams(base, {
    snapshot: { bytes: 7, source: () => producer(source(7)) },
    delta: { bytes: 0, source: () => producer(source(0)) },
  }, controller.signal);
  // A new storage owner sees only the durable bytes left by the lost one.
  const recovered = new Backend();
  for (const [path, bytes] of backend.files) recovered.files.set(path, bytes.slice());
  await expect(new WorkspaceStore(recovered).read(base)).resolves.toEqual(new Uint8Array([42]));
  expect(recovered.files.get("active.json")).toEqual(original);
  expect([...recovered.files.keys()].filter(path => path.startsWith("staging/") || path.startsWith("chunks/"))).toEqual([]);
  controller.abort();
  await staged.abort();
  expect(() => staged.openRead(signal())).toThrow();
  await expect(staged.commit()).rejects.toMatchObject({ code: "ABORTED" });
  await expect(store.commit(base, new Uint8Array([43]))).resolves.toBe(2);
});

it("does not publish a staged generation after another read fences the persistence owner", async () => {
  class FailedReadBackend extends Backend {
    failRead = false;
    override read(path: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
      if (this.failRead && path.startsWith("blobs/")) return Promise.reject(new VMError("STORAGE_ERROR", "read still owned", { cleanupFailed: true }));
      return super.read(path);
    }
  }
  const backend = new FailedReadBackend(); const store = new WorkspaceStore(backend);
  await store.commit(base, new Uint8Array([42]));
  const original = backend.files.get("active.json")?.slice();
  const staged = await store.stageStreams(base, {
    snapshot: { bytes: 7, source: () => producer(source(7)) }, delta: { bytes: 0, source: () => producer(source(0)) },
  }, signal());
  const previous = await store.openRead(base, signal());
  const input = previous?.snapshot?.source(signal());
  if (input === undefined || previous === undefined) throw new Error("missing previous generation");
  backend.failRead = true;
  await expect(input.frames[Symbol.asyncIterator]().next()).rejects.toMatchObject({ detail: { cleanupFailed: true } });
  await expect(previous.retire()).rejects.toMatchObject({ detail: { cleanupFailed: true } });
  await expect(staged.commit()).rejects.toMatchObject({ detail: { cleanupFailed: true } });
  expect(backend.files.get("active.json")).toEqual(original);
});

it.each(["confirmed", "uncertain"] as const)("retains staged objects and its writer through %s activation-read retirement", async outcome => {
  const started = Promise.withResolvers<undefined>();
  const interrupted = Promise.withResolvers<undefined>();
  const retired = Promise.withResolvers<undefined>();
  class WaitingBackend extends Backend {
    waiting = false;
    override async read(path: string, _maximum?: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
      if (!this.waiting || !path.startsWith("chunks/")) return super.read(path);
      const aborted = Promise.withResolvers<undefined>();
      const abort = () => { interrupted.resolve(undefined); aborted.resolve(undefined); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) abort();
      started.resolve(undefined);
      try {
        await aborted.promise; await retired.promise;
        throw outcome === "confirmed" ? new VMError("ABORTED", "read retired")
          : new VMError("STORAGE_ERROR", "read retirement uncertain", { cleanupFailed: true });
      }
      finally { signal?.removeEventListener("abort", abort); }
    }
  }
  const backend = new WaitingBackend(); const store = new WorkspaceStore(backend);
  await store.commit(base, new Uint8Array([42]));
  const original = backend.files.get("active.json")?.slice();
  const staged = await store.stageStreams(base, {
    snapshot: { bytes: 7, source: () => producer(source(7)) }, delta: { bytes: 0, source: () => producer(source(0)) },
  }, signal());
  const candidate = staged.openRead(signal());
  const input = candidate.snapshot?.source(signal());
  if (input === undefined) throw new Error("missing staged snapshot");
  backend.waiting = true;
  const pending = input.frames[Symbol.asyncIterator]().next();
  const rejected = expect(pending).rejects.toMatchObject({ code: outcome === "confirmed" ? "ABORTED" : "STORAGE_ERROR" });
  await started.promise;
  const cleanup = staged.abort();
  const completed = outcome === "confirmed" ? cleanup : expect(cleanup).rejects.toMatchObject({ detail: { cleanupFailed: true } });
  await interrupted.promise;
  expect(backend.files.get("active.json")).toEqual(original);
  expect([...backend.files.keys()].some(path => path.startsWith("staging/"))).toBe(true);
  await expect(store.commit(base, new Uint8Array([43]))).rejects.toThrow("active metadata writer");
  retired.resolve(undefined);
  await rejected; await completed;
  backend.waiting = false;
  if (outcome === "confirmed") await expect(store.commit(base, new Uint8Array([43]))).resolves.toBe(2);
  else {
    expect(backend.files.get("active.json")).toEqual(original);
    expect([...backend.files.keys()].some(path => path.startsWith("staging/"))).toBe(true);
    await expect(store.commit(base, new Uint8Array([43]))).rejects.toMatchObject({ detail: { cleanupFailed: true } });
  }
});

it.each(["buffered", "streamed"] as const)("retains confirmed %s publication when intent cleanup fails", async kind => {
  class IntentBackend extends Backend {
    failIntentCleanup = true;
    override remove(path: string): Promise<void> {
      if (path === "intent.json" && this.failIntentCleanup) return Promise.reject(new Error("intent cleanup failed"));
      return super.remove(path);
    }
  }
  const backend = new IntentBackend();
  const store = new WorkspaceStore(backend);
  const commit = () => kind === "buffered" ? store.commit(base, new Uint8Array(7)) : store.commitStreams(base, {
    snapshot: { bytes: 7, source: () => producer(source(7)) },
    delta: { bytes: 0, source: () => producer(source(0)) },
  }, signal());
  await expect(commit()).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: {
    reason: "workspace-publication-cleanup-failed", committed: true, cleanupFailed: true,
  } });
  const retained = new Map(backend.files);
  expect(backend.files.get("active.json")).toEqual(backend.files.get("intent.json"));
  await expect(commit()).rejects.toMatchObject({ detail: { committed: true } });
  expect(backend.files).toEqual(retained);
  backend.failIntentCleanup = false;
  await expect(new WorkspaceStore(backend).read(base)).resolves.toEqual(new Uint8Array(7));
  expect(backend.files.has("intent.json")).toBe(false);
  expect([...backend.files.keys()].filter(path => path.startsWith("staging/"))).toEqual([]);
});

it("opens cancellable stream producers with the publication signal", async () => {
  const backend = new Backend();
  const controller = new AbortController();
  const opened: AbortSignal[] = [];
  const input = (bytes: number) => ({ bytes, source: (signal: AbortSignal) => {
    opened.push(signal);
    return producer(source(bytes));
  } });
  await expect(new WorkspaceStore(backend).commitStreams(base, {
    snapshot: input(7), delta: input(0),
  }, controller.signal)).resolves.toBe(1);
  expect(opened).toEqual([controller.signal, controller.signal]);
});

it("cancels pending producer reads and holds the writer lease until retirement", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  await store.commit(base, new Uint8Array([42]));
  const prior = new Map(backend.files);
  const controller = new AbortController();
  const started = Promise.withResolvers<undefined>();
  const retiring = Promise.withResolvers<undefined>();
  const retired = Promise.withResolvers<undefined>();
  async function* waiting(signal: AbortSignal): AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown> {
    const read = Promise.withResolvers<undefined>();
    const abort = () => read.resolve(undefined);
    signal.addEventListener("abort", abort, { once: true });
    try {
      yield* source(1024 * 1024);
      started.resolve(undefined);
      await read.promise;
    } finally {
      signal.removeEventListener("abort", abort);
      retiring.resolve(undefined);
      await retired.promise;
    }
  }
  const pending = store.commitStreams(base, {
    snapshot: { bytes: 1024 * 1024 + 1, source: signal => producer(waiting(signal)) },
    delta: { bytes: 0, source: () => producer(source(0)) },
  }, controller.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  await started.promise;
  controller.abort();
  await retiring.promise;
  await expect(store.commit(base, new Uint8Array([43]))).rejects.toThrow("active metadata writer");
  expect([...backend.files.keys()].some(path => path.startsWith("staging/"))).toBe(true);
  retired.resolve(undefined);
  await cancelled;
  expect(backend.files).toEqual(prior);
  await expect(store.commit(base, new Uint8Array([43]))).resolves.toBe(2);
});

it("fences publication and retains staging when a rejected frame cannot retire its producer", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  await store.commit(base, new Uint8Array([42]));
  async function* broken(): AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown> {
    try {
      yield* source(1024 * 1024);
      yield new Uint8Array(65537);
    } finally { /* Retirement is acknowledged independently below. */ }
  }
  await expect(store.commitStreams(base, {
    snapshot: { bytes: 1024 * 1024 + 65537, source: () => ({ frames: broken(), retire: () => Promise.reject(new Error("producer retirement rejected")) }) },
    delta: { bytes: 0, source: () => producer(source(0)) },
  }, signal())).rejects.toMatchObject({
    code: "STORAGE_ERROR", detail: { reason: "workspace-producer-retirement-failed", cleanupFailed: true },
  });
  expect([...backend.files.keys()].some(path => path.startsWith("staging/"))).toBe(true);
  const retained = new Map(backend.files);
  await expect(store.commit(base, new Uint8Array([43]))).rejects.toThrow("producer retirement failed");
  await expect(store.read(base)).resolves.toEqual(new Uint8Array([42]));
  expect([...backend.files.keys()]).toEqual([...retained.keys()]);
  for (const [path, bytes] of retained) expect(sameBytes(backend.files.get(path), bytes), path).toBe(true);
});

it("recovers abandoned staging after restart without deleting committed chunks", async () => {
  const backend = new Backend();
  await new WorkspaceStore(backend).commitStreams(base, {
    snapshot: { bytes: 7, source: () => producer(source(7)) }, delta: { bytes: 0, source: () => producer(source(0)) },
  }, signal());
  const committed = [...backend.files.keys()].filter(path => path.startsWith("chunks/"));
  const orphan = `chunks/${"f".repeat(64)}`;
  backend.files.set(orphan, new Uint8Array([99]));
  backend.files.set(journal, new TextEncoder().encode(JSON.stringify([...committed, orphan])));
  await expect(new WorkspaceStore(backend).read(base)).resolves.toEqual(new Uint8Array(7));
  expect(backend.files.has(orphan)).toBe(false);
  expect(backend.files.has(journal)).toBe(false);
  for (const path of committed) expect(backend.files.has(path)).toBe(true);
});

it("reclaims superseded streamed generations while retaining shared content", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  const input = (bytes: number) => ({ bytes, source: () => producer(source(bytes)) });
  await store.commitStreams(base, { snapshot: input(7), delta: input(9) }, signal());
  const prior = new Set([...backend.files.keys()].filter(path => path.startsWith("chunks/")));
  await store.commitStreams(base, { snapshot: input(8), delta: input(7) }, signal());
  const removed = [...prior].filter(path => !backend.files.has(path));
  expect(removed.length).toBe(2); // Superseded data and index; snapshot reused by the new delta.
  expect([...backend.files.keys()].filter(path => path.startsWith("staging/"))).toEqual([]);
  await expect(store.read(base)).resolves.toEqual(new Uint8Array(8));
  await expect(store.readDelta(base)).resolves.toEqual(new Uint8Array(7));
});

it("journals no chunk a commit leaves in place when it reuses the snapshot", async () => {
  const backend = new Backend(), store = new WorkspaceStore(backend);
  const input = (bytes: number) => ({ bytes, source: () => producer(source(bytes)) });
  await store.commitStreams(base, { snapshot: input(3 * 1024 * 1024 + 7), delta: input(0) }, signal());
  const writes = vi.spyOn(backend, "write");
  await store.commitStreams(base, { snapshot: { reuse: 1 }, delta: input(9) }, signal());
  const written = new Set(writes.mock.calls.map(([path]) => path).filter(path => path.startsWith("chunks/")));
  const journaled = new Set(writes.mock.calls.filter(([path]) => path.startsWith("staging/"))
    .flatMap(([, bytes]) => journalPaths(bytes)));
  expect(journaled.size).toBeGreaterThan(0);
  expect([...journaled].filter(path => !written.has(path))).toEqual([]);
});

it("reclaims a replaced delta and keeps the chunks of a reused snapshot", async () => {
  const backend = new Backend(), store = new WorkspaceStore(backend);
  const input = (bytes: number) => ({ bytes, source: () => producer(source(bytes)) });
  await store.commitStreams(base, { snapshot: input(3 * 1024 * 1024 + 7), delta: input(9) }, signal());
  const prior = new Set([...backend.files.keys()].filter(path => path.startsWith("chunks/")));
  await store.commitStreams(base, { snapshot: { reuse: 1 }, delta: input(10) }, signal());
  const removed = [...prior].filter(path => !backend.files.has(path));
  expect(removed.length).toBe(2); // The replaced delta's data and index; the snapshot's chunks stay.
  expect([...backend.files.keys()].filter(path => path.startsWith("staging/"))).toEqual([]);
  await expect(store.readGeneration(base)).resolves.toMatchObject({ generation: 2 });
  await expect(store.readDelta(base)).resolves.toEqual(new Uint8Array(10));
  expect((await store.read(base))?.byteLength).toBe(3 * 1024 * 1024 + 7);
});

it("keeps the published generation when a commit over a reused snapshot fails before publication", async () => {
  const backend = new Backend(), store = new WorkspaceStore(backend);
  const input = (bytes: number) => ({ bytes, source: () => producer(source(bytes)) });
  await store.commitStreams(base, { snapshot: input(3 * 1024 * 1024 + 7), delta: input(9) }, signal());
  const published = [...backend.files.keys()].filter(path => path.startsWith("chunks/"));
  backend.failAt = "intent.json";
  await expect(store.commitStreams(base, { snapshot: { reuse: 1 }, delta: input(10) }, signal())).rejects.toThrow();
  backend.failAt = undefined;
  expect(published.filter(path => !backend.files.has(path))).toEqual([]);
  expect([...backend.files.keys()].filter(path => path.startsWith("staging/"))).toEqual([]);
  const reopened = new WorkspaceStore(backend);
  await expect(reopened.readGeneration(base)).resolves.toMatchObject({ generation: 1 });
  await expect(reopened.readDelta(base)).resolves.toEqual(new Uint8Array(9));
});

it("retains superseded objects for an active reader and reclaims them after retirement", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  const input = (bytes: number) => ({ bytes, source: () => producer(source(bytes)) });
  await store.commitStreams(base, { snapshot: input(65537), delta: input(0) }, signal());
  const prior = new Set([...backend.files.keys()].filter(path => path.startsWith("chunks/")));
  const reader = store.readStream(base, "snapshot", signal());
  expect((await reader.next()).value?.length).toBe(65536);
  await store.commitStreams(base, { snapshot: input(7), delta: input(0) }, signal());
  for (const path of prior) expect(backend.files.has(path)).toBe(true);
  expect((await reader.next()).value).toEqual(new Uint8Array([1]));
  await reader.return(undefined);
  await store.commitStreams(base, { snapshot: input(8), delta: input(0) }, signal());
  for (const path of prior) expect(backend.files.has(path)).toBe(false);
});

it("pins workspace and dependency reads to one generation before any stream starts", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  const input = (bytes: number) => ({ bytes, source: () => producer(source(bytes)) });
  await store.commitStreams(base, { snapshot: input(17), delta: input(19),
    dependencies: { inputsSha256: "b".repeat(64), tree: input(23) } }, signal());
  const dependencyGeneration = await store.dependencyGeneration(base, signal());
  const prior = [...backend.files.keys()].filter(path => path.startsWith("chunks/"));
  const lease = await store.openRead(base, signal());
  if (lease === undefined) throw new Error("missing read lease");
  expect(lease.generation).toBe(1);
  expect(lease.dependencies?.generation).toBe(dependencyGeneration);
  expect(lease.dependencies?.inputsSha256).toBe("b".repeat(64));
  await store.commitStreams(base, { snapshot: input(29), delta: input(31),
    dependencies: { inputsSha256: "c".repeat(64), tree: input(37) } }, signal());
  for (const path of prior) expect(backend.files.has(path)).toBe(true);
  for (const [input, expected] of [[lease.snapshot, 17], [lease.delta, 19], [lease.dependencies?.tree, 23]] as const) {
    if (input === undefined) throw new Error("missing stream");
    expect(input.bytes).toBe(expected);
    const reader = input.source(signal());
    const bytes: number[] = [];
    for await (const frame of reader.frames) bytes.push(...frame);
    expect(bytes).toEqual(Array.from({ length: expected }, () => 0));
    await reader.retire();
    expect(() => input.source(signal())).toThrow();
  }
  // Retiring individual producers does not release the common generation pin.
  for (const path of prior) expect(backend.files.has(path)).toBe(true);
  await lease.retire();
  await lease.retire();
  await store.commitStreams(base, { snapshot: input(41), delta: input(43) }, signal());
  for (const path of prior) expect(backend.files.has(path)).toBe(false);
});

it("releases unopened read leases on cancellation without exposing stale sources", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  const input = (bytes: number) => ({ bytes, source: () => producer(source(bytes)) });
  await store.commitStreams(base, { snapshot: input(17), delta: input(19) }, signal());
  const controller = new AbortController();
  const lease = await store.openRead(base, controller.signal);
  if (lease === undefined) throw new Error("missing read lease");
  const prior = [...backend.files.keys()].filter(path => path.startsWith("chunks/"));
  controller.abort();
  await lease.retire();
  expect(() => lease.snapshot?.source(signal())).toThrow();
  await store.commitStreams(base, { snapshot: input(29), delta: input(31) }, signal());
  for (const path of prior) expect(backend.files.has(path)).toBe(false);
});

it("fences storage when a failed read cannot prove backend retirement", async () => {
  class UncertainReadBackend extends Backend {
    uncertain = false;
    override read(path: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
      if (this.uncertain && path.startsWith("chunks/")) return Promise.reject(new VMError("STORAGE_ERROR", "read owner lost", { cleanupFailed: true }));
      return super.read(path);
    }
  }
  const backend = new UncertainReadBackend(); const store = new WorkspaceStore(backend);
  const input = (bytes: number) => ({ bytes, source: () => producer(source(bytes)) });
  await store.commitStreams(base, { snapshot: input(17), delta: input(19) }, signal());
  const lease = await store.openRead(base, signal());
  if (lease?.snapshot === undefined) throw new Error("missing lease");
  const selected = new Map(backend.files);
  backend.uncertain = true;
  const reader = lease.snapshot.source(signal());
  await expect(reader.frames[Symbol.asyncIterator]().next()).rejects.toMatchObject({ detail: { cleanupFailed: true } });
  await expect(lease.retire()).rejects.toMatchObject({ detail: { cleanupFailed: true } });
  backend.uncertain = false;
  await expect(store.commitStreams(base, { snapshot: input(29), delta: input(31) }, signal())).rejects.toMatchObject({ detail: { cleanupFailed: true } });
  expect(backend.files).toEqual(selected);
});

it("keeps legacy read leases compatible and releases failed admission without retaining objects", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  await expect(store.openRead(base, signal())).resolves.toBeUndefined();
  await store.commit(base, new Uint8Array([42]));
  const legacy = await store.openRead(base, signal());
  if (legacy?.snapshot === undefined) throw new Error("missing legacy snapshot");
  expect(legacy.dependencies).toBeUndefined();
  const reader = legacy.snapshot.source(signal());
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader.frames) chunks.push(chunk);
  expect(chunks).toEqual([new Uint8Array([42])]);
  await legacy.retire();
  const input = (bytes: number) => ({ bytes, source: () => producer(source(bytes)) });
  await store.commitStreams(base, { snapshot: input(17), delta: input(19) }, signal());
  const prior = [...backend.files.keys()].filter(path => path.startsWith("chunks/"));
  await expect(store.openRead("b".repeat(64), signal())).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  const cancelled = new AbortController(); cancelled.abort();
  await expect(store.openRead(base, cancelled.signal)).rejects.toMatchObject({ code: "ABORTED" });
  await store.commitStreams(base, { snapshot: input(29), delta: input(31) }, signal());
  for (const path of prior) expect(backend.files.has(path)).toBe(false);
});

it("preserves a confirmed commit when superseded-object reclamation fails", async () => {
  class ReclamationBackend extends Backend {
    failReclamation = false;
    override remove(path: string): Promise<void> {
      if (this.failReclamation && path.startsWith("chunks/")) return Promise.reject(new Error("reclamation failed"));
      return super.remove(path);
    }
  }
  const backend = new ReclamationBackend(); const store = new WorkspaceStore(backend);
  const input = (bytes: number) => ({ bytes, source: () => producer(source(bytes)) });
  await store.commitStreams(base, { snapshot: input(7), delta: input(0) }, signal());
  backend.failReclamation = true;
  await expect(store.commitStreams(base, { snapshot: input(8), delta: input(0) }, signal())).rejects.toMatchObject({
    code: "STORAGE_ERROR", detail: { reason: "workspace-reclamation-failed", committed: true },
  });
  await expect(store.read(base)).resolves.toEqual(new Uint8Array(8));
  await expect(store.commitStreams(base, { snapshot: input(9), delta: input(0) }, signal())).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  backend.failReclamation = false;
  const reopened = new WorkspaceStore(backend);
  await expect(reopened.read(base)).resolves.toEqual(new Uint8Array(8));
  expect([...backend.files.keys()].filter(path => path.startsWith("staging/"))).toEqual([]);
});

it("propagates restore cancellation into backend reads before yielding a frame", async () => {
  const reading = Promise.withResolvers<undefined>();
  class BlockedBackend extends Backend {
    block = false;
    override async read(path: string, _maximumBytes?: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
      if (this.block && path.startsWith("chunks/")) {
        if (signal === undefined) throw new Error("missing read cancellation signal");
        await new Promise<void>(resolve => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          reading.resolve(undefined);
        });
      }
      return super.read(path);
    }
  }
  const backend = new BlockedBackend(); const store = new WorkspaceStore(backend);
  await store.commitStreams(base, {
    snapshot: { bytes: 7, source: () => producer(source(7)) }, delta: { bytes: 0, source: () => producer(source(0)) },
  }, signal());
  backend.block = true;
  const controller = new AbortController();
  const reader = store.readStream(base, "snapshot", controller.signal);
  const cancelled = expect(reader.next()).rejects.toMatchObject({ code: "ABORTED" });
  await reading.promise;
  controller.abort();
  await cancelled;
});

it("fences unresolved publication on restart and retains its ownership records", async () => {
  const backend = new Backend();
  await new WorkspaceStore(backend).commit(base, new Uint8Array([42]));
  backend.failAt = "active.json";
  await expect(new WorkspaceStore(backend).commitStreams(base, {
    snapshot: { bytes: 7, source: () => producer(source(7)) }, delta: { bytes: 0, source: () => producer(source(0)) },
  }, signal())).rejects.toThrow();
  backend.failAt = undefined;
  const prior = new Map(backend.files);
  const reopened = new WorkspaceStore(backend);
  await expect(reopened.read(base)).resolves.toEqual(new Uint8Array([42]));
  await expect(reopened.commit(base, new Uint8Array([43]))).rejects.toMatchObject({
    code: "STORAGE_ERROR", detail: { reason: "workspace-publication-uncertain" },
  });
  expect(backend.files).toEqual(prior);
  expect([...backend.files.keys()].some(path => path.startsWith("staging/"))).toBe(true);
});

it("rejects corrupt staging paths before deleting objects during restart", async () => {
  const backend = new Backend();
  await new WorkspaceStore(backend).commit(base, new Uint8Array([42]));
  backend.files.set(journal, new TextEncoder().encode(JSON.stringify(["active.json"])));
  const prior = new Map(backend.files);
  await expect(new WorkspaceStore(backend).read(base)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  expect(backend.files).toEqual(prior);
});
function producer(frames: AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown>) {
  let retirement: Promise<void> | undefined;
  return { frames, retire: () => retirement ??= frames.return().then(() => undefined) };
}

async function* source(bytes: number): AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown> {
  for (let offset = 0; offset < bytes; offset += 65536) {
    yield await Promise.resolve(new Uint8Array(Math.min(65536, bytes - offset)).fill((offset / 65536) % 251));
  }
}

it("persists staging ownership before writing the first chunk of a partial metadata page", async () => {
  class ObservedBackend extends Backend {
    override write(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
      if (path.startsWith("chunks/")) {
        const pages = [...this.files.entries()].filter(([name]) => name.startsWith("staging/"));
        expect(pages.some(([, content]) => {
          const paths: unknown = JSON.parse(new TextDecoder().decode(content));
          return Array.isArray(paths) && paths.includes(path);
        })).toBe(true);
      }
      return super.write(path, bytes);
    }
  }
  const backend = new ObservedBackend();
  await new WorkspaceStore(backend).commitStreams(base, {
    snapshot: { bytes: 7, source: () => producer(source(7)) }, delta: { bytes: 0, source: () => producer(source(0)) },
  }, signal());
  expect([...backend.files.keys()].filter(path => path.startsWith("staging/"))).toEqual([]);
});

it("persists and verifies a workspace larger than the legacy ceiling with bounded chunks", async () => {
  const backend = new Backend();
  const store = new WorkspaceStore(backend);
  const bytes = 129 * 1024 * 1024 + 17;
  await store.commitStreams(base, { snapshot: { bytes, source: () => producer(source(bytes)) }, delta: { bytes: 0, source: () => producer(source(0)) } }, signal());
  expect(backend.largestWrite).toBeLessThanOrEqual(1024 * 1024);
  const reopened = new WorkspaceStore(backend);
  let received = 0;
  for await (const chunk of reopened.readStream(base, "snapshot", signal())) {
    expect(chunk.length).toBeLessThanOrEqual(65536);
    const expected = Math.floor(received / 65536) % 251;
    if (!chunk.every(byte => byte === expected)) throw new Error("workspace contents changed");
    received += chunk.length;
  }
  expect(received).toBe(bytes);
  await expect(reopened.read(base)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
}, 30_000);

it("does not select incomplete streams or a failed metadata commit", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  await store.commit(base, new Uint8Array([42]));
  const active = backend.files.get("active.json")?.slice();
  for (const bytes of [1, 3]) {
    await expect(store.commitStreams(base, { snapshot: { bytes, source: () => producer(source(2)) }, delta: { bytes: 0, source: () => producer(source(0)) } }, signal())).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(backend.files.get("active.json")).toEqual(active);
  }
  backend.failAt = "active.json";
  await expect(store.commitStreams(base, { snapshot: { bytes: 2, source: () => producer(source(2)) }, delta: { bytes: 0, source: () => producer(source(0)) } }, signal())).rejects.toThrow("injected storage failure");
  expect(backend.files.get("active.json")).toEqual(active);
  await expect(store.read(base)).resolves.toEqual(new Uint8Array([42]));
});

it("retains reachable chunks and fences writes after uncertain publication", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  await store.commit(base, new Uint8Array([42]));
  backend.failAfterWrite = "active.json";
  await expect(store.commitStreams(base, { snapshot: { bytes: 7, source: () => producer(source(7)) }, delta: { bytes: 0, source: () => producer(source(0)) } }, signal())).rejects.toHaveProperty("detail", { reason: "workspace-publication-uncertain" });
  backend.failAfterWrite = undefined;
  await expect(new WorkspaceStore(backend).read(base)).resolves.toEqual(new Uint8Array(7));
  expect(backend.files.has("intent.json")).toBe(false);
  expect([...backend.files.keys()].some(path => path.startsWith("staging/"))).toBe(false);
  await expect(store.commitStreams(base, { snapshot: { bytes: 8, source: () => producer(source(8)) }, delta: { bytes: 0, source: () => producer(source(0)) } }, signal())).rejects.toMatchObject({ code: "STORAGE_ERROR" });
});

it("removes an unselected publication intent when cancelled before commitment", async () => {
  const controller = new AbortController();
  class CancelledBackend extends Backend {
    override async write(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
      await super.write(path, bytes);
      if (path === "intent.json") controller.abort();
    }
  }
  const backend = new CancelledBackend();
  await expect(new WorkspaceStore(backend).commitStreams(base, {
    snapshot: { bytes: 7, source: () => producer(source(7)) }, delta: { bytes: 0, source: () => producer(source(0)) },
  }, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
  expect(backend.files.size).toBe(0);
  await expect(new WorkspaceStore(backend).commitStreams(base, {
    snapshot: { bytes: 7, source: () => producer(source(7)) }, delta: { bytes: 0, source: () => producer(source(0)) },
  }, signal())).resolves.toBe(1);
});

it("cancellation during staging preserves the selected workspace", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  await store.commit(base, new Uint8Array([42]));
  const controller = new AbortController();
  async function* aborted(): AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown> {
    for (let index = 0; index < 16; index++) yield await Promise.resolve(new Uint8Array(65536));
    controller.abort(); yield new Uint8Array(65536);
  }
  await expect(store.commitStreams(base, { snapshot: { bytes: 17 * 65536, source: () => producer(aborted()) }, delta: { bytes: 0, source: () => producer(source(0)) } }, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
  await expect(store.read(base)).resolves.toEqual(new Uint8Array([42]));
  expect([...backend.files.keys()].filter(path => path.startsWith("chunks/"))).toEqual([]);
});

it("checks content hashes before yielding restored bytes and rejects legacy downgrade", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  await store.commitStreams(base, { snapshot: { bytes: 7, source: () => producer(source(7)) }, delta: { bytes: 0, source: () => producer(source(0)) } }, signal());
  await expect(store.commit(base, new Uint8Array([9]))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  const chunk = [...backend.files.keys()].find(path => path.startsWith("chunks/"));
  if (chunk === undefined) throw new Error("missing stored chunk");
  backend.files.set(chunk, new Uint8Array(7).fill(9));
  const reader = store.readStream(base, "snapshot", signal());
  await expect(reader.next()).rejects.toMatchObject({ code: "STORAGE_ERROR" });
});

it("keeps a streamed overlay streamed when Userspace commits its files and delta over it", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  // System wrote the workspace out as streams, with an assisted dependency tree.
  await store.commitStreams(base, {
    snapshot: { bytes: 7, source: () => producer(source(7)) },
    delta: { bytes: 0, source: () => producer(source(0)) },
    dependencies: { inputsSha256: "b".repeat(64), tree: { bytes: 3, source: () => producer(source(3)) } },
  }, signal());
  const dependencies = await store.dependencyGeneration(base, signal());
  const snapshot = new Uint8Array(70_000).fill(5);
  const delta = new Uint8Array([7, 7]);

  await expect(store.commit(base, snapshot, delta)).resolves.toBe(2);

  const active: unknown = JSON.parse(new TextDecoder().decode(backend.files.get("active.json")));
  expect(active).toMatchObject({ formatVersion: 2, generation: 2 });
  expect(await store.readGeneration(base)).toEqual({ generation: 2, snapshot });
  expect(await store.readDelta(base)).toEqual(delta);
  expect(await store.dependencyGeneration(base, signal())).toBe(dependencies);
});

it("preserves cancellation and fences the owner when staging cleanup fails", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  const controller = new AbortController();
  async function* cancelled(): AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown> {
    for (let index = 0; index < 16; index++) yield await Promise.resolve(new Uint8Array(65536));
    backend.failRemove = true; controller.abort();
  }
  await expect(store.commitStreams(base, { snapshot: { bytes: 1024 * 1024, source: () => producer(cancelled()) }, delta: { bytes: 0, source: () => producer(source(0)) } }, controller.signal)).rejects.toMatchObject({ code: "ABORTED", detail: { cleanupFailed: true } });
  backend.failRemove = false;
  await expect(store.commit(base, new Uint8Array([42]))).rejects.toMatchObject({ code: "ABORTED", detail: { cleanupFailed: true } });
  expect(backend.files.has("active.json")).toBe(false);
});

it("rejects oversize input frames and concurrent metadata writers", async () => {
  const backend = new Backend(); const store = new WorkspaceStore(backend);
  async function* large(): AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown> { yield await Promise.resolve(new Uint8Array(65537)); }
  await expect(store.commitStreams(base, { snapshot: { bytes: 65537, source: () => producer(large()) }, delta: { bytes: 0, source: () => producer(source(0)) } }, signal())).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  let release: (() => void) | undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  async function* blocked(): AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown> { await barrier; yield new Uint8Array(1); }
  const pending = store.commitStreams(base, { snapshot: { bytes: 1, source: () => producer(blocked()) }, delta: { bytes: 0, source: () => producer(source(0)) } }, signal());
  await expect(store.commit(base, new Uint8Array([3]))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  release?.(); await pending;
});

it("commits dependency identity with workspace state and preserves it across source commits", async () => {
  const backend = new Backend();
  const store = new WorkspaceStore(backend);
  const streams = {
    snapshot: { bytes: 7, source: () => producer(source(7)) },
    delta: { bytes: 0, source: () => producer(source(0)) },
  };
  await store.commitStreams(base, { ...streams, dependencies: {
    inputsSha256: "b".repeat(64), tree: { bytes: 65_537, source: () => producer(source(65_537)) },
  } }, signal());
  const generation = await store.dependencyGeneration(base, signal());
  expect(generation).toMatch(/^[a-f0-9]{64}$/u);
  await store.commitStreams(base, streams, signal());
  const reopened = new WorkspaceStore(backend);
  expect(await reopened.dependencyGeneration(base, signal())).toBe(generation);
  let count = 0;
  for await (const bytes of reopened.readStream(base, "dependencies", signal())) count += bytes.length;
  expect(count).toBe(65_537);
  const committed = backend.files.get("active.json")?.slice();
  backend.failAt = "active.json";
  await expect(store.commitStreams(base, { ...streams, dependencies: {
    inputsSha256: "c".repeat(64), tree: { bytes: 3, source: () => producer(source(3)) },
  } }, signal())).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  expect(backend.files.get("active.json")).toEqual(committed);
  await expect(new WorkspaceStore(backend).dependencyGeneration(base, signal())).rejects.toMatchObject({
    code: "STORAGE_ERROR", detail: { reason: "workspace-publication-uncertain" },
  });
});

it("rejects altered dependency identities before preserving them in another commit", async () => {
  const backend = new Backend();
  const store = new WorkspaceStore(backend);
  const streams = {
    snapshot: { bytes: 0, source: () => producer(source(0)) },
    delta: { bytes: 0, source: () => producer(source(0)) },
  };
  await store.commitStreams(base, { ...streams, dependencies: {
    inputsSha256: "b".repeat(64), tree: { bytes: 1, source: () => producer(source(1)) },
  } }, signal());
  const active = backend.files.get("active.json");
  if (active === undefined) throw new Error("missing active manifest");
  backend.files.set("active.json", new TextEncoder().encode(new TextDecoder().decode(active)
    .replace("b".repeat(64), "c".repeat(64))));
  const before = new Map(backend.files);
  await expect(store.commitStreams(base, streams, signal())).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  expect(backend.files).toEqual(before);
  await expect(new WorkspaceStore(backend).dependencyGeneration(base, signal())).rejects.toMatchObject({ code: "STORAGE_ERROR" });
});

it("binds dependency generations to both input identity and immutable tree bytes", async () => {
  const backend = new Backend();
  const store = new WorkspaceStore(backend);
  const generations = new Set<string>();
  for (const [inputsSha256, bytes] of [["b".repeat(64), 1], ["c".repeat(64), 1], ["c".repeat(64), 2]] as const) {
    await store.commitStreams(base, {
      snapshot: { bytes: 0, source: () => producer(source(0)) },
      delta: { bytes: 0, source: () => producer(source(0)) },
      dependencies: { inputsSha256, tree: { bytes, source: () => producer(source(bytes)) } },
    }, signal());
    const generation = await store.dependencyGeneration(base, signal());
    if (generation === undefined) throw new Error("missing dependency generation");
    generations.add(generation);
  }
  expect(generations.size).toBe(3);
  // Only the final tree and its metadata page remain reachable.
  expect([...backend.files.keys()].filter(path => path.startsWith("chunks/"))).toHaveLength(2);
});

it("preserves confirmed dependency selection when publication cleanup fails", async () => {
  class IntentBackend extends Backend {
    override remove(path: string): Promise<void> {
      if (path === "intent.json" && this.failRemove) return Promise.reject(new Error("intent cleanup failed"));
      return super.remove(path);
    }
  }
  const backend = new IntentBackend();
  backend.failRemove = true;
  await expect(new WorkspaceStore(backend).commitStreams(base, {
    snapshot: { bytes: 0, source: () => producer(source(0)) },
    delta: { bytes: 0, source: () => producer(source(0)) },
    dependencies: { inputsSha256: "b".repeat(64), tree: { bytes: 13, source: () => producer(source(13)) } },
  }, signal())).rejects.toMatchObject({ detail: { committed: true, cleanupFailed: true } });
  backend.failRemove = false;
  const reopened = new WorkspaceStore(backend);
  expect(await reopened.dependencyGeneration(base, signal())).toMatch(/^[a-f0-9]{64}$/u);
  const reader = reopened.readStream(base, "dependencies", signal());
  expect((await reader.next()).value).toHaveLength(13);
  await reader.return();
  expect(backend.files.has("intent.json")).toBe(false);
});

it("retires every attached publication producer when the first stream fails", async () => {
  const backend = new Backend();
  const retired: string[] = [];
  const input = (name: string) => ({ bytes: 1, source: () => ({
    frames: source(name === "snapshot" ? 2 : 1),
    retire: () => { retired.push(name); return Promise.resolve(); },
  }) });
  await expect(new WorkspaceStore(backend).commitStreams(base, {
    snapshot: input("snapshot"), delta: input("delta"),
    dependencies: { inputsSha256: "b".repeat(64), tree: input("dependencies") },
  }, signal())).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  expect(retired.sort()).toEqual(["delta", "dependencies", "snapshot"]);
  expect(backend.files.has("active.json")).toBe(false);
});

it("retires attached producers when publication fails before staging", async () => {
  const backend = new Backend();
  backend.files.set("active.json", new TextEncoder().encode("corrupt"));
  let retired = 0;
  const input = { bytes: 0, source: () => ({ frames: source(0),
    retire: () => { retired += 1; return Promise.resolve(); },
  }) };
  await expect(new WorkspaceStore(backend).commitStreams(base, {
    snapshot: input, delta: input, dependencies: { inputsSha256: base, tree: input },
  }, signal())).rejects.toThrow();
  expect(retired).toBe(3);
});

it("retiring a rejected publication does not release another publication's writer lease", async () => {
  const store = new WorkspaceStore(new Backend());
  const entered = Promise.withResolvers<undefined>();
  const finish = Promise.withResolvers<undefined>();
  const first = store.commitStreams(base, {
    snapshot: { bytes: 1, source: () => ({
      frames: (async function* () { entered.resolve(undefined); await finish.promise; yield new Uint8Array([1]); })(),
      retire: () => Promise.resolve(),
    }) }, delta: { bytes: 0, source: () => producer(source(0)) },
  }, signal());
  await entered.promise;
  let retired = 0;
  const empty = { bytes: 0, source: () => ({ frames: source(0),
    retire: () => { retired += 1; return Promise.resolve(); },
  }) };
  try {
    await expect(store.commitStreams(base, { snapshot: empty, delta: empty }, signal())).rejects.toThrow("active metadata writer");
    expect(retired).toBe(2);
    await expect(store.commit(base, new Uint8Array([2]))).rejects.toThrow("active metadata writer");
  } finally { finish.resolve(undefined); }
  await expect(first).resolves.toBe(1);
  await expect(store.read(base)).resolves.toEqual(new Uint8Array([1]));
});

/** The chunk paths a staging journal page names. A page is a JSON array of path strings. */
function journalPaths(bytes: Uint8Array): string[] {
  const value = parseJson(bytes);
  if (!isPathList(value)) throw new Error("staging journal page is not a path list");
  return value;
}

function isPathList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

/** Byte equality without vitest's per-element deep comparison, which takes seconds per MiB. */
function sameBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return left?.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
