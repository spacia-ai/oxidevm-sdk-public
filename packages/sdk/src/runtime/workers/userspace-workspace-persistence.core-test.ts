import { nativeReconcileReads } from "./userspace-workspace-reconcile.js";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { VMError } from "../errors.js";
import { decodeUserspaceFileRecord, encodeUserspaceFileRequest, type UserspaceFileRecord, type UserspaceFileRequest } from "../userspace-files.js";
import { encodeFilesystemRecord } from "../userspace-rootfs-record.js";
import { UserspaceWorkspacePersistence } from "./userspace-workspace-persistence.js";
import { callUserspaceU32 as call, callUserspaceU64 as call64 } from "./userspace-exports.js";
import { executeNativeFiles, readFileRecord } from "./userspace-files.js";
import { instantiateRuntime } from "./userspace-runtime.js";
import { UserspaceStorageClient } from "./userspace-storage-channel.js";
import { serveUserspaceStorage } from "./userspace-storage-server.js";
import { WorkspacePublications } from "./workspace-publication.js";
import { WorkspaceStore, type WorkspaceStoreBackend } from "./workspace-store.js";
import { workspaceBytesInput } from "./workspace-stream.js";
import { engineModulePath } from "./engine-wasm.test-support.js";

const base = "a".repeat(64), text = new TextEncoder();
const binary = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
const module = await WebAssembly.compile(binary.buffer);
/** Byte equality for a read: vitest's deep equality walks every element of a 1 MiB array, which takes seconds. */
function expectBytes(record: UserspaceFileRecord, expected: Uint8Array): void {
  const data = "data" in record ? record.data : undefined;
  expect(data).toBeInstanceOf(Uint8Array);
  expect(Buffer.compare(data ?? new Uint8Array(), expected)).toBe(0);
}

function snapshot(contents = "saved"): Uint8Array<ArrayBuffer> {
  return encodeFilesystemRecord([{ tag: 1, mode: 0o640, path: text.encode("/workspace/saved"), pathText: "/workspace/saved", payload: text.encode(contents) }], "snapshot");
}
async function fixture() {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const fault = { quota: false, retire: false, pause: false, readPause: false };
  const entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>();
  const readEntered = Promise.withResolvers<undefined>(), published = Promise.withResolvers<undefined>();
  const requests: string[] = [];
  const backend: WorkspaceStoreBackend = {
    list: async function* (prefix) { for (const path of files.keys()) if (path.startsWith(prefix)) yield await Promise.resolve(path); },
    read: path => Promise.resolve(files.get(path)?.slice()),
    write: async (path, bytes) => {
      if (fault.quota && path.startsWith("chunks/")) throw new VMError("QUOTA_EXCEEDED", "injected quota");
      files.set(path, bytes.slice());
      if (fault.pause && path === "active.json") { entered.resolve(undefined); await proceed.promise; }
    },
    remove: path => { files.delete(path); return Promise.resolve(); },
  };
  const store = new WorkspaceStore(backend), owner = new WorkspacePublications();
  const channel = new MessageChannel();
  const server = serveUserspaceStorage(channel.port2, async (request, signal) => {
    requests.push(request.type === "workspace" && request.request.type === "read-workspace-frame" ? `${request.request.type}:${request.request.source}` : request.type === "workspace" ? request.request.type : request.type);
    if (request.type === "workspace" && request.request.type === "retire-workspace-read" && fault.retire) return Promise.reject(new VMError("STORAGE_ERROR", "retirement lost", { cleanupFailed: true }));
    if (request.type !== "workspace") throw new Error("Unexpected workspace storage request");
    if (fault.readPause && request.request.type === "read-workspace-frame" && request.request.offset > 0) {
      readEntered.resolve(undefined);
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    }
    if(request.request.type==="inspect-workspace-base")throw new Error("This fixture has no foreign image source");
    const result = await owner.handle(store, request.request, signal, (selection, base, signal) => {
      if (selection.kind !== "retained") throw new Error("This fixture only retains workspace selections");
      return store.openRead(base, signal);
    });
    if (request.request.type === "commit-workspace-streams") published.resolve(undefined);
    return result;
  });
  const client = new UserspaceStorageClient(channel.port1);
  const runtime = await instantiateRuntime(module, "userspace.wasm", { kind: "disabled" });
  const stage = (bytes: Uint8Array): void => {
    expect(call(runtime.instance, "oxidevm_userspace_staging_resize", bytes.length)).toBe(0);
    new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), bytes.length).set(bytes);
  };
  stage(new Uint8Array()); expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", 0, 1, 64)).toBe(0);
  expect(call(runtime.instance, "oxidevm_userspace_configure_workspace_persistence")).toBe(0);
  const persistence = new UserspaceWorkspacePersistence(runtime, client, base, () => {});
  const file = (request: UserspaceFileRequest) => {
    const bytes = encodeUserspaceFileRequest(request); stage(bytes);
    expect(call(runtime.instance, "oxidevm_userspace_files", bytes.length)).toBe(0);
    return decodeUserspaceFileRecord(readFileRecord(runtime), request);
  };
  return { store, runtime, client, persistence, file, fault, entered, proceed, readEntered, published, requests,
    close: async () => { proceed.resolve(undefined); client.close(); await server.close(); await owner.closeRead(); await runtime.jitRuntime.dispose(); } };
}

