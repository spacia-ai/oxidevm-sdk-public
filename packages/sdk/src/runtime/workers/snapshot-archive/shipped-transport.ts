import { exactKeys, integer, record, string } from "../../decode.js";
import { VMError } from "../../errors.js";
import { decodeCheckpointDeclaration } from "../userspace-checkpoint/framing.js";
import { checkHeader } from "../userspace-checkpoint/stream.js";
import { sha256Hex } from "../snapshot-content.js";
import { SNAPSHOT_CHUNK_BYTES, type ChunkRef } from "../snapshot-manifest.js";
import type { SnapshotStream } from "../snapshot-userspace-manifest.js";

/**
 * How a shipped Userspace start leaves out what its image already holds. Programs a captured
 * machine had loaded (dockerd, its libraries) sit in the payload stream as blobs byte-identical to
 * image files; the shipped bundle omits those ranges and the installer reads them back from the
 * image. `literal` is the payload stream with the ranges removed, cut into chunks; the manifest's
 * own `payloads` still names every original chunk, so a rebuild is checked chunk by chunk.
 */
export interface ShippedTransport {
  readonly kind: "image-files";
  readonly literal: SnapshotStream;
  /** Ranges of the payload stream that are image files, ascending and disjoint. */
  readonly images: readonly ShippedImageRange[];
}

export interface ShippedImageRange {
  /** Where the file's bytes start in the payload stream. */
  readonly offset: number;
  readonly bytes: number;
  /** The image file (its blob) the range holds. */
  readonly sha256: string;
}

const MAX_RANGES = 4096;
const MAX_BLOB_BYTES = 1024 ** 3;
const DECLARATION_BYTES = 24;
const HEADER_BYTES = 16;

/**
 * The blobs of an OXUP payload stream whose bytes are an image file. Only blobs whose length is
 * the length of some image file are hashed.
 */
export async function findImageRanges(stream: Uint8Array<ArrayBuffer>, imageFiles: ReadonlyMap<string, number>): Promise<ShippedImageRange[]> {
  if (stream.length < HEADER_BYTES) invalid();
  checkHeader(stream.subarray(0, HEADER_BYTES), "OXUP");
  const count = new DataView(stream.buffer, stream.byteOffset, stream.byteLength).getBigUint64(8, true);
  const sizes = new Set(imageFiles.values());
  const ranges: ShippedImageRange[] = [];
  let offset = HEADER_BYTES, previous = 0n;
  for (let index = 0n; index < count; index++) {
    if (offset + DECLARATION_BYTES > stream.length) invalid();
    const declaration = decodeCheckpointDeclaration(stream.subarray(offset, offset + DECLARATION_BYTES), previous);
    previous = declaration.reference; offset += DECLARATION_BYTES;
    const length = Number(declaration.length);
    if (offset + length > stream.length) invalid();
    if (declaration.kind === 0n && length > 0 && sizes.has(length) && ranges.length < MAX_RANGES) {
      const sha256 = await sha256Hex(stream.slice(offset, offset + length));
      if (imageFiles.get(sha256) === length) ranges.push({ offset, bytes: length, sha256 });
    }
    offset += length;
  }
  if (offset !== stream.length) invalid();
  return ranges;
}

