import { VMError } from "../errors.js";
import type { UserspaceRootfsManifest } from "../userspace-rootfs.js";
export type Scope = "root" | "blobs" | "manifests" | "pins" | "packs" | "pack-layouts" | "transports" | "installations";
export type Backend =
  | { readonly kind: "opfs"; readonly root: FileSystemDirectoryHandle }
  | { readonly kind: "indexeddb"; readonly database: Promise<IDBDatabase> };
/** Keeps the manifest exactly as it was fetched: an offline start checks it against the same pin. */
export async function activate(backend: Backend, url: URL, manifest: UserspaceRootfsManifest, encoded: Uint8Array<ArrayBuffer>): Promise<void> {
  const file = `${manifest.rootTreeSha256}.${manifest.id}.${manifest.version}.json`;
  const marker = new TextEncoder().encode(JSON.stringify({ file, manifestUrl: url.href }));
  if (backend.kind === "indexeddb") {
    const database = await backend.database;
    await idbWrite(database, (store) => {
      store.put(encoded, key("manifests", file));
      store.put(marker, key("root", "active.json"));
    });
    return;
  }
  await write(backend, "root", "intent.json", new TextEncoder().encode(JSON.stringify({ file, rootTreeSha256: manifest.rootTreeSha256 })));
  await write(backend, "manifests", file, encoded);
  await write(backend, "root", "active.json", marker);
  await remove(backend, "root", "intent.json");
}

export async function verifiedFile(backend: Backend, scope: Scope, name: string, bytes: number, digest: string): Promise<boolean> {
  return await verifiedBytes(backend, scope, name, bytes, digest) !== undefined;
}

export async function verifiedBytes(
  backend: Backend,
  scope: Scope,
  name: string,
  bytes: number,
  digest: string,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  return verifiedContent(await read(backend, scope, name), bytes, digest);
}

/** Retains only a directory capability; every read still verifies fresh bytes. */
export async function openVerifiedReader(backend: Backend, scope: Scope): Promise<(name: string, bytes: number, digest: string) => Promise<Uint8Array<ArrayBuffer> | undefined>> {
  if (backend.kind === "indexeddb") return (name, bytes, digest) => verifiedBytes(backend, scope, name, bytes, digest);
  let directory: FileSystemDirectoryHandle | undefined;
  try { directory = await opfsDirectory(backend.root, scope, false); } catch { /* A missing cache is not created by verification. */ }
  return async (name, bytes, digest) => {
    if (directory === undefined) return undefined;
    let content: Uint8Array<ArrayBuffer>;
    try { content = new Uint8Array(await (await (await directory.getFileHandle(name)).getFile()).arrayBuffer()); }
    catch { return undefined; }
    return verifiedContent(content, bytes, digest);
  };
}

async function verifiedContent(content: Uint8Array<ArrayBuffer> | undefined, bytes: number, digest: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  return content !== undefined && content.byteLength === bytes && await sha256(content) === digest
    ? content
    : undefined;
}

export async function read(backend: Backend, scope: Scope, name: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (backend.kind === "opfs") {
    try {
      const directory = await opfsDirectory(backend.root, scope, false);
      return new Uint8Array(await (await (await directory.getFileHandle(name)).getFile()).arrayBuffer());
    } catch {
      return undefined;
    }
  }
  const database = await backend.database;
  return idbRead(database, key(scope, name));
}

export async function names(backend: Backend, scope: Scope): Promise<string[]> {
  if (backend.kind === "opfs") {
    const found: string[] = [];
    try {
      for await (const [name, handle] of (await opfsDirectory(backend.root, scope, false)).entries()) {
        if (handle.kind === "file") found.push(name);
      }
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
    }
    return found;
  }
  const database = await backend.database;
  const prefix = key(scope, "");
  return new Promise((resolve, reject) => {
    const tx = database.transaction("files", "readonly");
    const request = tx.objectStore("files").getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    request.onsuccess = () => resolve(request.result.flatMap(name => typeof name === "string" ? [name.slice(prefix.length)] : []));
    request.onerror = () => reject(request.error ?? new VMError("STORAGE_ERROR", "rootfs IndexedDB listing failed"));
  });
}

function idbRead(database: IDBDatabase, name: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction("files", "readonly");
    const request = tx.objectStore("files").get(name);
    request.onsuccess = () => resolve(
      request.result instanceof Uint8Array
        ? new Uint8Array(request.result)
        : request.result instanceof ArrayBuffer
          ? new Uint8Array(request.result)
          : undefined,
    );
    request.onerror = () => reject(request.error ?? new VMError("STORAGE_ERROR", "rootfs IndexedDB read failed"));
    tx.onabort = () => reject(tx.error ?? new VMError("ABORTED", "rootfs IndexedDB read aborted"));
  });
}

export async function write(backend: Backend, scope: Scope, name: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  if (backend.kind === "indexeddb") {
    const database = await backend.database;
    await idbWrite(database, (store) => { store.put(bytes, key(scope, name)); });
    return;
  }
  const directory = await opfsDirectory(backend.root, scope, true);
  const writable = await (await directory.getFileHandle(name, { create: true })).createWritable({ keepExistingData: false });
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    await writable.abort(error);
    throw error;
  }
}

export async function remove(backend: Backend, scope: Scope, name: string): Promise<void> {
  if (backend.kind === "indexeddb") {
    const database = await backend.database;
    await idbWrite(database, (store) => { store.delete(key(scope, name)); });
    return;
  }
  const directory = await opfsDirectory(backend.root, scope, true);
  await directory.removeEntry(name).catch(() => undefined);
}

export async function opfsDirectory(root: FileSystemDirectoryHandle, scope: Scope, create: boolean): Promise<FileSystemDirectoryHandle> {
  const base = await root.getDirectoryHandle("userspace-rootfs", { create });
  return scope === "root" ? base : base.getDirectoryHandle(scope, { create });
}

function key(scope: Scope, name: string): string {
  return `${scope}/${name}`;
}

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("oxidevm-userspace-rootfs", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new VMError("STORAGE_ERROR", "rootfs IndexedDB open failed"));
  });
}

function idbWrite(database: IDBDatabase, start: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction("files", "readwrite");
    start(tx.objectStore("files"));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new VMError("STORAGE_ERROR", "rootfs IndexedDB write failed"));
    tx.onabort = () => reject(tx.error ?? new VMError("ABORTED", "rootfs storage transaction aborted"));
  });
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
