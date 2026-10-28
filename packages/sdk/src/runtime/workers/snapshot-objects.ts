import { normalizeStorageError, VMError } from "../errors.js";
import { ownedBytes, sha256Hex } from "./snapshot-content.js";
import { readStorageObjects } from "./storage-read-batch.js";
import type { ObjectRef } from "./snapshot-manifest.js";

/** How long one object's file write may take before its put fails and the next one starts. */
const FILE_TIME_LIMIT_MILLISECONDS = 60_000;

export interface SnapshotReadLease {
  verify(refs: Iterable<ObjectRef>): Promise<void>;
  read(ref: ObjectRef): Promise<Uint8Array<ArrayBuffer>>;
  retire(): void;
}

/**
 * Content-addressed snapshot objects under `snapshots-v2/objects/<sha256>`. A new object is
 * written in place through a sync access handle and flushed before its put resolves. A write cut
 * short by a crash can leave a full-size file with other bytes, so an existing object this
 * session neither wrote nor read back is verified once before it is reused. Reads verify size
 * and hash. Puts hash in parallel but write their files one at a time, each within a time limit:
 * with several file writes in flight, Brave left one never finishing, which held every later
 * save.
 */
export class SnapshotObjects {
  readonly #directory: FileSystemDirectoryHandle;
  readonly #fileTimeLimit: number;
  /** Objects this session wrote or read back verified. */
  readonly #verified = new Set<string>();
  /** Stores in progress by object, so concurrent puts of the same content write it once. */
  readonly #storing = new Map<string, Promise<void>>();
  /** The object file write under way; the next starts once it ends or runs out of time. */
  #fileTurn: Promise<void> = Promise.resolve();

  private constructor(directory: FileSystemDirectoryHandle, fileTimeLimit: number) {
    this.#directory = directory;
    this.#fileTimeLimit = fileTimeLimit;
  }

  static async open(
    root: FileSystemDirectoryHandle,
    { fileTimeLimitMilliseconds = FILE_TIME_LIMIT_MILLISECONDS }: { readonly fileTimeLimitMilliseconds?: number } = {},
  ): Promise<SnapshotObjects> {
    return new SnapshotObjects(await root.getDirectoryHandle("objects", { create: true }), fileTimeLimitMilliseconds);
  }

  async put(bytes: Uint8Array): Promise<ObjectRef> {
    const owned = ownedBytes(bytes);
    const ref = { sha256: await sha256Hex(owned), bytes: owned.byteLength };
    let storing = this.#storing.get(ref.sha256);
    if (storing === undefined) {
      storing = this.#inTurn(() => this.#store(ref, owned)).finally(() => this.#storing.delete(ref.sha256));
      this.#storing.set(ref.sha256, storing);
    }
    await storing;
    return ref;
  }

