import { VMError } from "../errors.js";

/** A whole immutable blob as the storage client returns it: its bytes and their verified digest. */
export interface VerifiedBlob {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly sha256: string;
}

/**
 * Serves ranges of large immutable blobs. The first range loads and verifies the whole blob once;
 * later ranges slice that verified copy, and the last range releases it. The copy is pinned here
 * rather than in the shared managed cache, so a blob above one transfer's bound cannot displace the
 * system binaries that cache holds.
 */
export class UserspaceRangedReads {
  readonly #loads = new Map<string, Promise<VerifiedBlob>>();

  /** Returns `[offset, offset + length)` of the blob at `path`, loading the blob only when none is pinned. */
  async range(
    path: string,
    expectedSha256: string,
    expectedBytes: number,
    offset: number,
    length: number,
    load: () => Promise<VerifiedBlob>,
  ): Promise<VerifiedBlob> {
    if (
      !Number.isSafeInteger(offset)
      || !Number.isSafeInteger(length)
      || offset < 0
      || length <= 0
      || offset + length > expectedBytes
    ) {
      throw new VMError("PROTOCOL_ERROR", "ranged read is outside its file");
    }
    const key = `${path}\0${expectedSha256}\0${expectedBytes}`;
    let pending = this.#loads.get(key);
    if (pending === undefined) {
      const started = load();
      pending = started;
      this.#loads.set(key, started);
      // A failed load is not kept, so the next range loads again.
      started.catch(() => {
        if (this.#loads.get(key) === started) this.#loads.delete(key);
      });
    }
    const blob = await pending;
    if (blob.bytes.byteLength !== expectedBytes) {
      this.#loads.delete(key);
      throw new VMError("PROTOCOL_ERROR", "ranged blob length does not match its host request");
    }
    if (blob.sha256 !== expectedSha256) {
      this.#loads.delete(key);
      throw new VMError("PROTOCOL_ERROR", "ranged blob digest does not match its host request");
    }
    if (offset + length === expectedBytes) this.#loads.delete(key);
    return { bytes: blob.bytes.subarray(offset, offset + length), sha256: blob.sha256 };
  }

  /** Drops every pinned copy, when the runtime that read them is disposed. */
  clear(): void {
    this.#loads.clear();
  }
}
