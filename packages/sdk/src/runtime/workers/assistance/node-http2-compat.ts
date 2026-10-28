import { Buffer } from "buffer";
import { Readable } from "readable-stream";
import type { AsyncContext } from "./async-context.js";
import type { Http2Stream } from "./node-http2-stream.js";
import { HttpOutgoing, headerEntries } from "./node-http-outgoing.js";
import { bindAsyncEvents, bindAsyncWritable, streamError } from "./node-streams.js";
import { http2Failure, type Http2Headers } from "./node-http2-wire.js";

/** The compatibility API shares HTTP header storage, without HTTP/1 framing. */
export class Http2ServerRequest extends Readable {
  readonly httpVersion = "2.0";
  readonly httpVersionMajor = 2;
  readonly httpVersionMinor = 0;
  complete = false;
  aborted = false;
  readonly method: string;
  readonly url: string;
  constructor(readonly stream: Http2Stream, readonly headers: Http2Headers, readonly rawHeaders: readonly string[], context: AsyncContext) {
    super({ highWaterMark: 65536, read: () => stream.resume(),
      destroy: (error, done) => { if (!this.complete) stream.destroy(error ?? undefined); done(error); },
    }); bindAsyncEvents(this, context);
    this.method = String(headers[":method"] ?? "GET"); this.url = String(headers[":path"] ?? "/");
    stream.on("data", (chunk: unknown) => { if (!(chunk instanceof Uint8Array)) { this.destroy(new TypeError("Expected HTTP/2 body bytes")); return; } if (!this.push(chunk)) stream.pause(); });
    stream.on("end", () => { this.complete = true; this.push(null); });
    stream.on("aborted", () => { this.aborted = true; this.emit("aborted"); });
    stream.on("error", (error: unknown) => this.destroy(streamError(error)));
    stream.pause();
  }
  get socket() { return this.stream.session.socket; }
  get connection() { return this.socket; }
  setTimeout(duration: unknown, callback?: unknown): this { this.stream.setTimeout(duration, callback); return this; }
}

export class Http2ServerResponse extends HttpOutgoing {
  statusCode = 200;
  sendDate = true;
  readonly req: Http2ServerRequest;
  constructor(readonly stream: Http2Stream, request: Http2ServerRequest, context: AsyncContext) {
    super({ highWaterMark: 65536,
      write: (chunk: unknown, _encoding, done) => { this.#head(); stream.write(chunk, done); },
      final: done => { this.#head(); stream.end(done); },
      destroy: (error, done) => { if (error !== null) stream.destroy(error); done(error); },
    });
    this.req = request; bindAsyncEvents(this, context); bindAsyncWritable(this, context);
    stream.on("error", (error: unknown) => this.destroy(streamError(error)));
  }
  get socket() { return this.stream.session.socket; }
  get connection() { return this.socket; }
  get finished(): boolean { return this.writableEnded; }
  writeHead(status: unknown, headers?: unknown): this {
    this.assertHeadersMutable();
    if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) throw http2Failure("ERR_HTTP2_STATUS_INVALID", "Invalid HTTP/2 response status");
    this.statusCode = status;
    if (headers !== undefined) for (const [key, value] of headerEntries(headers)) this.setHeader(key, value);
    this.#head(); return this;
  }
  flushHeaders(): void { this.#head(); }
  setTimeout(duration: unknown, callback?: unknown): this { this.stream.setTimeout(duration, callback); return this; }
  #head(): void {
    if (this.headersSent) return;
    if (!Number.isInteger(this.statusCode) || this.statusCode < 200 || this.statusCode > 599) throw http2Failure("ERR_HTTP2_STATUS_INVALID", "Invalid HTTP/2 response status");
    if (this.sendDate && !this.hasHeader("date")) this.setHeader("date", new Date().toUTCString());
    this.stream.respond({ ...this.getHeaders(), ":status": this.statusCode }); this.headerBlock = Buffer.alloc(0);
  }
}
