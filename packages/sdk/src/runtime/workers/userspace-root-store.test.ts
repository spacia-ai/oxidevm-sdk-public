import { describe, expect, it } from "vitest";
import { VMError } from "../errors.js";
import { openUserspaceRootStore } from "./userspace-root-store.js";
import { WorkspaceStore, type WorkspaceStoreBackend } from "./workspace-store.js";
import { decodeWorkspaceOverlayManifest } from "./workspace-manifest.js";
import { workspaceBytesInput } from "./workspace-stream.js";
import { opfsWorkspaceStoreBackend } from "./workspace-backend.js";
import { MemoryDirectory, MemoryQuota } from "./opfs-double.test-support.js";

const root = "a".repeat(64);
const prefix = `userspace-roots/${root}/`;
const signal = () => new AbortController().signal;

class Backend implements WorkspaceStoreBackend {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
  crash: { readonly operation: "write" | "remove"; readonly path: string; readonly after: boolean } | undefined;
  frozen = false;

  async *list(start: string): AsyncGenerator<string> {
    this.#active();
    for (const path of this.files.keys()) if (path.startsWith(start)) yield await Promise.resolve(path);
  }
  read(path: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
    this.#active();
    return Promise.resolve(this.files.get(path)?.slice());
  }
  write(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    this.#interrupt("write", path, false);
    this.files.set(path, bytes.slice());
    this.#interrupt("write", path, true);
    return Promise.resolve();
  }
  remove(path: string): Promise<void> {
    this.#interrupt("remove", path, false);
    this.files.delete(path);
    this.#interrupt("remove", path, true);
    return Promise.resolve();
  }
  #active(): void {
    if (this.frozen) throw new VMError("STORAGE_ERROR", "injected storage owner loss");
  }
  #interrupt(operation: "write" | "remove", path: string, after: boolean): void {
    this.#active();
    if (this.crash?.operation === operation && path.startsWith(this.crash.path) && this.crash.after === after) {
      this.frozen = true;
      this.#active();
    }
  }
}

function commit(store: WorkspaceStore, identity: string, value: number): Promise<number> {
  return store.commitStreams(identity, {
    snapshot: workspaceBytesInput(new Uint8Array([value])),
    delta: workspaceBytesInput(new Uint8Array()),
  }, signal());
}

