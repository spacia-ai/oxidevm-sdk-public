import { normalizeStorageError, VMError } from "../errors.js";
import { readInto } from "./managed-disk-files.js";
import { isNotFound } from "./snapshot-objects.js";
import { ManagedBaseIntegrity } from "./managed-base-integrity.js";
import type { ManagedImageChunk } from "../managed-image.js";

/** Read access to one shared base image pack, held until released. */
export interface BaseLease {
  /** Reads pack bytes at `offset`; bytes past the end read as zero. */
  read(offset: number, destination: Uint8Array): void;
  release(): void;
}

interface OpenBase {
  readonly handle: Promise<FileSystemSyncAccessHandle>;
  opened?: FileSystemSyncAccessHandle;
  refs: number;
  integrity?: ManagedBaseIntegrity;
}

/**
 * The storage owner's registry of shared base packs (`managed-images/<stem>.pack`). A sync
 * access handle is exclusive, so every disk generation of one image reads the pack through a
 * single reference-counted handle, which closes after its last lease is released.
 */
export class ManagedBases {
  readonly #open = new Map<string, OpenBase>();

  async acquire(images: FileSystemDirectoryHandle, stem: string, chunks?: readonly Pick<ManagedImageChunk,"bytes"|"sha256">[]): Promise<BaseLease> {
    let entry = this.#open.get(stem);
    if (entry === undefined) {
      entry = { handle: openPack(images, stem), refs: 0 };
      this.#open.set(stem, entry);
    }
    entry.refs += 1;
    let handle: FileSystemSyncAccessHandle;
    try {
      handle = await entry.handle;
      entry.opened = handle;
      if(chunks!==undefined){
        if(entry.integrity!==undefined&&entry.integrity.identity!==ManagedBaseIntegrity.identity(chunks))throw new VMError("STORAGE_ERROR","Shared base has a different chunk layout");
        entry.integrity??=new ManagedBaseIntegrity(chunks,handle);
      }
    } catch (error) {
      this.#release(stem, entry);
      throw error;
    }
    let released = false;
    return {
      read: (offset, destination) => {
        if (released) throw new VMError("STORAGE_ERROR", "the managed base lease was released");
        entry.integrity?.verify(handle,offset,destination.length);
        readInto(handle, offset, destination);
      },
      release: () => {
        if (released) return;
        released = true;
        this.#release(stem, entry);
      },
    };
  }

  /** Whether any lease holds the pack of `stem` open. */
  isOpen(stem: string): boolean {
    return this.#open.has(stem);
  }

  /** The storage worker serializes repairs through the same handle guest disk leases use. */
  async repair(images: FileSystemDirectoryHandle, stem: string, work: (handle: FileSystemSyncAccessHandle) => Promise<void>): Promise<void> {
    const lease = await this.acquire(images, stem);
    try {
      const handle = this.#open.get(stem)?.opened;
      if (handle === undefined) throw new VMError("STORAGE_ERROR", "Managed image repair lost its base lease");
      this.#open.get(stem)?.integrity?.invalidate();
      await work(handle);
    } finally { this.#open.get(stem)?.integrity?.invalidate();lease.release(); }
  }

  #release(stem: string, entry: OpenBase): void {
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.#open.delete(stem);
    // A failed open has nothing to close; an open handle closes as its last lease goes.
    entry.opened?.close();
  }
}

async function openPack(images: FileSystemDirectoryHandle, stem: string): Promise<FileSystemSyncAccessHandle> {
  let file: FileSystemFileHandle;
  try {
    file = await images.getFileHandle(`${stem}.pack`);
  } catch (error) {
    if (isNotFound(error)) {
      throw new VMError("STORAGE_NOT_FOUND", "the managed base image is not cached", { reason: "base-missing" });
    }
    throw normalizeStorageError(error);
  }
  return file.createSyncAccessHandle();
}
