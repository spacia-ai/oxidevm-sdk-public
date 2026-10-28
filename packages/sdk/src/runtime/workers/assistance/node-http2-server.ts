import { integer, record } from "../../decode.js";
import type { AsyncContext } from "./async-context.js";
import { EventEmitter, bindAsyncEvents, isEventListener } from "./node-streams.js";
import { Http2Bridge, type Http2Children } from "./node-http2-bridge.js";
import { Http2Session } from "./node-http2-session.js";
import { Http2ServerRequest, Http2ServerResponse } from "./node-http2-compat.js";
import { http2Timeout } from "./node-http2-stream.js";
import { http2Failure, type Http2Event } from "./node-http2-wire.js";
import type { ProcessScheduler } from "./process-scheduler.js";

export class Http2Server extends EventEmitter {
  readonly #sessions = new Map<number, Http2Session>();
  #bridge: Http2Bridge | undefined;
  #address: { readonly address: string; readonly port: number; readonly family: string } | undefined;
  #release: (() => void) | undefined;
  #referenced = true;
  #closing = false;
  #timeout = 0;
  constructor(readonly services: { readonly children: Http2Children; readonly context: AsyncContext; readonly retain: () => () => void; readonly scheduler?: ProcessScheduler },
    readonly secure: boolean, readonly options: Readonly<Record<string, unknown>>, listener?: unknown,
  ) {
    super(); bindAsyncEvents(this, services.context);
    if (listener !== undefined) { if (!isEventListener(listener)) throw new TypeError("HTTP/2 server requires a request listener"); this.on("request", listener); }
  }
  get listening(): boolean { return this.#address !== undefined && !this.#closing; }
  get timeout(): number { return this.#timeout; }
  address() { return this.#address === undefined ? null : { ...this.#address }; }
  listen(...args: unknown[]): this {
    if (this.#bridge !== undefined) throw http2Failure("ERR_SERVER_ALREADY_LISTEN", "HTTP/2 server is already started");
    this.#closing = false;
    const values = [...args], callback = typeof values.at(-1) === "function" ? values.pop() : undefined;
    if (callback !== undefined) { if (!isEventListener(callback)) throw new TypeError("Invalid listen callback"); this.once("listening", callback); }
    let port: unknown = values[0], host: unknown = "::", backlog: unknown = 511;
    if (port !== null && typeof port === "object") {
      const options = record(port, "HTTP/2 listen options");
      for (const key of Object.keys(options)) if (!["port", "host", "backlog"].includes(key)) throw new TypeError("Unsupported HTTP/2 listen option " + key);
      port = options["port"]; host = options["host"] ?? host; backlog = options["backlog"] ?? backlog;
      if (values.length !== 1) throw new TypeError("Invalid HTTP/2 listen arguments");
    } else {
      if (typeof values[1] === "string") { host = values[1]; backlog = values[2] ?? backlog; }
      else backlog = values[1] ?? backlog;
      if (values.length > 3) throw new TypeError("Invalid HTTP/2 listen arguments");
    }
    integer(port, "HTTP/2 port", 0, 65535); integer(backlog, "HTTP/2 backlog", 1, 4096);
    if (typeof host !== "string" || host.includes("\0") || host.length > 4096) throw new TypeError("Invalid HTTP/2 listen host");
    if (this.#referenced) this.#release = this.services.retain();
    try {
      this.#bridge = new Http2Bridge(this.services.children, { role: this.secure ? "secure-server" : "server", options: this.options, listen: { port, host, backlog } }, {
        event: event => this.#event(event),
        data: (session, stream, bytes) => { const target = this.#sessions.get(session); if (target === undefined) throw http2Failure("ERR_HTTP2_BRIDGE_PROTOCOL", "Unknown HTTP/2 session"); target.data(stream, bytes); },
        retired: error => {
          this.#address = undefined; this.#bridge = undefined; this.#release?.(); this.#release = undefined;
          for (const session of this.#sessions.values()) session.retire(error); this.#sessions.clear();
          if (error !== undefined) this.emit("error", error);
          this.emit("close");
        },
      }, this.services.scheduler);
    } catch (error) { this.#release?.(); this.#release = undefined; throw error; }
    return this;
  }
  close(callback?: unknown): this {
    if (callback !== undefined) { if (!isEventListener(callback)) throw new TypeError("HTTP/2 close requires a callback"); this.once("close", callback); }
    if (this.#bridge === undefined) throw http2Failure("ERR_SERVER_NOT_RUNNING", "HTTP/2 server is not running");
    this.#closing = true; this.#bridge.send({ kind: "server-close" }); return this;
  }
  setTimeout(duration: unknown, callback?: unknown): this {
    this.#timeout = http2Timeout(duration);
    if (callback !== undefined) { if (!isEventListener(callback)) throw new TypeError("Invalid server timeout callback"); this.on("timeout", callback); }
    this.#bridge?.send({ kind: "server-timeout", duration: this.#timeout }); return this;
  }
  ref(): this { this.#referenced = true; if (this.#bridge !== undefined) this.#release ??= this.services.retain(); return this; }
  unref(): this { this.#referenced = false; this.#release?.(); this.#release = undefined; return this; }
  #event(event: Http2Event): void {
    if (event.kind === "listening") { this.#address = event.address; if (this.#timeout !== 0) this.#bridge?.send({ kind: "server-timeout", duration: this.#timeout }); this.emit("listening"); return; }
    if (event.kind === "server-error") { this.emit("error", http2Failure(event.code, event.message)); return; }
    if (event.kind === "server-timeout") { this.emit("timeout"); return; }
    if (event.kind === "server-close") return;
    if (!("session" in event)) throw http2Failure("ERR_HTTP2_BRIDGE_PROTOCOL", "Invalid server event");
    if (event.kind === "session") {
      if (this.#sessions.has(event.session) || this.#sessions.size >= 64) throw http2Failure("ERR_HTTP2_BRIDGE_PROTOCOL", "Duplicate or excessive HTTP/2 session");
      const session = new Http2Session(event.session, this.services.context, true, this.services.retain); session.bridge = this.#bridge;
      this.#sessions.set(event.session, session); session.receive(event);
      session.on("error", (error: unknown) => this.emit("sessionError", error, session)); this.emit("session", session); return;
    }
    const session = this.#sessions.get(event.session);
    if (session === undefined) throw http2Failure("ERR_HTTP2_BRIDGE_PROTOCOL", "Unknown HTTP/2 session");
    const stream = session.receive(event);
    if (event.kind === "stream" && stream !== undefined) {
      this.emit("stream", stream, event.headers, event.flags, event.rawHeaders);
      if (this.listenerCount("request") > 0) {
        const request = new Http2ServerRequest(stream, event.headers, event.rawHeaders, this.services.context);
        this.emit("request", request, new Http2ServerResponse(stream, request, this.services.context));
      }
    }
    if (event.kind === "session-close") this.#sessions.delete(event.session);
  }
}