describe("persistent Userspace root storage", () => {
  it.each(["intent", "first-active"] as const)("recovers an empty %s file left before its first atomic close", async boundary => {
    const backend = new Backend();
    await commit(await openUserspaceRootStore(backend, root), root, 7);
    const active = backend.files.get(`${prefix}active.json`);
    if (active === undefined) throw new Error("missing committed metadata");
    if (boundary === "intent") backend.files.set(`${prefix}intent.json`, new Uint8Array());
    else {
      backend.files.set(`${prefix}intent.json`, active.slice());
      backend.files.set(`${prefix}active.json`, new Uint8Array());
    }
    const recovered = await openUserspaceRootStore(backend, root);
    await expect(recovered.read(root)).resolves.toEqual(boundary === "intent" ? new Uint8Array([7]) : undefined);
    expect(backend.files.has(`${prefix}intent.json`)).toBe(false);
    await expect(commit(recovered, root, 8)).resolves.toBe(boundary === "intent" ? 2 : 1);
  });
  it("recovers a crash after creating a staging file but before its atomic write", async () => {
    const backend = new Backend();
    await commit(await openUserspaceRootStore(backend, root), root, 7);
    const journal = `${prefix}staging/00000000-0000-4000-8000-000000000000/0`;
    backend.files.set(journal, new Uint8Array());
    await expect((await openUserspaceRootStore(backend, root)).read(root)).resolves.toEqual(new Uint8Array([7]));
    expect(backend.files.has(journal)).toBe(false);
  });
  it("recovers prefixed staging through the OPFS backend", async () => {
    const backend = opfsWorkspaceStoreBackend(new MemoryDirectory());
    await commit(await openUserspaceRootStore(backend, root), root, 7);
    await commit(await openUserspaceRootStore(backend, root), root, 8);
    await expect((await openUserspaceRootStore(backend, root)).read(root)).resolves.toEqual(new Uint8Array([8]));
  });

  it("keeps the committed generation after OPFS quota failure", async () => {
    const quota = new MemoryQuota(1024 * 1024);
    const backend = opfsWorkspaceStoreBackend(new MemoryDirectory("", undefined, quota));
    const store = await openUserspaceRootStore(backend, root);
    await commit(store, root, 7);
    quota.limit = quota.used + 1;
    await expect(commit(store, root, 8)).rejects.toMatchObject({ name: "QuotaExceededError" });
    quota.limit = 1024 * 1024;
    await expect((await openUserspaceRootStore(backend, root)).read(root)).resolves.toEqual(new Uint8Array([7]));
  });
  it("keeps exact root identities and the shared workspace in separate recovery namespaces", async () => {
    const backend = new Backend();
    const workspace = new WorkspaceStore(backend);
    const other = "b".repeat(64);
    await commit(workspace, root, 1);
    await commit(await openUserspaceRootStore(backend, root), root, 2);
    await commit(await openUserspaceRootStore(backend, other), other, 3);
    await commit(await openUserspaceRootStore(backend, root), root, 4);
    await expect(workspace.read(root)).resolves.toEqual(new Uint8Array([1]));
    await expect((await openUserspaceRootStore(backend, other)).read(other)).resolves.toEqual(new Uint8Array([3]));
    await expect((await openUserspaceRootStore(backend, root)).read(root)).resolves.toEqual(new Uint8Array([4]));
    expect(backend.files.has(`${prefix}active.json`)).toBe(true);
    expect(backend.files.has(`userspace-roots/${other}/active.json`)).toBe(true);
    expect(backend.files.has("active.json")).toBe(true);
  });

  it.each(["", "../root", "A".repeat(64), "a".repeat(63)])("rejects invalid immutable identity %s", async identity => {
    await expect(openUserspaceRootStore(new Backend(), identity)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  for (const phase of [
    { operation: "write", path: "chunks/", committed: false },
    { operation: "write", path: "intent.json", committed: false },
    { operation: "write", path: "active.json", committed: true },
    { operation: "remove", path: "intent.json", committed: true },
  ] as const) {
    it.each([false, true])(`recovers loss ${phase.operation} ${phase.path}, after=%s`, async after => {
      const backend = new Backend();
      let store = await openUserspaceRootStore(backend, root);
      await commit(store, root, 7);
      backend.crash = { operation: phase.operation, path: prefix + phase.path, after };
      await expect(commit(store, root, 8)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
      expect(backend.frozen).toBe(true);
      backend.frozen = false;
      backend.crash = undefined;
      store = await openUserspaceRootStore(backend, root);
      const published = phase.path === "active.json" ? after : phase.committed;
      await expect(store.read(root)).resolves.toEqual(new Uint8Array([published ? 8 : 7]));
      await expect(commit(store, root, 9)).resolves.toBe(published ? 3 : 2);
      expect(backend.files.has(`${prefix}intent.json`)).toBe(false);
      expect([...backend.files.keys()].some(path => path.startsWith(`${prefix}staging/`))).toBe(false);
    });
  }

  it("recovers a first interrupted publication without inventing a committed generation", async () => {
    const backend = new Backend();
    const store = await openUserspaceRootStore(backend, root);
    backend.crash = { operation: "write", path: `${prefix}intent.json`, after: true };
    await expect(commit(store, root, 8)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    backend.frozen = false;
    backend.crash = undefined;
    const recovered = await openUserspaceRootStore(backend, root);
    await expect(recovered.read(root)).resolves.toBeUndefined();
    await expect(commit(recovered, root, 9)).resolves.toBe(1);
  });

  it("rejects a foreign root manifest before clearing its recovery intent", async () => {
    const backend = new Backend();
    const store = await openUserspaceRootStore(backend, root);
    await commit(store, root, 7);
    const bytes = backend.files.get(`${prefix}active.json`);
    if (bytes === undefined) throw new Error("missing test manifest");
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const manifest = decodeWorkspaceOverlayManifest(value);
    backend.files.set(`${prefix}intent.json`, new TextEncoder().encode(JSON.stringify({ ...manifest, workspaceBaseSha256: "b".repeat(64) })));
    await expect(openUserspaceRootStore(backend, root)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(backend.files.has(`${prefix}intent.json`)).toBe(true);
  });
});