it("restores legacy snapshot-only files before an incremental delta and retires dependencies without installing assistance", async () => {
  const f = await fixture();
  try {
    await f.store.commit(base, snapshot());
    await f.store.commitDelta(base, encodeFilesystemRecord([], "delta"));
    await f.persistence.initialize();
    const file = f.file({ operation: "read", path: "/saved", maxBytes: 16 });
    expect(file.operation).toBe("read");
    if (file.operation !== "read") throw new Error("read expected");
    expect(new TextDecoder().decode(file.data)).toBe("saved");
    expect(f.requests.indexOf("retire-workspace-source")).toBeLessThan(f.requests.indexOf("retire-workspace-read"));
    f.file({ operation: "write", path: "/saved", data: text.encode("updated") });
    await f.persistence.persist();
    const recovered = await f.store.read(base);
    expect(recovered).toBeDefined();
    expect(call64(f.runtime.instance, "oxidevm_userspace_workspace_published_revision")).toBe(call64(f.runtime.instance, "oxidevm_userspace_workspace_revision"));
  } finally { await f.close(); }
});

it("keeps separate dependency generations across Userspace restoration and publication", async () => {
  const f = await fixture();
  try {
    const inputsSha256 = "b".repeat(64);
    await f.store.commitStreams(base, { snapshot: workspaceBytesInput(snapshot()), delta: workspaceBytesInput(encodeFilesystemRecord([], "delta")),
      dependencies: { inputsSha256, tree: workspaceBytesInput(new Uint8Array([99, 98])) } }, new AbortController().signal);
    const prior = await f.store.dependencyGeneration(base, new AbortController().signal);
    await f.persistence.initialize();
    expect(f.requests).not.toContain("read-workspace-frame:dependencies");
    f.file({ operation: "write", path: "/later", data: text.encode("kept") });
    await f.persistence.persist();
    expect(await f.store.dependencyGeneration(base, new AbortController().signal)).toEqual(prior);
  } finally { await f.close(); }
});

it.each(["truncated", "retirement"])("does not activate partial workspace data after %s failure", async failure => {
  const f = await fixture();
  try {
    await f.store.commit(base, failure === "truncated" ? snapshot().slice(0, -1) : snapshot());
    f.fault.retire = failure === "retirement";
    await expect(f.persistence.initialize()).rejects.toBeInstanceOf(VMError);
    expect(() => f.file({ operation: "stat", path: "/saved" })).toThrow();
    expect(call64(f.runtime.instance, "oxidevm_userspace_workspace_import_begin")).not.toBe(0n);
  } finally { await f.close(); }
});

it("returns quota failure without acknowledging the generation and permits a committed retry", async () => {
  const f = await fixture();
  try {
    await f.persistence.initialize();
    f.file({ operation: "write", path: "/later", data: text.encode("kept") });
    const before = call64(f.runtime.instance, "oxidevm_userspace_workspace_published_revision");
    f.fault.quota = true;
    await expect(f.persistence.persist()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(call64(f.runtime.instance, "oxidevm_userspace_workspace_published_revision")).toBe(before);
    await f.persistence.waitForProducer();
    f.fault.quota = false; await f.persistence.persist();
    expect(call64(f.runtime.instance, "oxidevm_userspace_workspace_published_revision")).toBe(call64(f.runtime.instance, "oxidevm_userspace_workspace_revision"));
  } finally { await f.close(); }
});

it("publishes the captured revision while writes after producer retirement remain dirty", async () => {
  const f = await fixture();
  try {
    await f.persistence.initialize();
    f.file({ operation: "write", path: "/later", data: text.encode("old") });
    const captured = call64(f.runtime.instance, "oxidevm_userspace_workspace_revision");
    f.fault.pause = true;
    const pending = f.persistence.persist();
    await f.entered.promise; await f.persistence.waitForProducer();
    f.file({ operation: "write", path: "/later", data: text.encode("new") });
    f.proceed.resolve(undefined); await pending;
    expect(call64(f.runtime.instance, "oxidevm_userspace_workspace_published_revision")).toBe(captured);
    expect(call64(f.runtime.instance, "oxidevm_userspace_workspace_revision")).toBeGreaterThan(captured);
  } finally { await f.close(); }
});

it("retains compiler caches through cumulative publications, failed commits and a fresh restore", async () => {
  const f = await fixture();
  try {
    await f.persistence.initialize();
    f.file({ operation: "mkdir", path: "/.next" });
    f.file({ operation: "write", path: "/.next/cache", data: new Uint8Array(1024 * 1024).fill(7) });
    f.file({ operation: "write", path: "/app.ts", data: text.encode("before") });
    await f.persistence.persist();
    const baseline = await f.store.readGeneration(base);
    f.file({ operation: "write", path: "/app.ts", data: text.encode("changed") });
    f.fault.quota = true;
    await expect(f.persistence.persist()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    f.fault.quota = false;
    await f.persistence.persist();
    const cumulative = await f.store.readGeneration(base);
    expect(cumulative?.snapshot).toEqual(baseline?.snapshot);
    expect(cumulative?.generation).toBe(2);
    const restored = new UserspaceWorkspacePersistence(f.runtime, f.client, base, () => {});
    await restored.initialize();
    expect(f.file({ operation: "read", path: "/app.ts", maxBytes: 16 })).toMatchObject({ data: text.encode("changed") });
    expectBytes(f.file({ operation: "read", path: "/.next/cache", maxBytes: 2 * 1024 * 1024 }), new Uint8Array(1024 * 1024).fill(7));
  } finally { await f.close(); }
});

it("runs host file requests after native workspace export releases its backing cursor", async () => {
  const f = await fixture();
  try {
    await f.persistence.initialize();
    f.file({ operation: "write", path: "/later", data: text.encode("kept") });
    const pending = f.persistence.persist();
    void pending.catch(() => {});
    const request = { operation: "read", path: "/later", maxBytes: 16 } as const;
    const bytes = await f.persistence.requestFile(encodeUserspaceFileRequest(request), () => {});
    expect(decodeUserspaceFileRecord(bytes, request)).toMatchObject({ operation: "read", data: text.encode("kept") });
    await pending;
  } finally { await f.close(); }
});

it("aborts a partly staged restore before admitting its workspace", async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    await f.store.commit(base, snapshot("x".repeat(70_000)));
    f.fault.readPause = true;
    const pending = f.persistence.initialize(controller.signal);
    const outcome = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await f.readEntered.promise; controller.abort(); await outcome;
    expect(() => f.file({ operation: "stat", path: "/saved" })).toThrow();
  } finally { await f.close(); }
});

