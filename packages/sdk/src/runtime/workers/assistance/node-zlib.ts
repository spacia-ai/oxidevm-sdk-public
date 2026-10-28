import { Buffer } from "buffer";
import { Z_OK, Z_STREAM_END, Z_NEED_DICT, Z_BUF_ERROR, Z_FINISH } from "pako";
import { unavailableNodeApi } from "./node-capability.ts";
import { ZlibCodec, compressionBytes, compressionLimit, type CompressionMode } from "./zlib-codec.ts";

/** Synchronous calls drain the same codec used by streaming operations. */
function compress(mode: CompressionMode, value: unknown, options?: unknown): Buffer {
  const input = compressionBytes(value);
  const codec = new ZlibCodec(mode, options);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (const chunk of codec.write(input, codec.finishFlush)) {
      length += chunk.length;
      if (length > codec.maxOutputLength) throw compressionLimit(codec.maxOutputLength);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  } finally { codec.close(); }
}

export const nodeZlibSync = {
  deflateSync: (input: unknown, options?: unknown) => compress("deflate", input, options),
  deflateRawSync: (input: unknown, options?: unknown) => compress("deflateRaw", input, options),
  gzipSync: (input: unknown, options?: unknown) => compress("gzip", input, options),
  inflateSync: (input: unknown, options?: unknown) => compress("inflate", input, options),
  inflateRawSync: (input: unknown, options?: unknown) => compress("inflateRaw", input, options),
  gunzipSync: (input: unknown, options?: unknown) => compress("gunzip", input, options),
  unzipSync: (input: unknown, options?: unknown) => compress("unzip", input, options),
};

const unavailable = Object.fromEntries([
  "BrotliCompress", "BrotliDecompress",
  "createBrotliCompress", "createBrotliDecompress", "brotliCompress", "brotliDecompress", "brotliCompressSync", "brotliDecompressSync",
  "ZstdCompress", "ZstdDecompress", "createZstdCompress", "createZstdDecompress", "zstdCompress", "zstdDecompress", "zstdCompressSync", "zstdDecompressSync", "crc32",
].map(api => [api, function (): never { return unavailableNodeApi(`zlib.${api}`); }]));

// Published zlib numeric ABI and Node's option defaults; no codec state lives here.
const constants = Object.freeze({
  Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH, Z_BLOCK: 5,
  Z_OK, Z_STREAM_END, Z_NEED_DICT, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR, Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
  Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15,
  Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity, Z_DEFAULT_CHUNK: 16384,
  Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8, Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1,
  BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2, BROTLI_OPERATION_EMIT_METADATA: 3,
  BROTLI_PARAM_MODE: 0, BROTLI_PARAM_QUALITY: 1, BROTLI_PARAM_LGWIN: 2, BROTLI_PARAM_LGBLOCK: 3,
  BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4, BROTLI_PARAM_SIZE_HINT: 5, BROTLI_PARAM_LARGE_WINDOW: 6,
  BROTLI_PARAM_NPOSTFIX: 7, BROTLI_PARAM_NDIRECT: 8,
  BROTLI_MODE_GENERIC: 0, BROTLI_MODE_TEXT: 1, BROTLI_MODE_FONT: 2,
  BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0, BROTLI_DECODER_PARAM_LARGE_WINDOW: 1,
});
export const nodeZlib = { ...unavailable, ...nodeZlibSync, ...constants, constants };
