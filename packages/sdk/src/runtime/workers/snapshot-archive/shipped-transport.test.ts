import { expect, it } from "vitest";
import { SNAPSHOT_CHUNK_BYTES } from "../snapshot-manifest.js";
import { chunked, filled, payloadStream, sha } from "./shipped-transport.test-support.js";
import {
  chunkStream, decodeShippedTransport, findImageRanges, rebuildChunk, transportBytes, withoutRanges,
  type ShippedTransport,
} from "./shipped-transport.js";

const binary = filled(2 * SNAPSHOT_CHUNK_BYTES + 123_457, 7); // an image file loaded into memory
const library = filled(4_096 * 3 + 11, 3);
const page = filled(4_096, 9);
const otherBlob = filled(binary.length, 1); // same size as the image file, different bytes
const stream = payloadStream([{ kind: 1n, bytes: page }, { kind: 0n, bytes: binary }, { kind: 0n, bytes: otherBlob }, { kind: 0n, bytes: library }, { kind: 1n, bytes: page }]);
const imageFiles = new Map([[sha(binary), binary.length], [sha(library), library.length], [sha(page), page.length]]);

it("finds the blobs that are byte-identical to an image file and nothing else", async () => {
  const ranges = await findImageRanges(stream, imageFiles);
  expect(ranges.map(range => range.sha256)).toEqual([sha(binary), sha(library)]);
  for (const range of ranges) expect(sha(stream.subarray(range.offset, range.offset + range.bytes))).toBe(range.sha256);
});

it("finds no ranges when no blob matches an image file", async () => {
  await expect(findImageRanges(stream, new Map([[sha(filled(99, 2)), 99]]))).resolves.toEqual([]);
});

it("rebuilds every original chunk exactly from the literal stream and the image files", async () => {
  const ranges = await findImageRanges(stream, imageFiles);
  const literal = withoutRanges(stream, ranges);
  expect(literal.length).toBe(stream.length - binary.length - library.length);
  const transport: ShippedTransport = { kind: "image-files", literal: await chunkStream(literal), images: ranges };
  const files = new Map([[sha(binary), binary], [sha(library), library]]);
  for (const chunk of chunked(stream).stream.chunks) {
    const rebuilt = await rebuildChunk(chunk, transport,
      (offset, length) => Promise.resolve(literal.slice(offset, offset + length)),
      (range, offset, length) => Promise.resolve((files.get(range.sha256) ?? new Uint8Array()).slice(offset, offset + length)));
    expect(sha(rebuilt)).toBe(chunk.sha256);
  }
});

it("decodes a transport exactly and rejects inconsistent geometry", async () => {
  const payloads = chunked(stream).stream;
  const ranges = await findImageRanges(stream, imageFiles);
  const transport: ShippedTransport = { kind: "image-files", literal: await chunkStream(withoutRanges(stream, ranges)), images: ranges };
  const encoded: unknown = JSON.parse(transportBytes(transport));
  expect(decodeShippedTransport(encoded, payloads)).toEqual(transport);
  const [first, second] = ranges;
  if (first === undefined || second === undefined) throw new Error("expected two ranges");
  for (const bad of [
    { ...transport, extra: 1 },
    { ...transport, kind: "other" },
    { ...transport, images: [second, first] },
    { ...transport, images: [first, { ...second, offset: first.offset }] },
    { ...transport, images: [first, { ...second, offset: stream.length }] },
    { ...transport, images: [first, { ...second, sha256: "x" }] },
    { ...transport, literal: { ...transport.literal, bytes: transport.literal.bytes + 1 } },
  ]) expect(() => decodeShippedTransport(JSON.parse(JSON.stringify(bad)), payloads)).toThrow();
});
