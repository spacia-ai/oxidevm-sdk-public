import { expect, it, vi } from "vitest";
import { VMError } from "../errors.js";
import { WORKSPACE_PUBLICATION_BYTES } from "../protocol/workspace-publication.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import { SnapshotStorageClient } from "./snapshot-channel.js";
import { serveSnapshotStorage } from "./snapshot-storage-server.js";
import { WorkspacePublications } from "./workspace-publication.js";
import { openWorkspaceRead } from "./workspace-read-client.js";
import { WorkspaceStore, type WorkspaceStoreBackend } from "./workspace-store.js";
import type { WorkspaceStreamInput } from "./workspace-stream.js";
import { restoreStoredWorkspace } from "./control/workspace-restore.js";
import { AgentRestore } from "./control/agent-restore.js";
import { decodeFilesystemRecord, encodeFilesystemRecord } from "../userspace-rootfs-record.js";
import { mergeUserspaceWorkspaceDelta, mergeUserspaceWorkspaceSnapshot } from "../userspace-rootfs.js";
import { workspaceBytesInput } from "./workspace-stream.js";

const base = "a".repeat(64);
const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
const signal = () => new AbortController().signal;
function stream(bytes: number, fill = 7): WorkspaceStreamInput {
  return { bytes, source: () => {
    const frames = (async function* () {
      for (let offset = 0; offset < bytes; offset += 65536) yield await Promise.resolve(new Uint8Array(Math.min(65536, bytes - offset)).fill(fill));
    })();
    return { frames, retire: async () => { await frames.return(undefined); } };
  } };
}

