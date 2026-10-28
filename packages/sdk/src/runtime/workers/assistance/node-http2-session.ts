import { Buffer } from "buffer";
import { integer } from "../../decode.js";
import type { AsyncContext } from "./async-context.js";
import { EventEmitter, bindAsyncEvents, isEventListener } from "./node-streams.js";
import type { Http2Bridge } from "./node-http2-bridge.js";
import { Http2Stream, http2Timeout, streamOptions } from "./node-http2-stream.js";
import { decodeHttp2Headers, decodeHttp2Settings, http2Failure, type Http2Event, type Http2Settings, type Http2SocketInfo } from "./node-http2-wire.js";

/** The session owns stream identity. Native Node owns the protocol state. */
export class Http2Session extends EventEmitter {
  readonly #streams = new Map<number, Http2Stream>();
  #next = -1;
  #closed = false;
  #destroyed = false;
  #socket: Http2SocketInfo | undefined;
  #local: Http2Settings = {};
  #remote: Http2Settings = {};
  #release: (() => void) | undefined;
  bridge: Http2Bridge | undefined;
  constructor(readonly key: number, readonly context: AsyncContext, readonly server: boolean, readonly retain: () => () => void) {
    super(); bindAsyncEvents(this, context); this.#release = retain();
  }
  get type(): number { return this.server ? 0 : 1; }
  get connecting(): boolean { return this.#socket === undefined && !this.#destroyed; }
  get closed(): boolean { return this.#closed; }
  get destroyed(): boolean { return this.#destroyed; }
  get encrypted(): boolean | undefined { return this.#socket?.encrypted; }
  get alpnProtocol(): string | false | undefined { return this.#socket?.alpnProtocol; }
  get socket(): Http2SocketInfo | undefined { return this.#socket === undefined ? undefined : { ...this.#socket }; }
  get localSettings(): Http2Settings { return { ...this.#local }; }
  get remoteSettings(): Http2Settings { return { ...this.#remote }; }
  request(headers: unknown = {}, options: unknown = {}): Http2Stream {
    if (this.server || this.#closed || this.#destroyed) throw http2Failure("ERR_HTTP2_INVALID_SESSION", "HTTP/2 client session is closed");
    if (this.#streams.size >= 128 || this.#next >= 0x7fff_ffff - 2) throw http2Failure("ERR_HTTP2_OUT_OF_STREAMS", "HTTP/2 stream capacity exhausted");
    const decoded = decodeHttp2Headers(headers), flags = streamOptions(options), key = this.#next += 2, bridge = this.#transport();
    const stream = new Http2Stream(this, key, bridge, this.context, false); this.#streams.set(key, stream);
    bridge.send({ kind: "request", session: this.key, stream: key, headers: decoded, options: flags }); return stream;
  }
  close(callback?: unknown): void {
    if (callback !== undefined) { if (!isEventListener(callback)) throw new TypeError("HTTP/2 close requires a callback"); this.once("close", callback); }
    if (this.#closed || this.#destroyed) return; this.#closed = true;
    this.#transport().send({ kind: "session-close", session: this.key });
  }
  destroy(error?: unknown, code = 0): void {
    integer(code, "HTTP/2 error code", 0, 0x7fff_ffff);
    if (error !== undefined && !(error instanceof Error)) throw new TypeError("HTTP/2 destroy requires an Error");
    if (this.#destroyed) return;
    this.#closed = true;
    this.#transport().send({ kind: "session-destroy", session: this.key, code });
    if (error !== undefined) this.emit("error", error);
  }
  settings(value: unknown, callback?: unknown): void {
    const settings = decodeHttp2Settings(value);
    if (callback !== undefined && typeof callback !== "function") throw new TypeError("HTTP/2 settings requires a callback");
    const run = this.context.capture();
    void this.#transport().call({ kind: "settings", session: this.key, settings }).then(reply => {
      if (reply.kind !== "settings-ack") throw http2Failure("ERR_HTTP2_BRIDGE_PROTOCOL", "Invalid settings completion");
      this.#local = reply.settings;
      if (callback !== undefined) run(() => { Reflect.apply(callback, this, [null, reply.settings, reply.duration]); });
    }, (error: unknown) => { run(() => { if (callback === undefined) this.emit("error", error); else Reflect.apply(callback, this, [error]); }); });
  }
  ping(payload?: unknown, callback?: unknown): boolean {
    if (typeof payload === "function") { callback = payload; payload = undefined; }
    if (typeof callback !== "function") throw new TypeError("HTTP/2 ping requires a callback");
    const bytes = payload === undefined ? Buffer.alloc(8) : payload;
    if (!(bytes instanceof Uint8Array) || bytes.length !== 8) throw http2Failure("ERR_HTTP2_PING_LENGTH", "HTTP/2 ping requires eight bytes");
    const run = this.context.capture();
    void this.#transport().call({ kind: "ping", session: this.key, data: Buffer.from(bytes).toString("base64") }).then(reply => {
      if (reply.kind !== "ping-ack") throw http2Failure("ERR_HTTP2_BRIDGE_PROTOCOL", "Invalid ping completion");
      run(() => { Reflect.apply(callback, this, [null, reply.duration, reply.data]); });
    }, (error: unknown) => { run(() => { Reflect.apply(callback, this, [error]); }); }); return true;
  }
  goaway(code = 0, lastStreamID = 0, data: Uint8Array = Buffer.alloc(0)): void {
    integer(code, "HTTP/2 error code", 0, 0x7fff_ffff); integer(lastStreamID, "HTTP/2 last stream", 0, 0x7fff_ffff);
    if (!(data instanceof Uint8Array) || data.length > 4096) throw new TypeError("Invalid HTTP/2 GOAWAY data");
    this.#transport().send({ kind: "goaway", session: this.key, code, lastStreamID, data: Buffer.from(data).toString("base64") });
  }
  setTimeout(duration: unknown, callback?: unknown): this {
    const timeout = http2Timeout(duration);
    if (callback !== undefined) { if (!isEventListener(callback)) throw new TypeError("HTTP/2 timeout requires a callback"); this.once("timeout", callback); }
    this.#transport().send({ kind: "session-timeout", session: this.key, duration: timeout }); return this;
  }
  ref(): this { if (!this.#destroyed) this.#release ??= this.retain(); return this; }
  unref(): this { this.#release?.(); this.#release = undefined; return this; }
  receive(event: Http2Event): Http2Stream | undefined {
    if ("stream" in event) {
      if (event.kind === "stream") {
        if (this.#streams.has(event.stream) || this.#streams.size >= 128) throw http2Failure("ERR_HTTP2_BRIDGE_PROTOCOL", "Duplicate or excessive HTTP/2 stream");
        const stream = new Http2Stream(this, event.stream, this.#transport(), this.context, this.server); this.#streams.set(event.stream, stream);
        stream.receive(event); this.emit("stream", stream, event.headers, event.flags, event.rawHeaders); return stream;
      }
      const stream = this.#streams.get(event.stream);
      if (stream === undefined) throw http2Failure("ERR_HTTP2_BRIDGE_PROTOCOL", "Unknown native HTTP/2 stream");
      stream.receive(event); if (event.kind === "stream-close") this.#streams.delete(event.stream); return stream;
    }
    switch (event.kind) {
      case "session": case "connect": this.#socket = event.socket; if (!this.server) this.emit("connect", this, this.socket); break;
      case "localSettings": this.#local = event.settings; this.emit("localSettings", this.localSettings); break;
      case "remoteSettings": this.#remote = event.settings; this.emit("remoteSettings", this.remoteSettings); break;
      case "session-timeout": this.emit("timeout"); break;
      case "session-error": this.emit("error", http2Failure(event.code, event.message)); break;
      case "goaway": this.emit("goaway", event.code, event.lastStreamID, event.data); break;
      case "session-close": this.#closed = true; if (this.server) this.retire(); break;
      case "reply": case "settings-ack": case "ping-ack": case "done": case "fatal": case "server-error": case "server-close": case "server-timeout": case "listening":
        throw http2Failure("ERR_HTTP2_BRIDGE_PROTOCOL", "Unexpected HTTP/2 session event");
    }
    return undefined;
  }
  data(stream: number, bytes: Buffer): void {
    const target = this.#streams.get(stream);
    if (target === undefined) throw http2Failure("ERR_HTTP2_BRIDGE_PROTOCOL", "Unknown HTTP/2 body target");
    target.data(bytes);
  }
  retire(error?: Error): void {
    if (this.#destroyed) return;
    this.#destroyed = true; this.#closed = true; this.unref();
    for (const stream of this.#streams.values()) stream.destroy(error);
    this.#streams.clear();
    if (error !== undefined) this.emit("error", error);
    this.emit("close");
  }
  #transport(): Http2Bridge { if (this.bridge === undefined || this.#destroyed) throw http2Failure("ERR_HTTP2_INVALID_SESSION", "HTTP/2 session is closed"); return this.bridge; }
}
