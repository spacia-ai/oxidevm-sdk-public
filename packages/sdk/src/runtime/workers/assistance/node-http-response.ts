import { Buffer } from "buffer";
import type { Writable } from "readable-stream";
import { HttpOutgoing, framingLength, failureOf, headerName, headerValue, headerEntries, items } from "./node-http-outgoing.js";
import type { AsyncContext } from "./async-context.js";
import { bindAsyncEvents, bindAsyncWritable, isEventListener, streamError } from "./node-streams.js";

type Request = { readonly method: string; readonly major: number; readonly minor: number; readonly keepAlive: boolean };
const reasons: Readonly<Record<number, string>> = {
  100: "Continue", 101: "Switching Protocols", 102: "Processing", 103: "Early Hints",
  200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information", 204: "No Content", 205: "Reset Content", 206: "Partial Content", 207: "Multi-Status", 208: "Already Reported", 226: "IM Used",
  300: "Multiple Choices", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified", 305: "Use Proxy", 307: "Temporary Redirect", 308: "Permanent Redirect",
  400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable", 407: "Proxy Authentication Required", 408: "Request Timeout", 409: "Conflict", 410: "Gone", 411: "Length Required", 412: "Precondition Failed", 413: "Payload Too Large", 414: "URI Too Long", 415: "Unsupported Media Type", 416: "Range Not Satisfiable", 417: "Expectation Failed", 418: "I'm a Teapot", 421: "Misdirected Request", 422: "Unprocessable Entity", 423: "Locked", 424: "Failed Dependency", 425: "Too Early", 426: "Upgrade Required", 428: "Precondition Required", 429: "Too Many Requests", 431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout", 505: "HTTP Version Not Supported", 506: "Variant Also Negotiates", 507: "Insufficient Storage", 508: "Loop Detected", 509: "Bandwidth Limit Exceeded", 510: "Not Extended", 511: "Network Authentication Required",
};

/** Response framing owns no socket lifetime beyond its request. The existing
 * Writable owns bounded buffering; previous response completion orders a pipeline. */
class HttpResponse extends HttpOutgoing {
  statusCode = 200;
  statusMessage: string | undefined;
  sendDate = true;
  strictContentLength = false;
  shouldKeepAlive: boolean;
  readonly socket: Writable & { setTimeout?(duration: unknown): unknown };
  readonly completion: Promise<void>;
  readonly #context: AsyncContext;
  readonly #request: Request;
  #previous: Promise<void>;
  readonly #done = Promise.withResolvers<undefined>();
  #trailers = "";
  #headTask: Promise<void> | undefined;
  #chunked = false;
  #body = true;
  #length: number | undefined;
  #written = 0;
  #completed = false;