function fixture(selected?:Parameters<WorkspacePublications["openRead"]>[3]) {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const entered = Promise.withResolvers<undefined>();
  const failure: { read?: "cancel" | "uncertain" } = {};
  const backend: WorkspaceStoreBackend = {
    list: async function* (prefix) { for (const path of files.keys()) if (path.startsWith(prefix)) yield await Promise.resolve(path); },
    read: async (path, _max, signal) => {
      if (path.startsWith("chunks/") && failure.read !== undefined) {
        entered.resolve(undefined);
        if (failure.read === "uncertain") throw new VMError("STORAGE_ERROR", "read owner lost", { cleanupFailed: true });
        await new Promise<void>(resolve => {
          if (signal?.aborted === true) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new VMError("ABORTED", "read cancelled");
      }
      return files.get(path)?.slice();
    },
    write: (path, bytes) => { files.set(path, bytes.slice()); return Promise.resolve(); },
    remove: path => { files.delete(path); return Promise.resolve(); },
  };
  const store = new WorkspaceStore(backend);
  const owner = new WorkspacePublications();
  const channel = new MessageChannel();
  let queue = Promise.resolve<unknown>(undefined);
  const server = serveSnapshotStorage(channel.port1, (request, signal) => {
    const work = queue.then<unknown>(() => {
      if (request.type === "open-workspace-read") return owner.openRead(store, request.input, signal,selected);
      if (request.type === "read-workspace-frame") return owner.read(request.identity, request.source, request.offset, signal);
      if (request.type === "retire-workspace-source") return owner.retireReadSource(request.identity, request.source);
      if (request.type === "retire-workspace-read") return owner.retireRead(request.identity);
      throw new Error("Unexpected storage operation");
    });
    queue = work.catch(() => {});
    return work;
  }, () => owner.closeRead());
  const client = new SnapshotStorageClient(channel.port2);
  const traffic = new AssistanceTraffic(7);
  const credit = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
  return { store, files, owner, client, server, traffic, credit, failure, entered,
    close: async () => { client.close(); await server.close().catch(() => {}); } };
}

it("reads over 128 MiB through bounded storage messages and retires before returning its VM grant", async () => {
  const f = fixture();
  const bytes = 129 * 1024 * 1024 + 17;
  await f.store.commitStreams(base, { snapshot: stream(bytes), delta: stream(12), dependencies: { inputsSha256: "b".repeat(64), tree: stream(33) } }, signal());
  try {
    const read = await openWorkspaceRead(f.client, { workspaceBaseSha256: base, credit: f.credit }, signal());
    const selection = read.selection;
    expect(selection).toMatchObject({ generation: 1, dependencies: { inputsSha256: "b".repeat(64) } });
    if (selection?.snapshot === undefined) throw new Error("snapshot missing");
    const producer = selection.snapshot.source(signal());
    let received = 0;
    for await (const frame of producer.frames) {
      expect(frame.length).toBeLessThanOrEqual(65536);
      expect(frame[0]).toBe(7);
      received += frame.length;
    }
    expect(received).toBe(bytes);
    await producer.retire();
    expect(f.traffic.pendingBytes).toBe(WORKSPACE_PUBLICATION_BYTES);
    const returned = await read.retire();
    expect(await read.retire()).toEqual(returned);
    f.traffic.returnCredit(returned);
    expect(f.traffic.pendingBytes).toBe(0);
    expect(() => f.owner.read({ ...binding, transfer: f.credit.reservation }, "snapshot", 0, signal())).toThrow();
  } finally { await f.close(); }
}, 30_000);

it.each(["cancel", "uncertain"] as const)("retains retirement truth after a %s backend read", async failure => {
  const f = fixture();
  await f.store.commitStreams(base, { snapshot: stream(100), delta: stream(12) }, signal());
  try {
    const read = await openWorkspaceRead(f.client, { workspaceBaseSha256: base, credit: f.credit }, signal());
    const controller = new AbortController();
    f.failure.read = failure;
    const producer = read.selection?.snapshot?.source(controller.signal);
    if (producer === undefined) throw new Error("snapshot missing");
    const next = producer.frames[Symbol.asyncIterator]().next();
    const rejected = expect(next).rejects.toMatchObject({ code: failure === "cancel" ? "ABORTED" : "STORAGE_ERROR" });
    await f.entered.promise;
    if (failure === "cancel") controller.abort();
    await rejected;
    if (failure === "cancel") {
      await producer.retire();
      f.traffic.returnCredit(await read.retire());
      expect(f.traffic.pendingBytes).toBe(0);
    } else {
      await expect(read.retire()).rejects.toMatchObject({ detail: { cleanupFailed: true } });
      expect(f.traffic.pendingBytes).toBe(WORKSPACE_PUBLICATION_BYTES);
      await expect(f.owner.closeRead()).rejects.toMatchObject({ detail: { cleanupFailed: true } });
      expect(() => f.owner.assertActive()).toThrow("reopen the VM");
    }
  } finally { await f.close(); }
});

it("connects snapshot and large stored delta to authenticated guest restore before releasing capacity", async () => {
  const f = fixture();
  f.traffic.returnCredit({ ...f.credit, kind: "return" });
  const bytes = 129 * 1024 * 1024 + 17;
  await f.store.commitStreams(base, { snapshot: stream(12), delta: stream(bytes, 5) }, signal());
  let received = 0;
  let commits = 0;
  const targets: unknown[] = [];
  const restore = new AgentRestore((_request, format, length) => {
    targets.push(format);
    expect(length).toBe(format === "snapshot" ? 12 : bytes);
    let offset = 0;
    return { transfer: 17, ready: Promise.resolve("receive" as const), status: () => Promise.resolve({ state: "done" as const, applied: 0, total: 0 }), send: async (_request, operation) => {
      if (operation.kind === "chunk") {
        // Several chunk sends are in flight at once, so advance the expected offset before
        // awaiting anything.
        expect(operation.offset).toBe(offset);
        offset += operation.data.length;
        if (format === "delta") received += operation.data.length;
        expect(operation.data.length).toBeLessThanOrEqual(65536);
        expect(operation.data[0]).toBe(format === "snapshot" ? 7 : 5);
        expect(operation.sha256).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(operation.data))));
      } else if (operation.kind === "commit") {
        expect(offset).toBe(length);
        expect(f.traffic.pendingBytes).toBe(WORKSPACE_PUBLICATION_BYTES);
        commits += 1;
      } else throw new Error("unexpected guest abort");
    } };
  }, error => { throw error; });
  try {
    const restored = await restoreStoredWorkspace({ supportsStreamedRestore: true, applyWorkspaceStream: (id, format, source) => restore.apply(id, format, source) },
      f.client, f.traffic, { binding, base, requestId: 7, signal: signal() });
    expect(restored).toBe(true);
    expect(commits).toBe(2);
    expect(targets).toEqual(["snapshot", "delta"]);
    expect(received).toBe(bytes);
    expect(f.traffic.pendingBytes).toBe(0);
  } finally { await f.close(); }
}, 30_000);

