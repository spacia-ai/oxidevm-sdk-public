import type { Buffer } from "buffer";
import { Duplex } from "readable-stream";
import type { AsyncContext } from "./async-context.js";
import { bindAsyncEvents, bindAsyncWritable, isEventListener, streamError } from "./node-streams.js";
import type { Http2Bridge } from "./node-http2-bridge.js";
import type { Http2Session } from "./node-http2-session.js";
import { decodeHttp2Headers, http2Failure, type Http2Event } from "./node-http2-wire.js";
import { integer, record, exactKeys } from "../../decode.js";

/** Each stream has one read credit. A paused stream cannot block its peers. */
export class Http2Stream extends Duplex {
  id: number | undefined;
  rstCode = 0;
  headersSent = false;
  #headersReady: boolean;
  #demand = false;
  #credit = false;
  #remoteClosed = false;
  #ended = false;
  constructor(readonly session: Http2Session, readonly key: number, readonly bridge: Http2Bridge,
    context: AsyncContext, readonly server: boolean,
  ) {
    super({ highWaterMark: 65536, allowHalfOpen: true, autoDestroy: true,
      read: () => { this.#demand = true; this.#readCredit(); },
      write: (chunk: unknown, _encoding, done) => {
        if (!(chunk instanceof Uint8Array)) { done(new TypeError("HTTP/2 requires byte or string writes")); return; }
        void bridge.write(session.key, key, chunk).then(() => done(), (error: unknown) => done(streamError(error)));
      },
      final: done => { void bridge.call({ kind: "end", session: session.key, stream: key }).then(() => done(), (error: unknown) => done(streamError(error))); },
      destroy: (error, done) => {
        if (!this.#remoteClosed) bridge.send({ kind: "stream-close", session: session.key, stream: key, code: error ? 2 : 8 });
        done(error);
      },
    });
    this.#headersReady = server; this.headersSent = !server;
    bindAsyncEvents(this, context); bindAsyncWritable(this, context);
  }
  get pending(): boolean { return this.id === undefined; }
  respond(headers: unknown = {}, options: unknown = {}): void {
    if (!this.server) throw http2Failure("ERR_HTTP2_INVALID_STREAM", "Only server streams can respond");
    if (this.headersSent) throw http2Failure("ERR_HTTP2_HEADERS_SENT", "HTTP/2 headers already sent");
    const decoded = decodeHttp2Headers(headers), flags = streamOptions(options);
    this.headersSent = true;
    void this.bridge.call({ kind: "respond", session: this.session.key, stream: this.key, headers: decoded, options: flags })
      .catch((error: unknown) => this.destroy(streamError(error)));
  }
  additionalHeaders(headers: unknown): void { this.#headers("additional-headers", headers); }
  sendTrailers(headers: unknown): void { this.#headers("trailers", headers); }
  #headers(kind: "trailers" | "additional-headers", headers: unknown): void {
    const decoded = decodeHttp2Headers(headers);
    void this.bridge.call({ kind, session: this.session.key, stream: this.key, headers: decoded }).catch((error: unknown) => this.destroy(streamError(error)));
  }
  close(code = 0, callback?: unknown): void {
    integer(code, "HTTP/2 reset code", 0, 0xffff_ffff);
    if (callback !== undefined) { if (!isEventListener(callback)) throw new TypeError("HTTP/2 close requires a callback"); this.once("close", callback); }
    if (!this.#remoteClosed) this.bridge.send({ kind: "stream-close", session: this.session.key, stream: this.key, code });
  }
  setTimeout(duration: unknown, callback?: unknown): this {
    const timeout = http2Timeout(duration);
    if (callback !== undefined) { if (!isEventListener(callback)) throw new TypeError("HTTP/2 timeout requires a callback"); this.once("timeout", callback); }
    this.bridge.send({ kind: "stream-timeout", session: this.session.key, stream: this.key, duration: timeout }); return this;
  }
  receive(event: Extract<Http2Event, { readonly stream: number }>): void {
    switch (event.kind) {
      case "stream-ready": this.id = event.id; this.emit("ready"); return;
      case "stream": this.id = event.id; this.#headersReady = true; this.#readCredit(); if (!this.server) this.end(); return;
      case "response": this.#headersReady = true; this.emit("response", event.headers, event.flags, event.rawHeaders); this.#readCredit(); return;
      case "headers": case "trailers": this.emit(event.kind, event.headers, event.flags, event.rawHeaders); return;
      case "end": this.#ended = true; this.push(null); return;
      case "aborted": case "wantTrailers": case "timeout": this.emit(event.kind); return;
      case "stream-error": this.destroy(http2Failure(event.code, event.message)); return;
      case "stream-close":
        this.#remoteClosed = true; this.rstCode = event.rstCode;
        if (event.rstCode !== 0 && event.rstCode !== 8) this.destroy(http2Failure("ERR_HTTP2_STREAM_ERROR", `HTTP/2 stream reset with code ${String(event.rstCode)}`));
        else if (!this.#ended) { this.push(null); this.destroy(); }
        return;
    }
  }
  data(bytes: Buffer): void {
    if (!this.#credit) throw http2Failure("ERR_HTTP2_BRIDGE_PROTOCOL", "Unexpected HTTP/2 body credit");
    this.#credit = false;
    if (this.destroyed) { this.bridge.send({ kind: "read", session: this.session.key, stream: this.key }); return; }
    // The next credit acknowledges this frame, even when it filled the buffer.
    this.#demand = this.push(bytes); this.#readCredit();
  }
  #readCredit(): void {
    if (!this.#demand || this.#credit || !this.#headersReady || this.#remoteClosed || this.destroyed) return;
    this.#credit = true; this.bridge.send({ kind: "read", session: this.session.key, stream: this.key });
  }
}

export function streamOptions(value: unknown): Readonly<Record<string, boolean>> {
  const source = record(value, "HTTP/2 stream options"); exactKeys(source, [], ["endStream", "waitForTrailers"]);
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(source)) { if (typeof value !== "boolean") throw new TypeError("HTTP/2 stream options must be booleans"); result[key] = value; }
  return result;
}
export function http2Timeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 0x7fff_ffff) throw http2Failure("ERR_OUT_OF_RANGE", "Invalid HTTP/2 timeout");
  return value;
}
