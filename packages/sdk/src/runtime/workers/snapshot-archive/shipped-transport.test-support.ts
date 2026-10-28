import { createHash } from "node:crypto";
import { encodeCheckpointDeclaration } from "../userspace-checkpoint/framing.js";
import { checkpointHeader } from "../userspace-checkpoint.js";
import { SNAPSHOT_CHUNK_BYTES, type ChunkRef } from "../snapshot-manifest.js";
import type { SnapshotStream } from "../snapshot-userspace-manifest.js";

export const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Deterministic, non-repeating bytes. */
export function filled(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = (index * 31 + seed) & 0xff;
  return bytes;
}

/** An OXUP payload stream: header, then each declaration followed by its bytes. */
export function payloadStream(payloads: readonly { readonly kind: 0n | 1n; readonly bytes: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const header = checkpointHeader("OXUP", 16); new DataView(header.buffer).setBigUint64(8, BigInt(payloads.length), true);
  const parts: Uint8Array[] = [header];
  payloads.forEach((payload, index) => {
    parts.push(encodeCheckpointDeclaration({ reference: BigInt(index + 1), kind: payload.kind, length: BigInt(payload.bytes.length) }), payload.bytes);
  });
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

/** `bytes` as 1 MiB chunks, with each chunk's content. */
export function chunked(bytes: Uint8Array): { readonly stream: SnapshotStream; readonly contents: ReadonlyMap<string, Uint8Array<ArrayBuffer>> } {
  const chunks: ChunkRef[] = [], contents = new Map<string, Uint8Array<ArrayBuffer>>();
  for (let offset = 0, index = 0; offset < bytes.length; offset += SNAPSHOT_CHUNK_BYTES, index++) {
    const piece = bytes.slice(offset, Math.min(bytes.length, offset + SNAPSHOT_CHUNK_BYTES));
    chunks.push({ index, sha256: sha(piece), bytes: piece.length }); contents.set(sha(piece), piece);
  }
  return { stream: { bytes: bytes.length, chunks }, contents };
}

/** A machine that loaded one image binary and one library: its payloads and the image files. */
export function loadedMachine(): { readonly stream: Uint8Array<ArrayBuffer>; readonly files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>; readonly sizes: ReadonlyMap<string, number> } {
  const binary = filled(2 * SNAPSHOT_CHUNK_BYTES + 123_457, 7), library = filled(4_096 * 3 + 11, 3), page = filled(4_096, 9);
  const stream = payloadStream([{ kind: 1n, bytes: page }, { kind: 0n, bytes: binary }, { kind: 0n, bytes: filled(binary.length, 1) }, { kind: 0n, bytes: library }, { kind: 1n, bytes: page }]);
  const files = new Map([[sha(binary), binary], [sha(library), library]]);
  return { stream, files, sizes: new Map([...files].map(([hash, bytes]) => [hash, bytes.length])) };
}