it("restores workspace and its selected dependency generation before releasing storage ownership", async () => {
  const f = fixture();
  f.traffic.returnCredit({ ...f.credit, kind: "return" });
  await f.store.commitStreams(base, { snapshot: stream(12), delta: stream(12), dependencies: { inputsSha256: "b".repeat(64), tree: stream(12) } }, signal());
  const before = await f.store.dependencyGeneration(base, signal());
  const targets: unknown[] = [];
  try {
    await expect(restoreStoredWorkspace({ supportsStreamedRestore: true, applyWorkspaceStream: async (_id, target, input) => {
      targets.push(target);
      expect(f.traffic.pendingBytes).toBe(WORKSPACE_PUBLICATION_BYTES);
      const producer = input.source(signal());
      let bytes = 0;
      for await (const frame of producer.frames) bytes += frame.byteLength;
      await producer.retire();
      expect(bytes).toBe(12);
    } }, f.client, f.traffic, { binding, base, requestId: 7, signal: signal() })).resolves.toBe(true);
    expect(targets).toEqual(["snapshot", "delta", { kind: "dependencies", generation: Uint8Array.from(Buffer.from(before ?? "", "hex")), inputs: new Uint8Array(32).fill(0xbb) }]);
    expect(f.traffic.pendingBytes).toBe(0);
    expect(await f.store.dependencyGeneration(base, signal())).toBe(before);
  } finally { await f.close(); }
});

it.each(["legacy-empty", "legacy-incremental", "streamed"] as const)("preserves snapshot-only files before applying a %s delta", async mode => {
  const f = fixture();
  f.traffic.returnCredit({ ...f.credit, kind: "return" });
  const encoder = new TextEncoder();
  const entry = (path: string, tag: 0 | 1, text = "") => ({ pathText: path, path: encoder.encode(path), tag,
    mode: tag === 0 ? 0o755 : 0o600, payload: encoder.encode(text) });
  const snapshot = encodeFilesystemRecord([entry("/workspace", 0), entry("/workspace/saved", 1, "saved only in snapshot")], "rootfs");
  const delta = encodeFilesystemRecord(mode === "legacy-empty" ? [] : [entry("/workspace/new", 1, "incremental")], "delta");
  if (mode === "streamed") await f.store.commitStreams(base, { snapshot: workspaceBytesInput(snapshot), delta: workspaceBytesInput(delta) }, signal());
  else {
    await f.store.commit(base, snapshot);
    await f.store.commitDelta(base, delta);
  }
  let mounted = encodeFilesystemRecord([entry("/workspace", 0)], "rootfs");
  const targets: unknown[] = [];
  try {
    await restoreStoredWorkspace({ supportsStreamedRestore: true, applyWorkspaceStream: async (_id, kind, input) => {
      targets.push(kind);
      const source = input.source(signal());
      const frames: Uint8Array<ArrayBuffer>[] = [];
      for await (const frame of source.frames) frames.push(frame);
      await source.retire();
      const bytes = new Uint8Array(input.bytes);
      let offset = 0;
      for (const frame of frames) { bytes.set(frame, offset); offset += frame.length; }
      if (kind === "snapshot") mounted = mergeUserspaceWorkspaceSnapshot(mounted, bytes);
      else if (kind === "delta") mounted = mergeUserspaceWorkspaceDelta(mounted, bytes);
      else throw new Error("Unexpected dependencies");
    } }, f.client, f.traffic, { binding, base, requestId: 7, signal: signal() });
    const files = new Map(decodeFilesystemRecord(mounted, "rootfs").map(entry => [entry.pathText, entry.payload]));
    expect(files.get("/workspace/saved")).toEqual(encoder.encode("saved only in snapshot"));
    if (mode !== "legacy-empty") expect(files.get("/workspace/new")).toEqual(encoder.encode("incremental"));
    expect(targets).toEqual(["snapshot", "delta"]);
    expect(f.traffic.pendingBytes).toBe(0);
  } finally { await f.close(); }
});

