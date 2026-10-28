import { SnapshotStorageClient } from "./snapshot-channel.js";
import { serveSnapshotStorage } from "./snapshot-storage-server.js";
import { describe, expect, it } from "vitest";
import { richWorkspaceSnapshot } from "./workspace-snapshot.test-support.js";
import { buildWorkspaceDelta, decodeSnapshot } from "./workspace-delta.js";
import { mergeUserspaceWorkspaceDelta } from "../userspace-rootfs.js";

import {
  decodeWorkspaceOverlayManifest,
  WorkspaceStore,
  type WorkspaceStoreBackend,
} from "./workspace-store.js";

class MemoryBackend implements WorkspaceStoreBackend {
  async *list(prefix: string): AsyncGenerator<string> {
    for (const path of this.files.keys()) if (path.startsWith(prefix)) yield await Promise.resolve(path);
  }
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
  failAt: string | undefined;
  failAfterWrite: string | undefined;

  read(path: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
    return Promise.resolve(this.files.get(path)?.slice());
  }

  write(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.failAt === path) return Promise.reject(new Error(`failed ${path}`));
    this.files.set(path, bytes.slice());
    if (this.failAfterWrite === path) return Promise.reject(new Error(`uncertain ${path}`));
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    if (this.failAt === `remove:${path}`) return Promise.reject(new Error(`failed ${path}`));
    this.files.delete(path);
    return Promise.resolve();
  }
}

