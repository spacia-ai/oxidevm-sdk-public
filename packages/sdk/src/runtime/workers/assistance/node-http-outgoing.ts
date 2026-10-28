import { Buffer } from "buffer";
import { Writable } from "readable-stream";

export type HeaderValue = string | number | readonly string[];
type Header = { readonly name: string; readonly value: HeaderValue };

/** Shared outgoing header authority for server responses and client requests. */
export class HttpOutgoing extends Writable {
  protected readonly headerFields = new Map<string, Header>();
  protected headerBlock: Buffer | undefined;
  get headersSent(): boolean { return this.headerBlock !== undefined; }
  get _header(): string | null { return this.headerBlock?.toString("latin1") ?? null; }
  setHeader(name: unknown, value: unknown): this {
    this.assertHeadersMutable(); const key = headerName(name); const decoded = headerValue(value);
    if (!this.headerFields.has(key) && this.headerFields.size >= 128) throw failureOf("ERR_HTTP_HEADERS_OVERFLOW", "Too many HTTP headers");
    this.headerFields.set(key, { name: String(name), value: decoded }); return this;
  }
  appendHeader(name: unknown, value: unknown): this {
    const key = headerName(name); const old = this.headerFields.get(key)?.value;
    const values = headerValue(value);
    return this.setHeader(name, old === undefined ? values : [...items(old), ...items(values)]);
  }
  getHeader(name: unknown): HeaderValue | undefined { return this.headerFields.get(headerName(name))?.value; }
  hasHeader(name: unknown): boolean { return this.headerFields.has(headerName(name)); }
  getHeaderNames(): string[] { return [...this.headerFields.keys()]; }
  getRawHeaderNames(): string[] { return [...this.headerFields.values()].map(header => header.name); }
  getHeaders(): Record<string, HeaderValue> {
    const result = Object.fromEntries([...this.headerFields].map(([name, header]) => [name, header.value]));
    Object.setPrototypeOf(result, null); return result;
  }
  removeHeader(name: unknown): void {
    this.assertHeadersMutable(); const key = headerName(name); this.headerFields.delete(key);
  }
  protected assertHeadersMutable(): void {
    if (this.headersSent) throw failureOf("ERR_HTTP_HEADERS_SENT", "HTTP headers already sent");
  }
  protected sealHeaders(startLine: string): void {
    const text = `${startLine}\r\n${[...this.headerFields.values()].map(header => items(header.value).map(value => `${header.name}: ${value}\r\n`).join("")).join("")}\r\n`;
    if (Buffer.byteLength(text, "latin1") > 65536) throw failureOf("ERR_HTTP_HEADERS_OVERFLOW", "HTTP headers exceed their bound");
    this.headerBlock = Buffer.from(text, "latin1");
  }
}
export function failureOf(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
export function headerName(value: unknown): string {
  if (typeof value !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(value)) throw failureOf("ERR_INVALID_HTTP_TOKEN", "Invalid HTTP header name");
  return value.toLowerCase();
}
export function headerValue(value: unknown): HeaderValue {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && !/[^\t\x20-\x7e\x80-\xff]/u.test(value)) return value;
  if (Array.isArray(value) && value.length <= 128) {
    const items: unknown[] = value; const decoded: string[] = [];
    for (const item of items) {
      if (typeof item !== "string" || /[^\t\x20-\x7e\x80-\xff]/u.test(item)) throw failureOf("ERR_INVALID_CHAR", "Invalid HTTP header value");
      decoded.push(item);
    }
    return decoded;
  }
  throw failureOf("ERR_INVALID_CHAR", "Invalid HTTP header value");
}
export function items(value: HeaderValue): readonly string[] { return typeof value === "object" ? value : [String(value)]; }
export function headerEntries(value: unknown): [string, unknown][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("HTTP headers require an object");
  const entries: [string, unknown][] = Object.entries(value);
  if (entries.length > 128) throw failureOf("ERR_HTTP_HEADERS_OVERFLOW", "Too many HTTP headers");
  return entries;
}

export function framingLength(length: HeaderValue | undefined, encoding: HeaderValue | undefined): number | undefined {
  if (length !== undefined && encoding !== undefined) throw failureOf("ERR_HTTP_INVALID_HEADER_VALUE", "Ambiguous HTTP framing");
  if (length !== undefined && ((typeof length !== "string" && typeof length !== "number") || !/^[0-9]+$/u.test(String(length)) || !Number.isSafeInteger(Number(length)))) throw failureOf("ERR_HTTP_INVALID_HEADER_VALUE", "Invalid Content-Length");
  if (encoding !== undefined && (typeof encoding !== "string" || encoding.toLowerCase() !== "chunked")) throw failureOf("ERR_HTTP_INVALID_HEADER_VALUE", "Unsupported Transfer-Encoding");
  return length === undefined ? undefined : Number(length);
}
