import { normalizeStorageError, VMError } from "../errors.js";
export { DISK_RESERVE_BYTES } from "./browser-quota.js";
const FILE = "space.reserve";

/**
 * A file that holds storage for a disk generation while the origin has room for it, so restore
 * points cannot take the last of the space the guest's disk writes need. The first disk write the
 * browser refuses for lack of space releases it and runs again, while saves, refused too, pause
 * as "Storage full"; the reserve is taken back once space returns. Chromium keeps an open sync
 * access handle's storage counted until the handle closes, so the reserve holds its storage
 * through an open handle and releases it by emptying and closing the file.
 */
export class SpaceReserve {
  readonly #file: FileSystemFileHandle;
  readonly #bytes: number;
  /** Open while the reserve holds its storage. */
  #handle: FileSystemSyncAccessHandle | undefined;
  #closed = false;

  private constructor(file: FileSystemFileHandle, bytes: number) {
    this.#file = file;
    this.#bytes = bytes;
  }

  /** Opens the reserve in `directory` and holds it if there is room; none when `bytes` is 0. */
  static async open(directory: FileSystemDirectoryHandle, bytes: number): Promise<SpaceReserve | undefined> {
    if (bytes === 0) return undefined;
    const reserve = new SpaceReserve(await directory.getFileHandle(FILE, { create: true }), bytes);
    await reserve.hold();
    return reserve;
  }

  /** Holds the reserve again when the origin has room for it; whether it holds it now. */
  async hold(): Promise<boolean> {
    if (this.#handle !== undefined) return true;
    const handle = await this.#file.createSyncAccessHandle();
    // A disk closed meanwhile holds no reserve.
    if (this.#closed) {
      handle.close();
      return false;
    }
    try {
      handle.truncate(this.#bytes);
      handle.flush();
    } catch (error) {
      handle.close();
      if (refusedForSpace(error)) return false;
      throw normalizeStorageError(error);
    }
    this.#handle = handle;
    return true;
  }

  /** Gives the reserve's storage back to the origin; false when it held none. */
  release(): boolean {
    const handle = this.#handle;
    if (handle === undefined) return false;
    this.#handle = undefined;
    try {
      handle.truncate(0);
      handle.flush();
    } finally {
      handle.close();
    }
    return true;
  }

  /** Releases the reserve, so a closed generation holds none. */
  close(): void {
    this.#closed = true;
    this.release();
  }
}

/** Whether the browser refused a write for lack of space. */
export function refusedForSpace(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "QuotaExceededError")
    || (error instanceof VMError && error.code === "QUOTA_EXCEEDED");
}