describe("WorkspaceStore", () => {
  const base = "a".repeat(64);

  it("recovers rich inodes and metadata-only delta generations without losing fields", async () => {
    const backend = new MemoryBackend(), store = new WorkspaceStore(backend);
    const snapshot = richWorkspaceSnapshot(), richDelta = await buildWorkspaceDelta(snapshot, [], []);
    await store.commit(base, snapshot, richDelta);
    const recovered = new WorkspaceStore(backend);
    expect(await recovered.read(base)).toEqual(snapshot);
    expect(mergeUserspaceWorkspaceDelta(new Uint8Array([79, 88, 82, 70, 5, 0, 0, 0, 0, 0, 0, 0]),
      (await recovered.readDelta(base)) ?? new Uint8Array())).toEqual(snapshot);
    const changed = snapshot.slice(); changed[46] = (changed[46] ?? 0) ^ 1;
    await recovered.commitDelta(base, await buildWorkspaceDelta(changed, [], []));
    const current = await new WorkspaceStore(backend).readDelta(base);
    expect(current).toBeDefined();
    expect(mergeUserspaceWorkspaceDelta(snapshot, current ?? new Uint8Array())).toEqual(changed);
    expect(decodeSnapshot(changed).map(entry => entry.tag)).toEqual([0, 1, 4, 2, 4, 6, 4]);
  });

  it("keeps the previous rich generation after failure before metadata publication", async () => {
    const backend = new MemoryBackend(), store = new WorkspaceStore(backend);
    const snapshot = richWorkspaceSnapshot(); await store.commit(base, snapshot);
    const changed = snapshot.slice(); changed[46] = (changed[46] ?? 0) ^ 1;
    backend.failAt = "active.json";
    await expect(store.commit(base, changed)).rejects.toThrow();
    backend.failAt = undefined;
    expect(await new WorkspaceStore(backend).readGeneration(base)).toEqual({ generation: 1, snapshot });
  });

  it.each(["snapshot", "delta"] as const)("retires cancelled legacy %s writes before releasing the writer", async kind => {
    const entered = Promise.withResolvers<undefined>();
    const retired = Promise.withResolvers<undefined>();
    class PausedBackend extends MemoryBackend {
      pause = false;
      override async write(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
        await super.write(path, bytes);
        if (this.pause && path.startsWith("blobs/")) {
          entered.resolve(undefined);
          await retired.promise;
        }
      }
    }
    const backend = new PausedBackend();
    const store = new WorkspaceStore(backend);
    const controller = new AbortController();
    const value = kind === "snapshot" ? new Uint8Array([42]) : delta([[1, "/workspace/file", "value"]]);
    const commit = (signal?: AbortSignal) => kind === "snapshot"
      ? store.commit(base, value, undefined, signal) : store.commitDelta(base, value, signal);
    backend.pause = true;
    const pending = commit(controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await entered.promise;
    controller.abort();
    await expect(commit()).rejects.toThrow("active metadata writer");
    expect(backend.files.has("active.json")).toBe(false);
    retired.resolve(undefined);
    await rejected;
    expect(backend.files.has("active.json")).toBe(false);
    expect(backend.files.has("intent.json")).toBe(false);
    backend.pause = false;
    await expect(commit()).resolves.toBe(1);
  });

  it.each(["snapshot", "delta"] as const)("preserves a confirmed legacy %s commit when cancellation arrives during publication", async kind => {
    const controller = new AbortController();
    class CancellingBackend extends MemoryBackend {
      override async write(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
        await super.write(path, bytes);
        if (path === "active.json") controller.abort();
      }
    }
    const backend = new CancellingBackend();
    const store = new WorkspaceStore(backend);
    const value = kind === "snapshot" ? new Uint8Array([42]) : delta([[1, "/workspace/file", "value"]]);
    await expect(kind === "snapshot" ? store.commit(base, value, undefined, controller.signal)
      : store.commitDelta(base, value, controller.signal)).resolves.toBe(1);
    expect(backend.files.has("intent.json")).toBe(false);
    await expect(kind === "snapshot" ? store.read(base) : store.readDelta(base)).resolves.toEqual(value);
  });

  it("does not write an already cancelled legacy capture", async () => {
    const backend = new MemoryBackend();
    const store = new WorkspaceStore(backend);
    const signal = AbortSignal.abort();
    await expect(store.commit(base, new Uint8Array([42]), undefined, signal)).rejects.toMatchObject({ code: "ABORTED" });
    await expect(store.commitDelta(base, delta([]), signal)).rejects.toMatchObject({ code: "ABORTED" });
    expect(backend.files.size).toBe(0);
  });

  it.each(["snapshot", "delta"] as const)("cancels a legacy %s read through its backend and awaits retirement", async kind => {
    const entered = Promise.withResolvers<AbortSignal | undefined>();
    const retired = Promise.withResolvers<undefined>();
    class PausedReadBackend extends MemoryBackend {
      pause = false;
      override async read(path: string, _maximum?: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
        if (this.pause && path.startsWith("blobs/")) {
          entered.resolve(signal);
          await retired.promise;
        }
        return super.read(path);
      }
    }
    const backend = new PausedReadBackend();
    const store = new WorkspaceStore(backend);
    await store.commit(base, new Uint8Array([42]), delta([]));
    backend.pause = true;
    const controller = new AbortController();
    const pending = kind === "snapshot" ? store.read(base, controller.signal) : store.readDelta(base, controller.signal);
    const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }));
    try {
      expect(await entered.promise).toBe(controller.signal);
      controller.abort();
      retired.resolve(undefined);
      expect(await outcome).toMatchObject({ error: { code: "ABORTED" } });
    } finally { retired.resolve(undefined); await outcome; }
  });

  it("reads the overlay's generation together with its snapshot", async () => {
    const store = new WorkspaceStore(new MemoryBackend());
    await expect(store.readGeneration(base)).resolves.toBeUndefined();

    await store.commit(base, new Uint8Array([1]), delta([]));
    await store.commit(base, new Uint8Array([2]), delta([]));

    await expect(store.readGeneration(base)).resolves.toEqual({ generation: 2, snapshot: new Uint8Array([2]) });
  });

  it("gives the workspace back to a fresh image's own, moving the generation on", async () => {
    const store = new WorkspaceStore(new MemoryBackend());
    await store.commit(base, new Uint8Array([1]), delta([[1, "/workspace/old", "old"]]));
    const fresh = "b".repeat(64);

    // A reset may also move to the fresh image's base.
    await expect(store.reset(fresh)).resolves.toBe(2);

    await expect(store.read(fresh)).resolves.toBeUndefined();
    expect(deltaPaths((await store.readDelta(fresh)) ?? delta([[1, "/workspace/missing", ""]]))).toEqual([]);
    // The next commit continues the generations, so a restore point from before the reset
    // cannot match the store's overlay by its number.
    await expect(store.commit(fresh, new Uint8Array([3]), delta([]))).resolves.toBe(3);
  });

  it.each(["snapshot", "delta"] as const)("fences legacy %s publication until verified reopening", async kind => {
    for (const failure of ["active", "journal"] as const) {
      const backend = new MemoryBackend();
      const store = new WorkspaceStore(backend);
      const value = kind === "snapshot" ? new Uint8Array([42]) : delta([[1, "/workspace/file", "committed"]]);
      if (failure === "active") backend.failAfterWrite = "active.json";
      else backend.failAt = "remove:intent.json";
      const commit = (owner: WorkspaceStore) => kind === "snapshot" ? owner.commit(base, value) : owner.commitDelta(base, value);
      await expect(commit(store)).rejects.toThrow();
      backend.failAfterWrite = undefined;
      backend.failAt = undefined;
      const persisted = new Map(backend.files);
      await expect(commit(store)).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: failure === "active"
        ? { reason: "workspace-publication-uncertain" }
        : { reason: "workspace-publication-cleanup-failed", committed: true, cleanupFailed: true },
      });
      expect(backend.files).toEqual(persisted);
      const reopened = new WorkspaceStore(backend);
      await expect(kind === "snapshot" ? reopened.read(base) : reopened.readDelta(base)).resolves.toEqual(value);
      expect(backend.files.has("intent.json")).toBe(false);
      await expect(commit(reopened)).resolves.toBe(1);
    }
  });

  it("commits intent, immutable blob, metadata, then journal completion", async () => {
    const backend = new MemoryBackend();
    const store = new WorkspaceStore(backend);
    const bytes = new Uint8Array([1, 2, 3]);
    const delta = new Uint8Array([4, 5]);
    await expect(store.commit(base, bytes, delta)).resolves.toBe(1);
    expect(backend.files.has("intent.json")).toBe(false);
    await expect(store.read(base)).resolves.toEqual(bytes);
    await expect(store.readDelta(base)).resolves.toEqual(delta);
    await expect(store.commit(base, bytes, delta)).resolves.toBe(1);
  });

  it("never advances active metadata when blob flush fails", async () => {
    const backend = new MemoryBackend();
    const store = new WorkspaceStore(backend);
    backend.failAt = `blobs/${"00".repeat(32)}`;
    backend.failAt = undefined;
    await store.commit(base, new Uint8Array([1]));
    const active = backend.files.get("active.json")?.slice();
    backend.failAt = "active.json";
    await expect(store.commit(base, new Uint8Array([2]))).rejects.toThrow();
    expect(backend.files.get("active.json")).toEqual(active);
    expect(backend.files.has("intent.json")).toBe(true);
  });

  it("merges delta-only commits and retains prior paths", async () => {
    const backend = new MemoryBackend();
    const store = new WorkspaceStore(backend);
    await store.commitDelta(base, delta([[1, "/workspace/first", "one"]]));
    await expect(store.read(base)).resolves.toBeUndefined();
    await store.commitDelta(base, delta([[1, "/workspace/second", "two"]]));
    const stored = await store.readDelta(base);
    expect(stored).toBeDefined();
    expect(deltaPaths(stored ?? new Uint8Array())).toEqual([
      "/workspace/first",
      "/workspace/second",
    ]);
  });

  it("rejects base mismatches, corruption, extra fields, and unsupported versions", async () => {
    const backend = new MemoryBackend();
    const store = new WorkspaceStore(backend);
    await store.commit(base, new Uint8Array([1]));
    await expect(store.read("b".repeat(64))).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      detail: { reason: "workspace-base-mismatch" },
    });
    const blob = [...backend.files.keys()].find((path) => path.startsWith("blobs/"));
    if (blob === undefined) throw new Error("missing test blob");
    backend.files.set(blob, new Uint8Array([9]));
    await expect(store.read(base)).rejects.toThrow(/corrupt/u);
    expect(() => decodeWorkspaceOverlayManifest({
      formatVersion: 2,
      generation: 1,
      workspaceBaseSha256: base,
      snapshotSha256: base,
      snapshotBytes: 0,
    })).toThrow();
    expect(() => decodeWorkspaceOverlayManifest({
      formatVersion: 1,
      generation: 1,
      workspaceBaseSha256: base,
      snapshotSha256: base,
      snapshotBytes: 0,
      extra: true,
    })).toThrow();
  });
});

