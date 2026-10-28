import { exactKeys, integer, protocolError, record, string } from "./decode.js";
import { managedImageUrl } from "./managed-image.js";
import { rememberArtifactURL } from "./image-provenance.js";

export const ROOTFS_PACK_BYTES = 4 * 1024 ** 2;
export const ROOTFS_PACK_ENCODED_BYTES = ROOTFS_PACK_BYTES + 64 * 1024;
export interface RootfsBlobIdentity { readonly sha256: string; readonly bytes: number }
export interface RootfsPackExtent {
  readonly chunk: string; readonly offset: number; readonly bytes: number; readonly fileOffset: number;
}
export interface RootfsPackIndex {
  readonly version: 1;
  readonly chunks: readonly RootfsBlobIdentity[];
  readonly blobs: readonly { readonly sha256: string; readonly extents: readonly RootfsPackExtent[] }[];
}
export interface RootfsPackArtifact {
  readonly sha256: string; readonly encoding: "gzip"; readonly url: URL;
  readonly encodedBytes: number; readonly encodedSha256: string;
}
export interface UserspaceRootfsPacks { readonly index: RootfsPackIndex; readonly artifacts: readonly RootfsPackArtifact[] }

const MAX_BLOBS = 262_148, MAX_CHUNKS = 10_240;
function digest(value: unknown): string {
  const hash = string(value, "pack SHA-256");
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw protocolError("invalid rootfs pack digest");
  return hash;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw protocolError("rootfs pack index exceeds its bounds");
  return value;
}

/** The signed file identities remain authoritative for both downloaded and locally packed data. */
export function decodeRootfsPackIndex(value: unknown, expected: readonly RootfsBlobIdentity[]): RootfsPackIndex {
  const input = record(value, "rootfs pack index"); exactKeys(input, ["version", "chunks", "blobs"]);
  if (input["version"] !== 1) throw protocolError("unsupported rootfs pack index");
  const chunks = list(input["chunks"], MAX_CHUNKS).map(value => {
    const chunk = record(value, "rootfs pack chunk"); exactKeys(chunk, ["sha256", "bytes"]);
    return { sha256: digest(chunk["sha256"]), bytes: integer(chunk["bytes"], "pack bytes", 1, ROOTFS_PACK_BYTES) };
  });
  const byChunk = new Map(chunks.map(chunk => [chunk.sha256, chunk]));
  if (byChunk.size !== chunks.length) throw protocolError("duplicate rootfs pack chunk");
  const byBlob = new Map(expected.map(blob => [blob.sha256, blob])), seen = new Set<string>(), used = new Set<string>();
  let extentCount = 0;
  const blobs = list(input["blobs"], MAX_BLOBS).map(value => {
    const source = record(value, "packed rootfs blob"); exactKeys(source, ["sha256", "extents"]);
    const sha256 = digest(source["sha256"]), original = byBlob.get(sha256);
    if (original === undefined || seen.has(sha256)) throw protocolError("packed blob is unknown or duplicated");
    seen.add(sha256); let offset = 0;
    const extents = list(source["extents"], MAX_CHUNKS).map(value => {
      if (++extentCount > MAX_BLOBS + MAX_CHUNKS * 2) throw protocolError("rootfs pack extent count exceeds its bound");
      const extent = record(value, "rootfs pack extent"); exactKeys(extent, ["chunk", "offset", "bytes", "fileOffset"]);
      const chunk = digest(extent["chunk"]), physical = byChunk.get(chunk);
      const start = integer(extent["offset"], "pack offset", 0, ROOTFS_PACK_BYTES);
      const bytes = integer(extent["bytes"], "pack extent bytes", 1, ROOTFS_PACK_BYTES);
      const fileOffset = integer(extent["fileOffset"], "packed file offset", 0, 8 * 1024 ** 3);
      if (physical === undefined || start + bytes > physical.bytes || fileOffset !== offset || offset + bytes > original.bytes) {
        throw protocolError("rootfs pack extent is missing, overlapping or out of range");
      }
      offset += bytes; used.add(chunk);
      return { chunk, offset: start, bytes, fileOffset };
    });
    if (offset !== original.bytes) throw protocolError("rootfs pack file is incomplete");
    return { sha256, extents };
  });
  if (seen.size !== byBlob.size || used.size !== byChunk.size) throw protocolError("rootfs pack closure is incomplete");
  return { version: 1, chunks, blobs };
}

export function decodeUserspaceRootfsPacks(value: unknown, expected: readonly RootfsBlobIdentity[], base: URL): UserspaceRootfsPacks {
  const input = record(value, "rootfs packs"); exactKeys(input, ["index", "artifacts"]);
  const index = decodeRootfsPackIndex(input["index"], expected), chunks = new Set(index.chunks.map(chunk => chunk.sha256)), seen = new Set<string>();
  const artifacts = list(input["artifacts"], MAX_CHUNKS).map(value => {
    const source = record(value, "rootfs pack artifact"); exactKeys(source, ["sha256", "encoding", "url", "encodedBytes", "encodedSha256"]);
    const sha256 = digest(source["sha256"]), literal = string(source["url"], "pack URL");
    if (!chunks.has(sha256) || seen.has(sha256) || source["encoding"] !== "gzip") throw protocolError("invalid rootfs pack artifact");
    seen.add(sha256);
    return { sha256, encoding: "gzip" as const, url: rememberArtifactURL(managedImageUrl(literal, base), literal),
      encodedBytes: integer(source["encodedBytes"], "encoded pack bytes", 1, ROOTFS_PACK_ENCODED_BYTES), encodedSha256: digest(source["encodedSha256"]) };
  });
  if (seen.size !== chunks.size) throw protocolError("rootfs pack artifacts are incomplete");
  return { index, artifacts };
}
