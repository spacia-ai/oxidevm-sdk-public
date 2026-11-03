import { NetError } from "./errors.js";
import type { ByteStream } from "./streams.js";
import { concat } from "./tls.js";

/**
 * HTTP/1.1 on one connection (RFC 9112): the request head and body out, the response head and body framing in. Every
 * byte from the peer is hostile input: heads are bounded to 64 KiB and 512 fields, chunk-size lines to 4 KiB, and
 * lengths to safe integers. The body is read on demand, so nothing larger than one read is buffered.
 */
export const MAX_HEAD_BYTES = 64 * 1024;
const MAX_FIELDS = 512, MAX_CHUNK_LINE = 4096, READ_BYTES = 64 * 1024;
const encoder = new TextEncoder(), latin1 = new TextDecoder("latin1");

function parseError(message: string): NetError { return new NetError("ERR_HTTP_PARSE", `HTTP response: ${message}`); }

/** A connection with a read-ahead buffer, so a head and the start of a body can arrive in one read. */
export class BufferedStream {
  #buffer: Uint8Array = new Uint8Array();
  constructor(readonly stream: ByteStream) {}

  /** Bytes read ahead and not yet consumed. */
  get buffered(): number { return this.#buffer.length; }

  async #fill(signal: AbortSignal | undefined): Promise<boolean> {
    const bytes = await this.stream.read(READ_BYTES, signal);
    if (bytes.length === 0) return false;
    this.#buffer = this.#buffer.length === 0 ? bytes : concat([this.#buffer, bytes]);
    return true;
  }