  constructor(context: AsyncContext, socket: Writable, request: Request, previous: Promise<void>) {
    super({ highWaterMark: 65536, autoDestroy: true,
      write: (chunk, _encoding, done) => { void this.#write(chunk).then(() => done(), (error: unknown) => done(streamError(error))); },
      final: done => { void this.#finish().then(() => done(), (error: unknown) => done(streamError(error))); },
      destroy: (error, done) => {
        if (!this.#completed) {
          const failure = error ?? failureOf("ECONNRESET", "HTTP response was destroyed before completion");
          this.#done.reject(failure); this.socket.destroy(failure);
        }
        done(error);
      },
    });
    this.#context = context; this.socket = socket; this.#request = request; this.#previous = previous;
    this.shouldKeepAlive = request.keepAlive;
    this.completion = this.#done.promise;
    void this.completion.catch(() => undefined);
    bindAsyncEvents(this, context); bindAsyncWritable(this, context);
  }

  get finished(): boolean { return this.writableEnded; }
  override removeHeader(name: unknown): void {
    super.removeHeader(name);
    if (headerName(name) === "date") this.sendDate = false;
  }
  writeHead(status: unknown, messageOrHeaders?: unknown, headers?: unknown): this {
    this.assertHeadersMutable();
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 999) throw failureOf("ERR_HTTP_INVALID_STATUS_CODE", "Invalid HTTP status code");
    this.statusCode = status;
    if (typeof messageOrHeaders === "string") this.statusMessage = messageOrHeaders;
    else { if (headers !== undefined) throw new TypeError("Invalid writeHead arguments"); headers = messageOrHeaders; }
    if (headers !== undefined) for (const [name, value] of headerEntries(headers)) this.setHeader(name, value);
    this.#prepareHead(); return this;
  }
  _implicitHeader(): void { this.writeHead(this.statusCode); }
  setTimeout(duration: unknown, callback?: unknown): this {
    if (callback !== undefined) {
      if (!isEventListener(callback)) throw new TypeError("ServerResponse timeout requires a callback");
      this.on("timeout", callback);
    }
    if (typeof this.socket.setTimeout !== "function") throw new TypeError("ServerResponse.setTimeout requires a socket with timer support");
    this.socket.setTimeout(duration); return this;
  }
  writeContinue(callback?: unknown): void {
    this.assertHeadersMutable();
    if (callback !== undefined && typeof callback !== "function") throw new TypeError("writeContinue requires a callback");
    const run = this.#context.capture();
    this.#previous = this.#previous.then(() => this.#send(Buffer.from("HTTP/1.1 100 Continue\r\n\r\n")));
    void this.#previous.then(() => {
      if (callback !== undefined) run(() => { Reflect.apply(callback, this, []); });
    }, (error: unknown) => {
      const failure = streamError(error); this.destroy(failure);
      if (callback !== undefined) run(() => { Reflect.apply(callback, this, [failure]); });
    });
  }
  flushHeaders(): void { void this.#sendHead().catch((error: unknown) => this.destroy(streamError(error))); }
  addTrailers(value: unknown): void {
    const values = headerEntries(value).map(([name, value]) => {
      headerName(name); return items(headerValue(value)).map(item => `${name}: ${item}\r\n`).join("");
    }).join("");
    if (Buffer.byteLength(values, "latin1") > 65536) throw failureOf("ERR_HTTP_HEADERS_OVERFLOW", "Response trailers exceed their bound");
    this.#trailers = values;
  }
  #prepareHead(): void {
    if (this.headerBlock !== undefined) return;
    if (!Number.isInteger(this.statusCode) || this.statusCode < 100 || this.statusCode > 999) throw failureOf("ERR_HTTP_INVALID_STATUS_CODE", "Invalid HTTP status code");
    const message = this.statusMessage ?? reasons[this.statusCode] ?? "unknown";
    headerValue(message);
    this.#body = this.#request.method !== "HEAD" && this.statusCode >= 200 && this.statusCode !== 204 && this.statusCode !== 304;
    const length = this.getHeader("content-length"); const encoding = this.getHeader("transfer-encoding");
    this.#length = framingLength(length, encoding);
    // Node closes an explicitly chunked 204/304 response rather than emitting
    // a chunk terminator that would become the next response's bytes.
    if (encoding !== undefined && (this.statusCode === 204 || this.statusCode === 304)) this.shouldKeepAlive = false;
    this.#chunked = this.#body && (encoding !== undefined || (length === undefined && this.#request.minor >= 1));
    if (this.#chunked && encoding === undefined) this.setHeader("Transfer-Encoding", "chunked");
    if (this.#body && !this.#chunked && this.#length === undefined) this.shouldKeepAlive = false;
    if (String(this.getHeader("connection")).toLowerCase().split(/\s*,\s*/u).includes("close")) this.shouldKeepAlive = false;
    if (!this.hasHeader("connection")) this.setHeader("Connection", this.shouldKeepAlive ? "keep-alive" : "close");
    if (this.sendDate && !this.hasHeader("date")) this.setHeader("Date", new Date().toUTCString());
    this.sealHeaders(`HTTP/1.1 ${this.statusCode} ${message}`);
  }
  #sendHead(): Promise<void> {
    if (this.headerBlock === undefined) this._implicitHeader();
    const head = this.headerBlock;
    if (head === undefined) throw new Error("HTTP response header missing");
    return this.#headTask ??= this.#previous.then(() => this.#send(head));
  }
  #send(bytes: Uint8Array): Promise<void> {
    const run = this.#context.capture();
    return new Promise((resolve, reject) => {
      this.socket.write(bytes, error => run(() => { if (error) reject(error); else resolve(); }));
    });
  }
  async #write(value: unknown): Promise<void> {
    if (!(value instanceof Uint8Array)) throw new TypeError("HTTP body must contain bytes");
    await this.#sendHead();
    if (!this.#body || value.length === 0) return;
    this.#written += value.length;
    if (this.strictContentLength && this.#length !== undefined && this.#written > this.#length) throw failureOf("ERR_HTTP_CONTENT_LENGTH_MISMATCH", "HTTP body exceeds Content-Length");
    if (this.#chunked) await this.#send(Buffer.from(`${value.length.toString(16)}\r\n`));
    await this.#send(value);
    if (this.#chunked) await this.#send(Buffer.from("\r\n"));
  }
  async #finish(): Promise<void> {
    await this.#sendHead();
    if (this.strictContentLength && this.#body && this.#length !== undefined && this.#written !== this.#length) throw failureOf("ERR_HTTP_CONTENT_LENGTH_MISMATCH", "HTTP body differs from Content-Length");
    if (this.#chunked) await this.#send(Buffer.from(`0\r\n${this.#trailers}\r\n`, "latin1"));
    if (!this.shouldKeepAlive) await new Promise<void>((resolve, reject) => this.socket.end((error?: Error | null) => { if (error) reject(error); else resolve(); }));
    this.#completed = true; this.#done.resolve(undefined);
  }
}

export function createHttpResponses(context: AsyncContext): {
  readonly ServerResponse: new (socket: Writable, request: Request, previous?: Promise<void>) => HttpResponse;
  readonly STATUS_CODES: Readonly<Record<number, string>>;
} {
  return { ServerResponse: class extends HttpResponse {
    constructor(socket: Writable, request: Request, previous = Promise.resolve()) { super(context, socket, request, previous); }
  }, STATUS_CODES: reasons };
}
