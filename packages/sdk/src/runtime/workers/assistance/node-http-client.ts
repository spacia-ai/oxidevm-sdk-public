import { tlsOptions, UNSUPPORTED_TLS_OPTIONS, type TlsOptions } from "./node-tls.js";
import { Buffer } from "buffer";
import { copyOptions, otherDefaultPort, refuseSetOptions, truthy, unsupportedOption, UNSUPPORTED_CONNECT_OPTIONS, UNSUPPORTED_NET_SOCKET_OPTIONS, type SetTests } from "./node-connect-options.js";
import type { AsyncContext } from "./async-context.js";
import type { NodeSocket, NodeSockets } from "./node-socket.js";
import { bindAsyncEvents, bindAsyncWritable, isEventListener, streamError } from "./node-streams.js";
import { HttpOutgoing, framingLength, failureOf, headerName, headerEntries } from "./node-http-outgoing.js";
import { createHttpAgents, type HttpAgent } from "./node-http-agent.js";
import { receiveHttpResponse } from "./node-http-client-connection.js";

type HttpClientRequest = HttpOutgoing & {
  readonly method: string; readonly path: string; readonly host: string; readonly protocol: string; readonly agent: HttpAgent;
  socket: NodeSocket | null; reusedSocket: boolean; aborted: boolean;
  readonly connection: NodeSocket | null; readonly finished: boolean;
  onSocket(socket?: NodeSocket, error?: Error): void;
  setTimeout(duration: unknown, callback?: unknown): HttpClientRequest;
  setNoDelay(enabled?: unknown): void;
  setSocketKeepAlive(enabled?: unknown, delay?: number): void;
  abort(): void;
  flushHeaders(): void;
};
type Clients = ReturnType<typeof createHttpAgents> & {
  ClientRequest: new (options: unknown, callback?: unknown) => HttpClientRequest;
  request(value?: unknown, optionsOrCallback?: unknown, callback?: unknown): HttpClientRequest;
  get(value?: unknown, optionsOrCallback?: unknown, callback?: unknown): HttpClientRequest;
};

/** Keys Node's request path reads that this client lacks, each with Node's own "is set" test, so an
 * app that merely lists a key unset keeps working and one that uses it fails by name before connecting.
 * ClientRequest itself reads createConnection when it is a function; leaves out the Host header when setHost
 * is defined and falsy, and every default header when setDefaultHeaders is false; joins the values of each
 * header an array of uniqueHeaders names with "; "; and has its response parser join the duplicates of
 * single-value fields when joinDuplicateHeaders is true. Each client adds a `defaultPort` other than its
 * protocol's and what its sockets read: net.Socket's keys for http, the TLS keys for https. */
export const UNSUPPORTED_REQUEST_OPTIONS: SetTests = {
  socketPath: Boolean, ...UNSUPPORTED_CONNECT_OPTIONS, createConnection: value => typeof value === "function",
  insecureHTTPParser: value => value === true,
  setHost: value => value !== undefined && !truthy(value),
  setDefaultHeaders: value => value === false,
  maxHeaderSize: value => typeof value === "number",
  // An empty list names no header, so it changes nothing.
  uniqueHeaders: value => Array.isArray(value) && value.length > 0,
  joinDuplicateHeaders: value => value === true,
};

/** The application's own options, copied the way Node copies them: own properties onto a null-prototype object. */
function ownOptions(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new TypeError(`${label} must be an object`);
  return copyOptions(value);
}
function hostOption(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new TypeError(`Invalid HTTP ${name}`);
  return value;
}