  /** Bytes up to and including `delimiter`, or null at end of stream before any byte; at most `limit` bytes. */
  async until(delimiter: Uint8Array, limit: number, signal: AbortSignal | undefined, what: string): Promise<Uint8Array | null> {
    for (let searched = 0; ;) {
      const at = indexOf(this.#buffer, delimiter, Math.max(0, searched - delimiter.length + 1));
      if (at >= 0 && at + delimiter.length > limit) throw new NetError("ERR_HTTP_BOUNDS", `HTTP response: the ${what} exceeds ${String(limit)} bytes`);
      if (at >= 0) { const end = at + delimiter.length, line = this.#buffer.slice(0, end); this.#buffer = this.#buffer.subarray(end); return line; }
      if (this.#buffer.length > limit) throw new NetError("ERR_HTTP_BOUNDS", `HTTP response: the ${what} exceeds ${String(limit)} bytes`);
      searched = this.#buffer.length;
      if (!await this.#fill(signal)) {
        if (this.#buffer.length === 0) return null;
        throw parseError(`the connection ended inside the ${what}`);
      }
    }
  }

  /** Up to `max` bytes; empty at end of stream. */
  async read(max: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
    if (this.#buffer.length === 0 && !await this.#fill(signal)) return new Uint8Array();
    const count = Math.min(max, this.#buffer.length), out = this.#buffer.slice(0, count);
    this.#buffer = this.#buffer.subarray(count);
    return out;
  }
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let index = from; index <= haystack.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) if (haystack[index + offset] !== needle[offset]) continue outer;
    return index;
  }
  return -1;
}

const CRLF = encoder.encode("\r\n"), HEAD_END = encoder.encode("\r\n\r\n");
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

export interface RequestHead {
  readonly method: string;
  /** The request target: path and query. */
  readonly target: string;
  /** Field names and values in order, as sent. */
  readonly fields: readonly (readonly [string, string])[];
}

/** The request head's bytes. Names must be tokens and values must not contain CR, LF or NUL. */
export function encodeRequestHead(head: RequestHead): Uint8Array {
  if (!TOKEN.test(head.method)) throw new TypeError(`Invalid HTTP method ${head.method}`);
  if (/[\s\0]/u.test(head.target)) throw new TypeError("Invalid request target");
  const lines = [`${head.method} ${head.target} HTTP/1.1`];
  for (const [name, value] of head.fields) {
    if (!TOKEN.test(name)) throw new TypeError(`Invalid header name ${name}`);
    if (/[\r\n\0]/u.test(value)) throw new TypeError(`Invalid value for header ${name}`);
    lines.push(`${name}: ${value}`);
  }
  return encoder.encode(`${lines.join("\r\n")}\r\n\r\n`);
}

export interface ResponseHead {
  readonly status: number;
  readonly statusText: string;
  readonly minor: 0 | 1;
  /** Field names in lower case, values trimmed, in order. */
  readonly fields: readonly (readonly [string, string])[];
}

/** Reads one response head; null when the connection ended before it began (a stale keep-alive connection). */
export async function readResponseHead(reader: BufferedStream, signal: AbortSignal | undefined): Promise<ResponseHead | null> {
  const bytes = await reader.until(HEAD_END, MAX_HEAD_BYTES, signal, "response head");
  if (bytes === null) return null;
  const lines = latin1.decode(bytes.subarray(0, bytes.length - 4)).split("\r\n"), status = lines[0] ?? "";
  const match = /^HTTP\/1\.([01]) (\d{3})(?: (.*))?$/u.exec(status);
  if (match === null) throw parseError("invalid status line");
  if (lines.length - 1 > MAX_FIELDS) throw new NetError("ERR_HTTP_BOUNDS", `HTTP response: more than ${String(MAX_FIELDS)} header fields`);
  const fields: (readonly [string, string])[] = [];
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw parseError("invalid header line");
    const name = line.slice(0, colon);
    if (!TOKEN.test(name)) throw parseError(`invalid header name ${name.slice(0, 64)}`);
    fields.push([name.toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return { minor: match[1] === "0" ? 0 : 1, status: Number(match[2]), statusText: match[3] ?? "", fields };
}

export function field(head: ResponseHead, name: string): string | undefined {
  const values = head.fields.filter(([key]) => key === name).map(([, value]) => value);
  return values.length === 0 ? undefined : values.join(", ");
}

/** Whether the connection may carry another request after this response. */
export function keepsAlive(head: ResponseHead): boolean {
  const connection = (field(head, "connection") ?? "").toLowerCase().split(",").map(token => token.trim());
  return head.minor === 1 ? !connection.includes("close") : connection.includes("keep-alive");
}

/** A response body as it is read: chunks, then null at its end. `complete` says whether the connection can be reused. */
export interface BodySource {
  next(signal: AbortSignal | undefined): Promise<Uint8Array | null>;
  readonly delimited: boolean;
}

/** The body framing of a response to `method` (RFC 9112 section 6.3). */
export function bodySource(reader: BufferedStream, head: ResponseHead, method: string): BodySource {
  if (method === "HEAD" || head.status === 204 || head.status === 304 || head.status < 200) return { delimited: true, next: () => Promise.resolve(null) };
  const encoding = field(head, "transfer-encoding");
  if (encoding !== undefined) {
    if (encoding.toLowerCase().split(",").map(token => token.trim()).at(-1) !== "chunked") return closeDelimited(reader);
    return chunked(reader);
  }
  const lengths = head.fields.filter(([name]) => name === "content-length").flatMap(([, value]) => value.split(",").map(item => item.trim()));
  if (lengths.length > 0) {
    if (!lengths.every(item => /^\d{1,15}$/u.test(item) && item === lengths[0])) throw parseError("invalid Content-Length");
    return fixed(reader, Number(lengths[0]));
  }
  return closeDelimited(reader);
}

function fixed(reader: BufferedStream, length: number): BodySource {
  let remaining = length;
  return {
    delimited: true,
    next: async signal => {
      if (remaining === 0) return null;
      const bytes = await reader.read(Math.min(remaining, READ_BYTES), signal);
      if (bytes.length === 0) throw parseError(`the connection ended ${String(remaining)} bytes before the body's end`);
      remaining -= bytes.length;
      return bytes;
    },
  };
}

function closeDelimited(reader: BufferedStream): BodySource {
  return { delimited: false, next: async signal => { const bytes = await reader.read(READ_BYTES, signal); return bytes.length === 0 ? null : bytes; } };
}

function chunked(reader: BufferedStream): BodySource {
  let remaining = 0, done = false;
  const line = async (signal: AbortSignal | undefined): Promise<string> => {
    const bytes = await reader.until(CRLF, MAX_CHUNK_LINE, signal, "chunk header");
    if (bytes === null) throw parseError("the connection ended inside a chunked body");
    return latin1.decode(bytes.subarray(0, bytes.length - 2));
  };
  return {
    delimited: true,
    next: async signal => {
      while (!done) {
        if (remaining > 0) {
          const bytes = await reader.read(Math.min(remaining, READ_BYTES), signal);
          if (bytes.length === 0) throw parseError("the connection ended inside a chunk");
          remaining -= bytes.length;
          if (remaining === 0 && await line(signal) !== "") throw parseError("a chunk is not followed by CRLF");
          return bytes;
        }
        const size = (await line(signal)).split(";")[0]?.trim() ?? "";
        if (!/^[0-9a-fA-F]{1,13}$/u.test(size)) throw parseError("invalid chunk size");
        remaining = Number.parseInt(size, 16);
        if (remaining === 0) {
          // Trailer fields end with an empty line; they are read and dropped, within the head's bound.
          for (let total = 0; ;) { const trailer = await line(signal); total += trailer.length; if (trailer === "") break; if (total > MAX_HEAD_BYTES) throw new NetError("ERR_HTTP_BOUNDS", "HTTP response: trailers exceed 64 KiB"); }
          done = true;
        }
      }
      return null;
    },
  };
}
