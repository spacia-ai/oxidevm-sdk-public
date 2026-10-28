import { sha256 } from "@noble/hashes/sha2.js";
import { VMError } from "../errors.js";
import type { ManagedImageChunk } from "../managed-image.js";

type Chunk = Pick<ManagedImageChunk, "bytes" | "sha256">;
const FRAME_BYTES = 65536;

/** A shared base's exclusive sync handle owns its chunk proofs until close or repair. */
export class ManagedBaseIntegrity {
  readonly identity: string;
  readonly #chunks: readonly (Chunk & { readonly offset: number; readonly end: number })[];
  readonly #verified = new Set<number>();
  readonly #scratch = new Uint8Array(FRAME_BYTES);

  constructor(chunks: readonly Chunk[], handle: FileSystemSyncAccessHandle) {
    this.identity = ManagedBaseIntegrity.identity(chunks);
    let offset = 0;
    this.#chunks = chunks.map(chunk => {
      if (!Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || !/^[0-9a-f]{64}$/u.test(chunk.sha256)
        || !Number.isSafeInteger(offset + chunk.bytes)) throw damaged();
      const item = { bytes: chunk.bytes, sha256: chunk.sha256, offset, end: offset + chunk.bytes };
      offset = item.end; return item;
    });
    if (handle.getSize() !== offset) throw damaged();
  }

  static identity(chunks: readonly Chunk[]): string {
    return JSON.stringify(chunks.map(chunk => [chunk.bytes, chunk.sha256]));
  }

  invalidate(): void { this.#verified.clear(); }

  verify(handle: FileSystemSyncAccessHandle, offset: number, bytes: number): void {
    const end = offset + bytes;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(end) || bytes < 0) throw damaged();
    if (bytes === 0) return;
    // Binary search the packed position, not the sparse guest disk index.
    let low = 0, high = this.#chunks.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2), chunk = this.#chunks[middle];
      if (chunk === undefined) throw damaged();
      if (chunk.end <= offset) low = middle + 1; else high = middle;
    }
    for (let index = low; index < this.#chunks.length; index++) {
      const chunk = this.#chunks[index]; if (chunk === undefined) throw damaged();
      if (chunk.offset >= end) break;
      if (this.#verified.has(index)) continue;
      const digest = sha256.create();
      for (let position = chunk.offset; position < chunk.end; position += FRAME_BYTES) {
        const buffer = this.#scratch.subarray(0, Math.min(FRAME_BYTES, chunk.end - position));
        if (handle.read(buffer, { at: position }) !== buffer.length) throw damaged();
        digest.update(buffer);
      }
      if ([...digest.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("") !== chunk.sha256) throw damaged();
      this.#verified.add(index);
    }
  }
}

function damaged(): VMError {
  return new VMError("STORAGE_ERROR", "Cached image chunk is damaged; repair the image cache", { reason: "image-not-cached" });
}
