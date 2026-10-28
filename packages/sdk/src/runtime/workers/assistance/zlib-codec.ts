import { Buffer } from "buffer";
import {
  ZStream, zlibDeflateInit2, zlibDeflate, zlibDeflateEnd, zlibDeflateReset, zlibDeflateSetDictionary,
  zlibInflateInit2, zlibInflate, zlibInflateEnd, zlibInflateReset, zlibInflateSetDictionary,
  Z_OK, Z_STREAM_END, Z_NEED_DICT, Z_DATA_ERROR, Z_BUF_ERROR, Z_FINISH, type Z_CallStatus, type Z_FlushMode,
} from "pako";
import { unavailableNodeApi } from "./node-capability.ts";

export type CompressionMode = "deflate" | "gzip" | "deflateRaw" | "inflate" | "gunzip" | "inflateRaw" | "unzip";

/** One codec state for both synchronous calls and Node streams. Yielding each
 * bounded output chunk lets the existing stream owner apply backpressure. */
export class ZlibCodec {
  readonly #stream = new ZStream();
  readonly #mode: CompressionMode;
  readonly #encode: boolean;
  readonly #dictionary: Uint8Array | undefined;
  readonly #chunkSize: number;
  #gzip: boolean | undefined;
  #ended = false;
  #closed = false;
  #active = false;
  #bytesWritten = 0;
  readonly finishFlush: Z_FlushMode;
  readonly flush: Z_FlushMode;
  readonly maxOutputLength: number;

