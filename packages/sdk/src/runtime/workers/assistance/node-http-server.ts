import { isEventListener } from "./node-streams.js";
import { exactKeys, record } from "../../decode.js";
import type { AsyncContext } from "./async-context.js";
import type { createNodeNet, NodeServer } from "./node-net.js";
import type { NodeSocket } from "./node-socket.js";
import { HttpParseError } from "./http-parser.js";
import { createHttpConnection } from "./node-http-connection.js";
import { createHttpResponses } from "./node-http-response.js";
import { IncomingMessage } from "./node-http-incoming.js";

type Connection = ReturnType<typeof createHttpConnection>;
type RequestListener = Parameters<typeof createHttpConnection>[3]["request"];
type HttpServer = NodeServer & { timeout: number; keepAliveTimeout: number; keepAliveTimeoutBuffer: number; setTimeout(duration: unknown, callback?: unknown): HttpServer; closeIdleConnections(): void; closeAllConnections(): void };
/** The methods Node 24.18.1's HTTP parser accepts, as `http.METHODS` lists them. */
const METHODS = ["ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE",
  "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND",
  "UNLINK", "UNLOCK", "UNSUBSCRIBE"] as const;

type Servers = {
  readonly IncomingMessage: typeof IncomingMessage;
  /** A fresh array per module, as Node gives each process its own. */
  readonly METHODS: string[];
  readonly ServerResponse: ReturnType<typeof createHttpResponses>["ServerResponse"];
  readonly STATUS_CODES: Readonly<Record<number, string>>;
  readonly Server: {
    new (listener?: RequestListener): HttpServer;
    new (options: unknown, listener?: RequestListener): HttpServer;
  };
  readonly createServer: {
    (listener?: RequestListener): HttpServer;
    (options: unknown, listener?: RequestListener): HttpServer;
  };
};

/** HTTP reuses the net owner for bind, accept, connection accounting and close.
 * Only HTTP parsing, response ordering and idle retirement belong here. */
export function createHttpServers(net: ReturnType<typeof createNodeNet>, module: WebAssembly.Module, context: AsyncContext): Servers {
  const { ServerResponse, STATUS_CODES } = createHttpResponses(context);
  class Server extends net.Server {
    readonly #connections = new Map<NodeSocket, Connection>();
    #closing = false;
    timeout = 0;
    keepAliveTimeout = 5000;
    keepAliveTimeoutBuffer = 1000;
    constructor(value: unknown = {}, listener?: unknown) {
      super({ allowHalfOpen: true, pauseOnConnect: true });
      if (typeof value === "function") { listener = value; value = {}; }
      exactKeys(record(value, "http.Server options"), []);
      if (listener !== undefined) {
        if (typeof listener !== "function") throw new TypeError("http.Server requires a request callback");
        this.on("request", (...args: unknown[]) => { Reflect.apply(listener, this, args); });
      }
      this.on("listening", () => { this.#closing = false; });
      this.on("connection", (value: unknown) => {
        if (!(value instanceof net.Socket)) throw new TypeError("HTTP requires a Linux socket");
        const socket = value;
        const connection = createHttpConnection(socket, module, context, {
          Response: ServerResponse,
          request: (request, response) => {
            const expectation = request.headers["expect"];
            if (expectation !== undefined && request.httpVersionMajor === 1 && request.httpVersionMinor === 1) {
              if (typeof expectation === "string" && /^100-continue$/iu.test(expectation)) {
                if (this.listenerCount("checkContinue") !== 0) { this.emit("checkContinue", request, response); return; }
                response.writeContinue();
              } else {
                if (this.listenerCount("checkExpectation") !== 0) this.emit("checkExpectation", request, response);
                else { response.statusCode = 417; response.end(); }
                return;
              }
            }
            this.emit("request", request, response);
          },
          upgrade: (request, socket, head) => {
            this.#connections.delete(socket);
            return this.emit(request.method === "CONNECT" ? "connect" : "upgrade", request, socket, head);
          },
          clientError: error => {
            if (this.emit("clientError", error, socket)) return true;
            if (socket.destroyed || socket.writableEnded || !(error instanceof HttpParseError)) return false;
            const status = error.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : "400 Bad Request";
            socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
            return true;
          },
          timeout: () => this.emit("timeout", socket),
          active: () => { socket.setTimeout(this.timeout); },
          idle: () => {
            const delay = Number.isFinite(this.keepAliveTimeout) && this.keepAliveTimeout > 0 ? this.keepAliveTimeout : 0;
            const buffer = Number.isFinite(this.keepAliveTimeoutBuffer) && this.keepAliveTimeoutBuffer >= 0 ? this.keepAliveTimeoutBuffer : 0;
            if (delay === 0) return false;
            socket.setTimeout(Math.min(delay + buffer, 0x7fff_ffff)); return true;
          },
          closed: () => { this.#connections.delete(socket); },
        });
        this.#connections.set(socket, connection);
        socket.setTimeout(this.timeout);
        if (this.#closing) connection.closeWhenIdle(); else socket.resume();
      });
    }
    setTimeout(duration: unknown, callback?: unknown): this {
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) throw new RangeError("http.Server timeout must be a nonnegative finite number");
      if (callback !== undefined) {
        if (!isEventListener(callback)) throw new TypeError("http.Server timeout requires a callback");
        this.on("timeout", callback);
      }
      this.timeout = duration; return this;
    }
    override close(callback?: unknown): this {
      super.close(callback); this.#closing = true;
      for (const connection of this.#connections.values()) connection.closeWhenIdle();
      return this;
    }
    closeIdleConnections(): void { for (const connection of this.#connections.values()) connection.closeIdle(); }
    closeAllConnections(): void { for (const socket of this.#connections.keys()) socket.destroy(); }
  }
  return { Server, ServerResponse, IncomingMessage, METHODS: [...METHODS], STATUS_CODES, createServer: (options?: unknown, listener?: RequestListener) => new Server(options, listener) };
}