export function createHttpClients(net: Pick<NodeSockets, "createConnection">, module: WebAssembly.Module, context: AsyncContext, dispatch: (callback: () => void) => void = queueMicrotask, retain: () => () => void = () => () => {}, protocol: "http:" | "https:" = "http:"): Clients {
  const agents = createHttpAgents(net, context, dispatch, protocol);
  const defaultPort = agents.globalAgent.defaultPort;
  const unsupported: SetTests = { ...UNSUPPORTED_REQUEST_OPTIONS, defaultPort: otherDefaultPort(defaultPort), ...(protocol === "https:" ? UNSUPPORTED_TLS_OPTIONS : UNSUPPORTED_NET_SOCKET_OPTIONS) };
  class ClientRequest extends HttpOutgoing {
    readonly method: string;
    readonly path: string;
    readonly host: string;
    readonly protocol = protocol;
    readonly agent: InstanceType<typeof agents.Agent>;
    socket: NodeSocket | null = null;
    reusedSocket = false;
    aborted = false;
    readonly #ready = Promise.withResolvers<NodeSocket>();
    #receiver: ReturnType<typeof receiveHttpResponse> | undefined;
    #headTask: Promise<void> | undefined;
    #chunked = false;
    #length: number | undefined;
    #written = 0;
    #responseReusable: boolean | undefined;
    #released = false;
    #timeout: number | undefined;
    #signal: AbortSignal | undefined;
    #abort: (() => void) | undefined;
    #releaseActivity: (() => void) | undefined;
    constructor(value: unknown, callback?: unknown) {
      super({ highWaterMark: 65536, autoDestroy: false,
        write: (chunk, _encoding, done) => { void this.#write(chunk).then(() => done(), (error: unknown) => { const failure = streamError(error); this.destroy(failure); done(failure); }); },
        final: done => { void this.#finish().then(() => done(), (error: unknown) => { const failure = streamError(error); this.destroy(failure); done(failure); }); },
        destroy: (error, done) => {
          this.agent.cancelRequest(this);
          this.#releaseActivity?.(); this.#releaseActivity = undefined;
          this.socket?.removeListener("timeout", this.#onTimeout);
          if (this.#signal !== undefined && this.#abort !== undefined) this.#signal.removeEventListener("abort", this.#abort);
          const failure = error ?? failureOf("ECONNRESET", "HTTP request destroyed");
          this.#ready.reject(failure);
          if (!this.#released) { this.#receiver?.abort(failure); this.socket?.destroy(); }
          done(error);
        },
      });
      const options = requestOptions(ownOptions(value, "http.request options"));
      this.method = options.method; this.path = options.path; this.host = options.host;
      this.agent = options.agent === false ? new agents.Agent() : options.agent ?? agents.globalAgent;
      bindAsyncEvents(this, context); bindAsyncWritable(this, context);
      this.once("finish", () => { this.#release(); });
      void this.#ready.promise.catch(() => undefined);
      if (callback !== undefined) { if (!isEventListener(callback)) throw new TypeError("HTTP response callback must be a function"); this.once("response", callback); }
      if (options.headers !== undefined) for (const [name, value] of headerEntries(options.headers)) this.setHeader(name, value);
      if (!this.hasHeader("host")) this.setHeader("Host", `${options.host.includes(":") ? `[${options.host}]` : options.host}${options.port === defaultPort ? "" : `:${options.port}`}`);
      if (options.auth !== undefined && !this.hasHeader("authorization")) this.setHeader("Authorization", `Basic ${Buffer.from(options.auth).toString("base64")}`);
      if (options.timeout !== undefined) this.setTimeout(options.timeout);
      this.#signal = options.signal;
      if (this.#signal !== undefined) {
        this.#abort = () => this.destroy(failureOf("ABORT_ERR", "The operation was aborted"));
        if (this.#signal.aborted) { dispatch(this.#abort); return; }
        this.#signal.addEventListener("abort", this.#abort, { once: true });
      }
      this.#releaseActivity = retain();
      try { this.agent.addRequest(this, { host: options.host, port: options.port, ...options.tls }); }
      catch (error) { this.#releaseActivity(); this.#releaseActivity = undefined; throw error; }
    }
    get connection(): NodeSocket | null { return this.socket; }
    get finished(): boolean { return this.writableEnded; }
    onSocket(socket?: NodeSocket, error?: Error): void {
      if (error !== undefined) { this.destroy(error); return; }
      if (socket === undefined) { this.destroy(failureOf("ECONNRESET", "HTTP socket missing")); return; }
      if (this.destroyed) { socket.emit("free"); return; }
      this.socket = socket;
      this.#receiver = receiveHttpResponse(socket, module, context, this.method, {
        information: head => {
          if (head.statusCode === 100) this.emit("continue");
          this.emit("information", { statusCode: head.statusCode, statusMessage: head.statusMessage, httpVersion: `${head.major}.${head.minor}`, headers: Object.fromEntries(head.headers), rawHeaders: head.headers.flat() });
        },
        response: message => { if (!this.emit("response", message)) message.resume(); },
        upgrade: (message, head) => {
          this.#released = true; socket.emit("agentRemove");
          if (!this.emit(this.method === "CONNECT" ? "connect" : "upgrade", message, socket, head)) socket.destroy();
          this.destroy();
        },
        complete: reusable => { this.#responseReusable = reusable; this.#release(); },
        error: error => { this.destroy(error); },
      });
      socket.on("timeout", this.#onTimeout);
      if (this.#timeout !== undefined) socket.setTimeout(this.#timeout);
      this.#ready.resolve(socket); this.emit("socket", socket);
    }
    readonly #onTimeout = () => { this.emit("timeout"); };
    setTimeout(duration: unknown, callback?: unknown): this {
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) throw new TypeError("Invalid HTTP request timeout");
      if (callback !== undefined) { if (!isEventListener(callback)) throw new TypeError("Invalid HTTP timeout callback"); this.once("timeout", callback); }
      this.#timeout = duration; this.socket?.setTimeout(duration); return this;
    }
    setNoDelay(enabled?: unknown): void { void this.#ready.promise.then(socket => { socket.setNoDelay(enabled); }, () => {}); }
    setSocketKeepAlive(enabled?: unknown, delay?: number): void { void this.#ready.promise.then(socket => { socket.setKeepAlive(enabled, delay); }, () => {}); }
    abort(): void { if (this.aborted) return; this.aborted = true; dispatch(() => { this.emit("abort"); }); this.destroy(); }
    flushHeaders(): void { void this.#sendHead().catch((error: unknown) => { this.destroy(streamError(error)); }); }
    #prepareHead(): void {
      if (this.headerBlock !== undefined) return;
      const length = this.getHeader("content-length"); const encoding = this.getHeader("transfer-encoding");
      this.#length = framingLength(length, encoding);
      this.#chunked = encoding !== undefined || (length === undefined && this.method !== "GET" && this.method !== "HEAD" && this.method !== "CONNECT");
      if (this.#chunked && encoding === undefined) this.setHeader("Transfer-Encoding", "chunked");
      if (!this.hasHeader("connection")) this.setHeader("Connection", this.agent.keepAlive ? "keep-alive" : "close");
      this.sealHeaders(`${this.method} ${this.path} HTTP/1.1`);
    }
    #sendHead(): Promise<void> {
      this.#prepareHead(); const head = this.headerBlock;
      if (head === undefined) throw new Error("HTTP request head missing");
      return this.#headTask ??= this.#send(head);
    }
    async #send(bytes: Uint8Array): Promise<void> {
      const socket = await this.#ready.promise;
      await new Promise<void>((resolve, reject) => socket.write(bytes, error => { if (error) reject(error); else resolve(); }));
    }
    async #write(value: unknown): Promise<void> {
      if (!(value instanceof Uint8Array)) throw new TypeError("HTTP body requires bytes");
      await this.#sendHead(); if (value.length === 0) return;
      this.#written += value.length;
      if (!this.#chunked && this.#length === undefined) throw failureOf("ERR_HTTP_INVALID_HEADER_VALUE", "This HTTP method requires explicit framing for a request body");
      if (this.#length !== undefined && this.#written > this.#length) throw failureOf("ERR_HTTP_CONTENT_LENGTH_MISMATCH", "HTTP request exceeds Content-Length");
      if (this.#chunked) await this.#send(Buffer.from(`${value.length.toString(16)}\r\n`));
      await this.#send(value); if (this.#chunked) await this.#send(Buffer.from("\r\n"));
    }
    async #finish(): Promise<void> {
      await this.#sendHead();
      if (this.#length !== undefined && this.#written !== this.#length) throw failureOf("ERR_HTTP_CONTENT_LENGTH_MISMATCH", "HTTP request differs from Content-Length");
      if (this.#chunked) await this.#send(Buffer.from("0\r\n\r\n"));
    }
    #release(): void {
      if (!this.writableFinished || this.#responseReusable === undefined || this.#released || this.socket === null) return;
      this.#released = true; this.socket.removeListener("timeout", this.#onTimeout);
      if (this.#responseReusable && String(this.getHeader("connection")).toLowerCase() !== "close") this.socket.emit("free");
      else this.socket.destroy();
      this.destroy();
    }
  }
  function requestOptions(options: Readonly<Record<string, unknown>>): {
    host: string; port: number; tls: TlsOptions | undefined; method: string; path: string; agent: InstanceType<typeof agents.Agent> | false | undefined;
    auth: string | undefined; signal: AbortSignal | undefined; timeout: unknown; headers: unknown;
  } {
    if (options["protocol"] !== undefined && options["protocol"] !== null && options["protocol"] !== protocol) throw failureOf("ERR_INVALID_PROTOCOL", `HTTP request requires ${protocol}`);
    const builtin = protocol === "https:" ? "https.request" : "http.request";
    refuseSetOptions(options, unsupported, "http.request", builtin);
    // ClientRequest sets the headers of `if (options.headers)`; an array is its raw header list, which it writes as
    // given and without a Host header of its own.
    const headers = options["headers"];
    if (Array.isArray(headers)) throw unsupportedOption("headers", "http.request", builtin, "an array of headers");
    const hostname = hostOption(options["hostname"], "hostname") ?? hostOption(options["host"], "host") ?? "localhost";
    const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    const port = Number(truthy(options["port"]) ? options["port"] : defaultPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("Invalid HTTP port");
    const method = options["method"] ?? "GET"; headerName(method);
    if (typeof method !== "string") throw new TypeError("Invalid HTTP method");
    const path = truthy(options["path"]) ? options["path"] : "/";
    if (typeof path !== "string" || path.length > 8192 || /[^\x21-\xff]/u.test(path)) throw new TypeError("Invalid HTTP request path");
    const agent = options["agent"] ?? undefined;
    if (agent !== undefined && agent !== false && !(agent instanceof agents.Agent)) throw new TypeError("Invalid HTTP agent");
    const auth = truthy(options["auth"]) ? options["auth"] : undefined; if (auth !== undefined && typeof auth !== "string") throw new TypeError("Invalid HTTP auth");
    const signal = options["signal"] ?? undefined; if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("Invalid HTTP AbortSignal");
    return { host, port, tls: protocol === "https:" ? tlsOptions(options) : undefined, method: method.toUpperCase(), path, agent, auth, signal, timeout: options["timeout"], headers: truthy(headers) ? headers : undefined };
  }
  function request(value: unknown = {}, optionsOrCallback?: unknown, callback?: unknown): ClientRequest {
    let options: Record<string, unknown>;
    if (typeof value === "string" || value instanceof URL) {
      const url = new URL(value);
      options = ownOptions({ protocol: url.protocol, hostname: url.hostname, port: url.port || defaultPort, path: `${url.pathname}${url.search}` }, "http.request options");
      if (url.username !== "" || url.password !== "") options["auth"] = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      if (typeof optionsOrCallback !== "function" && optionsOrCallback !== undefined) Object.assign(options, ownOptions(optionsOrCallback, "http.request options"));
    } else {
      options = ownOptions(value, "http.request options");
      if (optionsOrCallback !== undefined && typeof optionsOrCallback !== "function") throw new TypeError("Invalid HTTP request callback");
    }
    return new ClientRequest(options, typeof optionsOrCallback === "function" ? optionsOrCallback : callback);
  }
  function get(value?: unknown, optionsOrCallback?: unknown, callback?: unknown): ClientRequest {
    const result = request(value, optionsOrCallback, callback); result.end(); return result;
  }
  return { ...agents, ClientRequest, request, get };
}