  constructor(mode: CompressionMode, options?: unknown, api = `zlib.${mode}Sync`) {
    const opts = typeof options === "object" && options !== null ? options : {};
    const option = (name: string): unknown => Reflect.get(opts, name);
    // Node preserves this historical raw-deflate option normalization in place.
    if (mode === "deflateRaw" && option("windowBits") === 8 && !Reflect.set(opts, "windowBits", 9)) throw new TypeError("Cannot update windowBits");
    const info = Boolean(option("info"));
    if (info) unavailableNodeApi(`${api} info`);
    this.#mode = mode;
    this.#encode = mode === "deflate" || mode === "deflateRaw" || mode === "gzip";
    const automaticWindow = !this.#encode && mode !== "inflateRaw" && option("windowBits") === 0;
    const window = automaticWindow ? 0 : compressionNumber(option("windowBits"), "windowBits", 15, mode === "gzip" ? 9 : 8, 15);
    const bits = mode === "deflateRaw" || mode === "inflateRaw" ? -Math.max(window, 8)
      : mode === "gzip" || mode === "gunzip" ? window + 16 : mode === "unzip" ? window + 32 : window;
    this.#chunkSize = compressionNumber(option("chunkSize"), "chunkSize", 16384, 64, 0x7fff_ffff);
    this.maxOutputLength = compressionNumber(option("maxOutputLength"), "maxOutputLength", 0x7fff_ffff, 1, 0x7fff_ffff);
    this.finishFlush = compressionFlush(option("finishFlush"), Z_FINISH);
    if (this.finishFlush === 5) unavailableNodeApi(`${api} finishFlush Z_BLOCK`);
    this.flush = compressionFlush(option("flush"), 0);
    this.#dictionary = option("dictionary") === undefined ? undefined : compressionBytes(option("dictionary"), false);
    this.#gzip = mode === "unzip" ? undefined : mode === "gunzip";
    const stream = this.#stream;
    const status = this.#encode
      ? zlibDeflateInit2(stream, compressionNumber(option("level"), "level", -1, -1, 9), 8, bits,
        compressionNumber(option("memLevel"), "memLevel", 8, 1, 9), compressionNumber(option("strategy"), "strategy", 0, 0, 4))
      : zlibInflateInit2(stream, bits);
    if (status !== Z_OK) throw zlibError(status, stream.msg);
    try { this.#setDictionary(); } catch (error) { this.close(); throw error; }
  }

  get bytesWritten(): number { return this.#bytesWritten; }

  *write(input: Uint8Array, flush: Z_FlushMode): Generator<Uint8Array, void> {
    if (this.#closed || this.#active) throw Object.assign(new Error("Compression stream is closed or busy"), { code: "ERR_STREAM_DESTROYED" });
    if (flush === 5) unavailableNodeApi(`zlib.${this.#mode} flush Z_BLOCK`);
    if (this.#gzip === undefined && input.length !== 0) this.#gzip = input[0] === 0x1f;
    const stream = this.#stream;
    if (this.#ended) {
      if (this.#gzip === true && input.length !== 0 && input[0] !== 0) { zlibInflateReset(stream); this.#ended = false; }
      else if (this.#encode && input.length !== 0) throw zlibError(-2, "stream error");
      else return;
    }
    this.#active = true;
    stream.input = input; stream.next_in = 0; stream.avail_in = input.length;
    try {
      for (;;) {
        stream.output = new Uint8Array(Math.min(this.#chunkSize, 65536));
        stream.next_out = 0; stream.avail_out = stream.output.length;
        let result = this.#encode ? zlibDeflate(stream, flush) : zlibInflate(stream, flush);
        if (result === Z_NEED_DICT && this.#dictionary !== undefined) {
          result = zlibInflateSetDictionary(stream, this.#dictionary);
          if (result === Z_DATA_ERROR) throw zlibError(Z_NEED_DICT, "Bad dictionary");
          if (result === Z_OK) result = zlibInflate(stream, flush);
        }
        while (result === Z_STREAM_END && this.#gzip === true && stream.avail_in > 0 && input[stream.next_in] !== 0) {
          const reset = zlibInflateReset(stream);
          if (reset !== Z_OK) throw zlibError(reset, stream.msg);
          result = zlibInflate(stream, flush);
        }
        if (result !== Z_OK && result !== Z_STREAM_END && result !== Z_BUF_ERROR) throw zlibError(result, stream.msg);
        if (result === Z_BUF_ERROR && flush === Z_FINISH && stream.avail_out !== 0) throw zlibError(result, "unexpected end of file");
        this.#ended = result === Z_STREAM_END;
        if (stream.next_out !== 0) yield stream.output.subarray(0, stream.next_out);
        if (result === Z_STREAM_END) return;
        if (stream.avail_out === 0) continue;
        if (flush === Z_FINISH) throw zlibError(Z_BUF_ERROR, "unexpected end of file");
        return;
      }
    } finally { this.#bytesWritten += stream.next_in; this.#active = false; }
  }

  reset(): void {
    // A yielded chunk has completed its codec call. Node permits reset from
    // its data callback, including ws's oversized-payload handling path.
    if (this.#closed) throw Object.assign(new Error("Compression stream is closed"), { code: "ERR_STREAM_DESTROYED" });
    const status = this.#encode ? zlibDeflateReset(this.#stream) : zlibInflateReset(this.#stream);
    if (status !== Z_OK) throw zlibError(status, this.#stream.msg);
    this.#ended = false; this.#gzip = this.#mode === "unzip" ? undefined : this.#mode === "gunzip";
    this.#setDictionary();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#encode) zlibDeflateEnd(this.#stream); else zlibInflateEnd(this.#stream);
  }

  #setDictionary(): void {
    if (this.#dictionary === undefined || (!this.#encode && this.#mode !== "inflateRaw")) return;
    const result = this.#encode ? zlibDeflateSetDictionary(this.#stream, this.#dictionary) : zlibInflateSetDictionary(this.#stream, this.#dictionary);
    if (result !== Z_OK) throw zlibError(result, this.#stream.msg);
  }
}

export function compressionBytes(value: unknown, string = true): Uint8Array {
  if (string && typeof value === "string") return Buffer.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw Object.assign(new TypeError("Compression input must be bytes or a string"), { code: "ERR_INVALID_ARG_TYPE" });
}

export function compressionNumber(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || (typeof value === "number" && Number.isNaN(value))) return fallback;
  if (typeof value !== "number") throw Object.assign(new TypeError(`${name} must be a number`), { code: "ERR_INVALID_ARG_TYPE" });
  if (value < minimum || value > maximum) throw Object.assign(new RangeError(`${name} is out of range`), { code: "ERR_OUT_OF_RANGE" });
  return Math.trunc(value);
}

export function compressionFlush(value: unknown, fallback: Z_FlushMode): Z_FlushMode {
  const selected = compressionNumber(value, "flush", fallback, 0, 5);
  switch (selected) {
    case 0: case 1: case 2: case 3: case 4: case 5: return selected;
    default: throw new RangeError("Invalid compression flush mode");
  }
}

export function compressionLimit(limit: number): RangeError {
  return Object.assign(new RangeError(`Cannot create a Buffer larger than ${limit} bytes`), { code: "ERR_BUFFER_TOO_LARGE" });
}

function zlibError(errno: Z_CallStatus, message: string): Error {
  const codes = { [-1]: "Z_ERRNO", [-2]: "Z_STREAM_ERROR", [-3]: "Z_DATA_ERROR", [-4]: "Z_MEM_ERROR", [-5]: "Z_BUF_ERROR", 2: "Z_NEED_DICT" };
  const code = errno === -1 || errno === -2 || errno === -3 || errno === -4 || errno === -5 || errno === 2 ? codes[errno] : "Z_STREAM_ERROR";
  return Object.assign(new Error(message || code), { errno, code });
}