it("cancels a host write queued behind workspace export before changing the file", async () => {
  const f = await fixture();
  try {
    await f.persistence.initialize();
    f.file({ operation: "write", path: "/later", data: text.encode("kept") });
    const pending = f.persistence.persist();
    void pending.catch(() => {});
    let canceled = false;
    const request = encodeUserspaceFileRequest({ operation: "write", path: "/later", data: text.encode("lost") });
    const writing = executeNativeFiles(f.runtime, request, () => Promise.reject(new Error("unexpected image read")), () => {
      if (canceled) throw new VMError("ABORTED", "host write canceled");
    }, (bytes, check) => f.persistence.requestFile(bytes, check));
    canceled = true;
    await expect(writing).rejects.toMatchObject({ code: "ABORTED" });
    await pending;
    expect(f.file({ operation: "read", path: "/later", maxBytes: 16 })).toMatchObject({ operation: "read", data: text.encode("kept") });
  } finally { await f.close(); }
});

it("fences a stalled publication and never acknowledges its late storage completion", async () => {
  const f = await fixture();
  try {
    await f.persistence.initialize();
    f.file({ operation: "write", path: "/later", data: text.encode("kept") });
    const before = call64(f.runtime.instance, "oxidevm_userspace_workspace_published_revision");
    f.fault.pause = true;
    vi.useFakeTimers();
    const outcome = expect(f.persistence.persist()).rejects.toMatchObject({ detail: { cleanupFailed: true } });
    await f.entered.promise;
    await vi.advanceTimersByTimeAsync(90_001); await outcome;
    f.proceed.resolve(undefined); await f.published.promise;
    expect(call64(f.runtime.instance, "oxidevm_userspace_workspace_published_revision")).toBe(before);
    await expect(f.persistence.persist()).rejects.toMatchObject({ detail: { cleanupFailed: true } });
  } finally { vi.useRealTimers(); await f.close(); }
});


it("shares channel credits across restored adapters and reconciliation while fencing old producers", async () => {
  const f = await fixture();
  try {
    await f.persistence.initialize();
    f.file({ operation: "write", path: "/later", data: text.encode("before") });
    await f.persistence.persist();
    const restored = new UserspaceWorkspacePersistence(f.runtime, f.client, base, () => {});
    f.file({ operation: "write", path: "/later", data: text.encode("after") });
    await expect(f.persistence.persist()).rejects.toMatchObject({ code: "ABORTED" });
    await restored.persist();
    const open = nativeReconcileReads(f.client, base, new AbortController().signal);
    const selected = await open({ kind: "retained", id: "11111111-2222-4333-8444-555555555555" });
    expect(selected.selection?.snapshot).toBeDefined();
    await selected.retire();
    f.file({ operation: "write", path: "/later", data: text.encode("after-reconcile") });
    await restored.persist();
    expect(call64(f.runtime.instance, "oxidevm_userspace_workspace_published_revision"))
      .toBe(call64(f.runtime.instance, "oxidevm_userspace_workspace_revision"));
  } finally { await f.close(); }
});