function delta(entries: readonly (readonly [number, string, string])[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const encoded = entries.map(([tag, path, payload]) => ({
    tag,
    path: encoder.encode(path),
    payload: encoder.encode(payload),
  }));
  const result = new Uint8Array(encoded.reduce(
    (total, entry) => total + 12 + entry.path.byteLength + entry.payload.byteLength,
    12,
  ));
  result.set(encoder.encode("OXWD"));
  new DataView(result.buffer).setUint16(4, 1, true);
  new DataView(result.buffer).setUint32(8, encoded.length, true);
  let offset = 12;
  for (const entry of encoded) {
    result[offset] = entry.tag;
    new DataView(result.buffer).setUint16(offset + 2, 0o644, true);
    new DataView(result.buffer).setUint32(offset + 4, entry.path.byteLength, true);
    new DataView(result.buffer).setUint32(offset + 8, entry.payload.byteLength, true);
    result.set(entry.path, offset + 12);
    result.set(entry.payload, offset + 12 + entry.path.byteLength);
    offset += 12 + entry.path.byteLength + entry.payload.byteLength;
  }
  return result;
}

function deltaPaths(bytes: Uint8Array<ArrayBuffer>): readonly string[] {
  const paths: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  for (let index = 0; index < view.getUint32(8, true); index += 1) {
    const pathBytes = view.getUint32(offset + 4, true);
    const payloadBytes = view.getUint32(offset + 8, true);
    paths.push(new TextDecoder().decode(bytes.subarray(offset + 12, offset + 12 + pathBytes)));
    offset += 12 + pathBytes + payloadBytes;
  }
  return paths;
}

describe("workspace build approval policy", () => {
  const base = "a".repeat(64);
  const identity = { name: "sharp", version: "0.34.5", integrity: "sha512-" + btoa("\0".repeat(64)) };
  it("persists scoped decisions outside snapshots and replaces only the identical package decision", async () => {
    const backend = new MemoryBackend();
    const store = new WorkspaceStore(backend);
    await store.commitBuildPolicy(base, [{ ...identity, decision: "allow" }]);
    expect(backend.files.has("active.json")).toBe(false);
    const reopened = new WorkspaceStore(backend);
    expect(await reopened.readBuildPolicy(base)).toEqual([{ ...identity, decision: "allow" }]);
    const other = { ...identity, integrity: "sha512-" + btoa("a".repeat(64)), decision: "allow" as const };
    await reopened.commitBuildPolicy(base, [{ ...identity, decision: "deny" }, other]);
    expect(await reopened.readBuildPolicy(base)).toEqual([{ ...identity, decision: "deny" }, other]);
    await expect(reopened.readBuildPolicy("b".repeat(64))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  it("rejects tampered policy and preserves the previous record on cancelled or failed publication", async () => {
    const backend = new MemoryBackend();
    const store = new WorkspaceStore(backend);
    const decisions = [{ ...identity, decision: "allow" as const }];
    await store.commitBuildPolicy(base, decisions);
    const prior = backend.files.get("build-policy.json")?.slice();
    if (prior === undefined) throw new Error("missing policy");
    await expect(store.commitBuildPolicy(base, [{ ...identity, decision: "deny" }], AbortSignal.abort())).rejects.toMatchObject({ code: "ABORTED" });
    expect(backend.files.get("build-policy.json")).toEqual(prior);
    backend.failAt = "build-policy.json";
    await expect(store.commitBuildPolicy(base, [{ ...identity, decision: "deny" }])).rejects.toMatchObject({ detail: { cleanupFailed: true } });
    await expect(store.commitBuildPolicy(base, decisions)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(await new WorkspaceStore(backend).readBuildPolicy(base)).toEqual(decisions);
    backend.files.set("build-policy.json", new TextEncoder().encode(new TextDecoder().decode(prior).replace('"allow"', '"deny"')));
    await expect(new WorkspaceStore(backend).readBuildPolicy(base)).rejects.toMatchObject({ detail: { reason: "build-policy-invalid" } });
  });
});

it("round-trips build decisions through the validated storage channel", async () => {
  const store = new WorkspaceStore(new MemoryBackend());
  const ports = new MessageChannel();
  const server = serveSnapshotStorage(ports.port1, async (request, signal) => {
    if (request.type === "read-build-policy") return store.readBuildPolicy(request.workspaceBaseSha256, signal);
    if (request.type === "commit-build-policy") return store.commitBuildPolicy(request.workspaceBaseSha256, request.decisions, signal);
    throw new Error("unexpected policy operation");
  });
  const client = new SnapshotStorageClient(ports.port2);
  const base = "a".repeat(64);
  const decisions = [{ name: "package", version: "1.0.0", integrity: "sha512-" + btoa("\0".repeat(64)), decision: "allow" as const }];
  try {
    expect(await client.readBuildPolicy(base)).toEqual([]);
    await client.commitBuildPolicy(base, decisions);
    expect(await client.readBuildPolicy(base)).toEqual(decisions);
    await expect(client.commitBuildPolicy(base, decisions, AbortSignal.abort())).rejects.toMatchObject({ code: "ABORTED" });
    expect(await client.readBuildPolicy(base)).toEqual(decisions);
  } finally { client.close(); await server.close(); }
});

it.each([false, true])("recovers interrupted approval publication (previous=%s)", async previous => {
  for (const phase of ["intent", "policy", "cleanup"]) {
    class InterruptedBackend extends MemoryBackend {
      interrupt = false;
      override async write(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
        if (this.interrupt && path === (phase === "intent" ? "build-policy-intent.json" : phase === "policy" ? "build-policy.json" : "unused")) {
          this.files.set(path, phase === "intent" ? new Uint8Array() : bytes.slice(0, 17));
          throw new Error("interrupted write");
        }
        await super.write(path, bytes);
      }
      override async remove(path: string): Promise<void> {
        if (this.interrupt && phase === "cleanup" && path === "build-policy-intent.json") throw new Error("interrupted cleanup");
        await super.remove(path);
      }
    }
    const backend = new InterruptedBackend();
    const store = new WorkspaceStore(backend);
    const base = "a".repeat(64);
    const identity = { name: "package", version: "1.0.0", integrity: "sha512-" + btoa("\0".repeat(64)) };
    const allowed = [{ ...identity, decision: "allow" as const }];
    const denied = [{ ...identity, decision: "deny" as const }];
    if (previous) await store.commitBuildPolicy(base, allowed);
    backend.interrupt = true;
    await expect(store.commitBuildPolicy(base, denied)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    backend.interrupt = false;
    const reopened = new WorkspaceStore(backend);
    expect(await reopened.readBuildPolicy(base)).toEqual(phase === "cleanup" ? denied : previous ? allowed : []);
    expect(backend.files.has("build-policy-intent.json")).toBe(false);
    await reopened.commitBuildPolicy(base, denied);
    expect(await reopened.readBuildPolicy(base)).toEqual(denied);
    expect(backend.files.has("active.json")).toBe(false);
  }
});
