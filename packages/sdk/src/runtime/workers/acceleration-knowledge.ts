import { VMError } from "../errors.js";
import { indexedDbRead, indexedDbWrite } from "./workspace-backend.js";

/** ADR 0026: remembered fast-path failures for this browser origin. Rust owns the records and
 * their policy; this store keeps only the bytes, one file per engine release and SDK version,
 * so an engine, host or SDK update starts from an empty table. */
export const KNOWLEDGE_MAX_BYTES = 8 * 1024 * 1024;
const DIRECTORY = "acceleration-knowledge";

export type AccelerationKnowledgeBackend =
  | { readonly kind: "opfs"; readonly root: FileSystemDirectoryHandle }
  | { readonly kind: "indexeddb"; readonly database: Promise<IDBDatabase> };

export function accelerationKnowledgeNamespace(engineReleaseId: string, sdkVersion: string): string {
  if (!/^[0-9a-f]{64}$/u.test(engineReleaseId) || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(sdkVersion)) {
    throw new VMError("INVALID_ARGUMENT", "Invalid acceleration knowledge namespace");
  }
  return `${engineReleaseId}-${sdkVersion}`;
}

export async function readAccelerationKnowledge(backend: AccelerationKnowledgeBackend, namespace: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  if (backend.kind === "indexeddb") bytes = await indexedDbRead(await backend.database, namespace, KNOWLEDGE_MAX_BYTES + 1);
  else {
    try {
      const directory = await backend.root.getDirectoryHandle(DIRECTORY);
      bytes = new Uint8Array(await (await (await directory.getFileHandle(`${namespace}.bin`)).getFile()).arrayBuffer());
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
      throw new VMError("STORAGE_ERROR", "Acceleration knowledge read failed", { reason: domReason(error) });
    }
  }
  if (bytes !== undefined && bytes.byteLength > KNOWLEDGE_MAX_BYTES) throw new VMError("STORAGE_ERROR", "Stored acceleration knowledge exceeds its bound");
  return bytes;
}

/** Replaces the file whole: a writable stream publishes on close, IndexedDB in one transaction. */
export async function writeAccelerationKnowledge(backend: AccelerationKnowledgeBackend, namespace: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  if (bytes.byteLength > KNOWLEDGE_MAX_BYTES) throw new VMError("INVALID_ARGUMENT", "Acceleration knowledge exceeds its bound");
  if (backend.kind === "indexeddb") { await indexedDbWrite(await backend.database, namespace, bytes); return; }
  const directory = await backend.root.getDirectoryHandle(DIRECTORY, { create: true });
  const writable = await (await directory.getFileHandle(`${namespace}.bin`, { create: true })).createWritable({ keepExistingData: false });
  try { await writable.write(bytes); await writable.close(); }
  catch (error: unknown) { await writable.abort(error); throw new VMError("STORAGE_ERROR", "Acceleration knowledge write failed", { reason: domReason(error) }); }
}

export function openAccelerationKnowledgeDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("oxidevm-acceleration-knowledge", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new VMError("STORAGE_ERROR", "Acceleration knowledge IndexedDB open failed"));
  });
}

function domReason(error: unknown): string {
  return error instanceof DOMException ? error.name : "unknown";
}