  /** Runs `write` after the file write before it, failing it once it outlasts the time limit. */
  #inTurn(write: () => Promise<void>): Promise<void> {
    const turn = this.#fileTurn.then(() => withinTimeLimit(write(), this.#fileTimeLimit));
    this.#fileTurn = turn.then(() => undefined, () => undefined);
    return turn;
  }

  async #file(ref: ObjectRef): Promise<File> {
    let file: File;
    try {
      file = await (await this.#directory.getFileHandle(ref.sha256)).getFile();
    } catch (error) {
      if (isNotFound(error)) {
        throw new VMError("STORAGE_NOT_FOUND", "a snapshot object is missing", { reason: "snapshot-damaged" });
      }
      throw normalizeStorageError(error);
    }
    if (file.size !== ref.bytes) throw integrityFailure();
    return file;
  }

  async read(ref: ObjectRef): Promise<Uint8Array<ArrayBuffer>> {
    const file = await this.#file(ref);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if ((await sha256Hex(bytes)) !== ref.sha256) throw integrityFailure();
    this.#verified.add(ref.sha256);
    return bytes;
  }

  /** Immutable File snapshots keep preflight and consumption on the same bytes. */
  async openVerifiedReads(refs: Iterable<ObjectRef>, signal?: AbortSignal): Promise<SnapshotReadLease> {
    const files = new Map<string, File>();
    let retired = false;
    const active = () => { if (retired || signal?.aborted === true) throw new VMError("ABORTED", "Verified snapshot source retired"); };
    const verify = async (references: Iterable<ObjectRef>): Promise<void> => {
      active();
      const distinct = [...new Map(Array.from(references, ref => [`${ref.sha256}:${String(ref.bytes)}`, ref])).values()];
      await readStorageObjects(distinct, async ref => {
        const key = `${ref.sha256}:${String(ref.bytes)}`;
        if (files.has(key)) return;
        const file = await this.#file(ref), bytes = new Uint8Array(await file.arrayBuffer());
        if (await sha256Hex(bytes) !== ref.sha256) throw integrityFailure();
        files.set(key, file);
      }, signal);
    };
    await verify(refs);
    return {
      verify,
      read: async ref => {
        active();
        const file = files.get(`${ref.sha256}:${String(ref.bytes)}`);
        if (file === undefined) throw new VMError("PROTOCOL_ERROR", "Snapshot object was not preflighted");
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (bytes.length !== ref.bytes) throw integrityFailure();
          active();
          return bytes;
        } catch (error) { throw normalizeStorageError(error); }
      },
      retire: () => { retired = true; files.clear(); },
    };
  }

  /** Preflight immutable objects once per call, retaining at most eight object buffers. */
  async verify(refs: Iterable<ObjectRef>, signal?: AbortSignal): Promise<void> {
    const distinct = [...new Map(Array.from(refs, ref => [`${ref.sha256}:${String(ref.bytes)}`, ref])).values()];
    await readStorageObjects(distinct, ref => this.read(ref), signal);
  }

  /** The names (SHA-256 digests) of every stored object. */
  async names(): Promise<string[]> {
    const names: string[] = [];
    for await (const name of this.#directory.keys()) names.push(name);
    return names;
  }

  async remove(sha256: string): Promise<void> {
    this.#verified.delete(sha256);
    try {
      await this.#directory.removeEntry(sha256);
    } catch (error) {
      if (!isNotFound(error)) throw normalizeStorageError(error);
    }
  }

  /** The stored size of an object, or `undefined` when it is absent. */
  async size(sha256: string): Promise<number | undefined> {
    try {
      return (await (await this.#directory.getFileHandle(sha256)).getFile()).size;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw normalizeStorageError(error);
    }
  }

  /** Keeps a complete existing object, or writes the object in place and flushes it. */
  async #store(ref: ObjectRef, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    if ((await this.size(ref.sha256)) === ref.bytes && (this.#verified.has(ref.sha256) || (await this.#holds(ref)))) {
      return;
    }
    const handle = await (await this.#directory.getFileHandle(ref.sha256, { create: true })).createSyncAccessHandle();
    try {
      this.#verified.delete(ref.sha256);
      handle.truncate(0);
      // Sync handles may report partial progress; only a complete write can be verified.
      // https://fs.spec.whatwg.org/#dom-filesystemsyncaccesshandle-write
      for (let offset = 0; offset < bytes.byteLength;) {
        const expected = bytes.byteLength - offset;
        const actual = handle.write(bytes.subarray(offset), { at: offset });
        if (!Number.isSafeInteger(actual) || actual <= 0 || actual > expected) {
          throw new VMError("STORAGE_ERROR", "a snapshot object write made invalid progress", {
            reason: "snapshot-write-progress", offset, actual, expected,
          });
        }
        offset += actual;
      }
      handle.flush();
    } finally {
      handle.close();
    }
    this.#verified.add(ref.sha256);
  }

  /** Whether the stored object holds exactly `ref`'s bytes. */
  async #holds(ref: ObjectRef): Promise<boolean> {
    try {
      await this.read(ref);
      return true;
    } catch (error) {
      if (error instanceof VMError && (error.code === "STORAGE_NOT_FOUND" || error.detail?.["reason"] === "snapshot-damaged")) {
        return false;
      }
      throw error;
    }
  }
}

export async function readOpfsFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const file = await (await directory.getFileHandle(name)).getFile();
  if (file.size > maximumBytes) {
    throw new VMError("STORAGE_ERROR", "a snapshot file exceeds its size limit", { reason: "snapshot-damaged" });
  }
  return new Uint8Array(await file.arrayBuffer());
}

/** Writes `bytes` as the whole file; the browser swaps the file in only when the stream closes. */
export async function writeOpfsFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function integrityFailure(): VMError {
  return new VMError("STORAGE_ERROR", "a snapshot object failed integrity validation", { reason: "snapshot-damaged" });
}

/** `work`, or a storage timeout once `milliseconds` pass without it settling. */
async function withinTimeLimit(work: Promise<void>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new VMError("STORAGE_ERROR", "a restore point file write did not finish in time", { reason: "storage-timeout" }));
    }, milliseconds);
  });
  try {
    await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}