it("does not let stale identities or offsets consume the selected stream", async () => {
  const f = fixture();
  await f.store.commitStreams(base, { snapshot: stream(100), delta: stream(12) }, signal());
  try {
    const read = await openWorkspaceRead(f.client, { workspaceBaseSha256: base, credit: f.credit }, signal());
    const identity = { ...binding, transfer: f.credit.reservation };
    for (const patch of [{ generation: 2 }, { transfer: identity.transfer + 1 }]) {
      await expect(f.client.request({ type: "read-workspace-frame", identity: { ...identity, ...patch }, source: "snapshot", offset: 0 })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    }
    await expect(f.client.request({ type: "read-workspace-frame", identity, source: "snapshot", offset: 1 })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    const producer = read.selection?.snapshot?.source(signal());
    if (producer === undefined) throw new Error("snapshot missing");
    const frames = [];
    for await (const frame of producer.frames) frames.push(frame);
    expect(frames).toEqual([new Uint8Array(100).fill(7)]);
    f.traffic.returnCredit(await read.retire());
    await expect(f.client.request({ type: "retire-workspace-read", identity })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(f.traffic.pendingBytes).toBe(0);
  } finally { await f.close(); }
});

it("confirms read admission cleanup before reporting a base mismatch", async () => {
  const f = fixture();
  await f.store.commitStreams(base, { snapshot: stream(100), delta: stream(12) }, signal());
  try {
    await expect(openWorkspaceRead(f.client, { workspaceBaseSha256: "c".repeat(64), credit: f.credit }, signal()))
      .rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { readRetired: true } });
    f.traffic.returnCredit({ ...f.credit, kind: "return" });
    expect(f.traffic.pendingBytes).toBe(0);
    f.owner.assertActive();
    await expect(f.store.commitStreams(base, { snapshot: stream(11), delta: stream(12) }, signal())).resolves.toBe(2);
  } finally { await f.close(); }
});

it("releases the pinned generation on storage-channel retirement without returning an unacknowledged grant", async () => {
  const f = fixture();
  await f.store.commitStreams(base, { snapshot: stream(100), delta: stream(12) }, signal());
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(100).fill(7)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  try {
    await openWorkspaceRead(f.client, { workspaceBaseSha256: base, credit: f.credit }, signal());
    await f.store.commitStreams(base, { snapshot: stream(100, 8), delta: stream(12) }, signal());
    expect(f.files.has(`chunks/${hash}`)).toBe(true);
    await f.server.close();
    await f.store.commitStreams(base, { snapshot: stream(100, 9), delta: stream(12) }, signal());
    expect(f.files.has(`chunks/${hash}`)).toBe(false);
    expect(f.traffic.pendingBytes).toBe(WORKSPACE_PUBLICATION_BYTES);
  } finally { await f.close(); }
});

it("fences an unresponsive read owner without inventing a retirement receipt", async () => {
  vi.useFakeTimers();
  const channel = new MessageChannel();
  const client = new SnapshotStorageClient(channel.port2);
  try {
    const pending = client.request({ type: "retire-workspace-read", identity: { ...binding, transfer: 1 } });
    const rejected = expect(pending).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { cleanupFailed: true, reason: "workspace-read-response-timeout" } });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    await expect(client.request({ type: "retire-workspace-read", identity: { ...binding, transfer: 1 } })).rejects.toMatchObject({ detail: { cleanupFailed: true } });
  } finally { client.close(); channel.port1.close(); vi.useRealTimers(); }
});


it("returns the retained source's actual base through the bounded channel",async()=>{
 const foreign="b".repeat(64),retire=vi.fn(()=>Promise.resolve());
 const f=fixture(()=>Promise.resolve({generation:3,workspaceBaseSha256:foreign,snapshot:workspaceBytesInput(new Uint8Array([1])),retire}));
 try {
  const read=await openWorkspaceRead(f.client,{workspaceBaseSha256:base,credit:f.credit,selection:{kind:"retained",id:binding.session,allowDifferentBase:true}},signal());
  expect(read.selection?.workspaceBaseSha256).toBe(foreign);
  const returned=await read.retire();f.traffic.returnCredit(returned);expect(retire).toHaveBeenCalledOnce();expect(f.traffic.pendingBytes).toBe(0);
 }finally{await f.close();}
});