/** The payload stream without `ranges`. */
export function withoutRanges(stream: Uint8Array, ranges: readonly ShippedImageRange[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(stream.length - ranges.reduce((sum, range) => sum + range.bytes, 0));
  let from = 0, to = 0;
  for (const range of ranges) {
    output.set(stream.subarray(from, range.offset), to); to += range.offset - from; from = range.offset + range.bytes;
  }
  output.set(stream.subarray(from), to);
  return output;
}

/** `bytes` cut into the standard 1 MiB chunks, each named by its SHA-256. */
export async function chunkStream(bytes: Uint8Array): Promise<SnapshotStream> {
  const chunks: ChunkRef[] = [];
  for (let offset = 0, index = 0; offset < bytes.length; offset += SNAPSHOT_CHUNK_BYTES, index++) {
    const piece = bytes.slice(offset, Math.min(bytes.length, offset + SNAPSHOT_CHUNK_BYTES));
    chunks.push({ index, sha256: await sha256Hex(piece), bytes: piece.length });
  }
  return { bytes: bytes.length, chunks };
}

/**
 * The bytes of original payload chunk `chunk`: literal bytes read through `readLiteral` (an offset
 * in the literal stream) and image bytes through `readImage` (an offset in that image file).
 */
export async function rebuildChunk(
  chunk: ChunkRef,
  transport: ShippedTransport,
  readLiteral: (offset: number, length: number) => Promise<Uint8Array>,
  readImage: (range: ShippedImageRange, offset: number, length: number) => Promise<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Uint8Array(chunk.bytes);
  const start = chunk.index * SNAPSHOT_CHUNK_BYTES, end = start + chunk.bytes;
  let position = start, removed = 0;
  for (const range of transport.images) {
    const rangeEnd = range.offset + range.bytes;
    if (rangeEnd <= position) { removed += range.bytes; continue; }
    if (range.offset >= end) break;
    if (range.offset > position) {
      await place(output, position - start, await readLiteral(position - removed, range.offset - position));
      position = range.offset;
    }
    const take = Math.min(end, rangeEnd) - position;
    await place(output, position - start, await readImage(range, position - range.offset, take));
    position += take;
    if (position === rangeEnd) removed += range.bytes;
    if (position === end) return output;
  }
  if (position < end) await place(output, position - start, await readLiteral(position - removed, end - position));
  return output;
}

function place(output: Uint8Array, at: number, bytes: Uint8Array): Promise<void> {
  if (at + bytes.length > output.length) invalid();
  output.set(bytes, at);
  return Promise.resolve();
}

/** Canonical JSON: fixed key order, no whitespace. */
export function transportBytes(transport: ShippedTransport): string {
  const stream = (value: SnapshotStream): string => `{"bytes":${String(value.bytes)},"chunks":[${value.chunks.map(chunk =>
    `{"index":${String(chunk.index)},"sha256":${JSON.stringify(chunk.sha256)},"bytes":${String(chunk.bytes)}}`).join(",")}]}`;
  return `{"kind":"image-files","literal":${stream(transport.literal)},"images":[${transport.images.map(range =>
    `{"offset":${String(range.offset)},"bytes":${String(range.bytes)},"sha256":${JSON.stringify(range.sha256)}}`).join(",")}]}`;
}

/** Decodes `value` for the payload stream `payloads`: ranges inside it, ascending and disjoint. */
export function decodeShippedTransport(value: unknown, payloads: SnapshotStream): ShippedTransport {
  try {
    const input = record(value, "shipped transport"); exactKeys(input, ["kind", "literal", "images"]);
    if (input["kind"] !== "image-files" || !Array.isArray(input["images"])) invalid();
    const literal = decodeStream(input["literal"]);
    const rawImages: readonly unknown[] = input["images"];
    if (rawImages.length > MAX_RANGES) invalid();
    const images: ShippedImageRange[] = [];
    let end = HEADER_BYTES, removed = 0;
    for (const raw of rawImages) {
      const range = record(raw, "shipped image range"); exactKeys(range, ["offset", "bytes", "sha256"]);
      const offset = integer(range["offset"], "image range offset", HEADER_BYTES, payloads.bytes);
      const bytes = integer(range["bytes"], "image range bytes", 1, MAX_BLOB_BYTES);
      const sha256 = string(range["sha256"], "image range hash");
      if (!/^[0-9a-f]{64}$/u.test(sha256) || offset < end || offset + bytes > payloads.bytes) invalid();
      images.push({ offset, bytes, sha256 }); end = offset + bytes; removed += bytes;
    }
    if (literal.bytes + removed !== payloads.bytes) invalid();
    return { kind: "image-files", literal, images };
  } catch (error) {
    if (error instanceof VMError && error.message === INVALID) throw error;
    invalid();
  }
}

function decodeStream(value: unknown): SnapshotStream {
  const input = record(value, "literal stream"); exactKeys(input, ["bytes", "chunks"]);
  const bytes = integer(input["bytes"], "literal bytes", 0, 16 * 1024 ** 3);
  const rawChunks = input["chunks"];
  if (!Array.isArray(rawChunks) || rawChunks.length !== Math.ceil(bytes / SNAPSHOT_CHUNK_BYTES)) invalid();
  const chunks = rawChunks.map((raw: unknown, index): ChunkRef => {
    const chunk = record(raw, "literal chunk"); exactKeys(chunk, ["index", "sha256", "bytes"]);
    const expected = Math.min(SNAPSHOT_CHUNK_BYTES, bytes - index * SNAPSHOT_CHUNK_BYTES);
    const sha256 = string(chunk["sha256"], "literal chunk hash");
    if (chunk["index"] !== index || chunk["bytes"] !== expected || !/^[0-9a-f]{64}$/u.test(sha256)) invalid();
    return { index, sha256, bytes: expected };
  });
  return { bytes, chunks };
}

const INVALID = "Shipped transport is invalid";
function invalid(): never { throw new VMError("PROTOCOL_ERROR", INVALID); }
