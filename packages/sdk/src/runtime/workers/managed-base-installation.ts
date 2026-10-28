import { exactKeys, record, string, protocolError } from "../decode.js";
import type { ManagedImageManifest } from "../managed-image.js";
import { VMError } from "../errors.js";
import { sha256Hex } from "./snapshot-content.js";

type Chunk = ManagedImageManifest["disk"]["chunks"][number];

/** An unpublished base is writable only by its storage owner; each flushed range survives retry. */
export async function installManagedBase(file: FileSystemFileHandle, images: FileSystemDirectoryHandle,
  journalName: string, identity: string, chunks: readonly Chunk[], acquire: (chunk: Chunk) => Promise<Uint8Array<ArrayBuffer>>,
  options: { readonly signal?: AbortSignal; readonly verifyExisting?: boolean; readonly handle?: FileSystemSyncAccessHandle } = {}): Promise<void> {
  const { signal } = options;
  signal?.throwIfAborted();
  const completed = await readJournal(images, journalName, identity, chunks.length);
  const bytes = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
  const handle = options.handle ?? await file.createSyncAccessHandle();
  try {
    if (handle.getSize() !== bytes) { handle.truncate(bytes); handle.flush(); completed.clear(); }
    let position = 0;
    for (let index = 0; index < chunks.length; index++) {
      signal?.throwIfAborted();
      const chunk = chunks[index];
      if (chunk === undefined) throw protocolError("managed installation chunk is missing");
      let verified = false;
      const recorded = completed.has(index);
      if (recorded || options.verifyExisting === true) {
        const cached = new Uint8Array(chunk.bytes);
        verified = handle.read(cached, { at: position }) === chunk.bytes && await sha256Hex(cached) === chunk.sha256;
      }
      if (!verified) {
        const data = await acquire(chunk);
        signal?.throwIfAborted();
        if (handle.write(data, { at: position }) !== chunk.bytes) throw new VMError("STORAGE_ERROR", "managed base write was incomplete");
        handle.flush();
        const persisted = new Uint8Array(chunk.bytes);
        if (handle.read(persisted, { at: position }) !== chunk.bytes || await sha256Hex(persisted) !== chunk.sha256) {
          throw new VMError("STORAGE_ERROR", "managed base readback failed verification");
        }
      }
      if (!recorded || !verified) {
        completed.add(index);
        const journal = await images.getFileHandle(journalName, { create: true });
        const writable = await journal.createWritable();
        try { await writable.write(JSON.stringify({ version: 1, identity, completed: [...completed].sort((a, b) => a - b) })); await writable.close(); }
        catch (error) { await writable.abort().catch(() => {}); throw error; }
      }
      position += chunk.bytes;
    }
  } finally { if (options.handle === undefined) handle.close(); }
}

async function readJournal(images: FileSystemDirectoryHandle, name: string, identity: string, count: number): Promise<Set<number>> {
  let file: File;
  try { file = await (await images.getFileHandle(name)).getFile(); }
  catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return new Set(); throw error; }
  if (file.size > 2 * 1024 ** 2) throw protocolError("managed installation journal exceeds its bound");
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()); }
  catch { throw protocolError("managed installation journal is invalid JSON"); }
  const value = record(parsed, "managed installation journal");
  exactKeys(value, ["version", "identity", "completed"]);
  const listed = value["completed"];
  if (value["version"] !== 1 || string(value["identity"], "managed installation identity") !== identity
    || !Array.isArray(listed) || listed.length > count) throw protocolError("managed installation journal differs from its image");
  const completed = Array.from<unknown>(listed).map(index => {
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= count) throw protocolError("invalid managed installation chunk");
    return index;
  });
  if (new Set(completed).size !== completed.length) throw protocolError("duplicate managed installation chunk");
  return new Set(completed);
}
