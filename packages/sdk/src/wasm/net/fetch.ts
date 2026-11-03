import type { ModuleReach } from "../reach.js";
import { urlHost } from "./addresses.js";
import { deadline } from "./deadline.js";
import { aborted, abortReason, isAbort, NetError } from "./errors.js";
import { bodySource, BufferedStream, encodeRequestHead, field, keepsAlive, readResponseHead, type BodySource, type ResponseHead } from "./http1.js";
import type { ConnectionPool } from "./pool.js";
import type { NetSockets } from "./ports.js";
import { dial, type ByteStream, type TlsLayer } from "./streams.js";

/**
 * `fetch` for module code (engine ADR 0029, N-3), with Node's (undici's) semantics rather than a page's: no CORS, any
 * request header, the Fetch standard's redirects, gzip and deflate decoded, keep-alive, streamed bodies in both
 * directions, `AbortSignal`, and timeouts (10 s to connect, 300 s for the response head and between body reads). It runs
 * HTTP/1.1 on the module process's own VM sockets; a failure rejects with `TypeError("fetch failed")` whose `cause` is
 * the `NetError` (EPERM `vm-local-only`, ECONNRESET after a revoke, EACCES `module-network-reach`, a TLS failure).
 */
export interface FetchContext {
  readonly sockets: NetSockets;
  readonly reach: ModuleReach;
  readonly tls: TlsLayer;
  readonly pool: ConnectionPool;
  /** The module's lifecycle: every request ends with it. */
  readonly signal: AbortSignal;
  /** The worker's own fetch, for `blob:` URLs, which the module frame's policy permits. */
  readonly local?: typeof fetch;
}

export const FETCH_TIMEOUTS = { connectMs: 10_000, headersMs: 300_000, bodyMs: 300_000 } as const;
const MAX_REDIRECTS = 20, DRAIN_BYTES = 64 * 1024;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = ["content-encoding", "content-language", "content-location", "content-type", "content-length"];
const CROSS_ORIGIN_HEADERS = ["authorization", "proxy-authorization", "cookie"];
const encoder = new TextEncoder();

/** A response that reports what the network said: its final URL, whether it was redirected, and every header field. */
class ModuleResponse extends Response {
  readonly #url: string; readonly #redirected: boolean; readonly #headers: Headers;
  constructor(body: ReadableStream<Uint8Array> | null, init: ResponseInit, url: string, redirected: boolean, headers: Headers) {
    super(body, init); this.#url = url; this.#redirected = redirected; this.#headers = headers;
  }
  override get url(): string { return this.#url; }
  override get redirected(): boolean { return this.#redirected; }
  override get headers(): Headers { return this.#headers; }
  override get type(): ResponseType { return "default"; }
}

function failed(cause: unknown): TypeError { return new TypeError("fetch failed", { cause }); }

/** The request body: replayable bytes, a one-shot stream, or none; and the content type its kind implies. */
type Body = { readonly kind: "none" } | { readonly kind: "bytes"; readonly bytes: Uint8Array } | { readonly kind: "stream"; readonly stream: ReadableStream<Uint8Array> };

async function requestBody(body: BodyInit | null | undefined, headers: Headers): Promise<Body> {
  if (body === null || body === undefined) return { kind: "none" };
  const carrier = new Response(body), type = carrier.headers.get("content-type");
  if (type !== null && !headers.has("content-type")) headers.set("content-type", type);
  if (body instanceof ReadableStream) return carrier.body === null ? { kind: "none" } : { kind: "stream", stream: carrier.body };
  return { kind: "bytes", bytes: new Uint8Array(await carrier.arrayBuffer()) };
}

interface Exchange { readonly head: ResponseHead; readonly reader: BufferedStream; readonly source: BodySource; readonly stream: ByteStream; readonly origin: string; readonly reused: boolean }

function originOf(url: URL): string { return `${url.protocol}//${urlHost(url)}:${url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port}`; }

async function connection(context: FetchContext, url: URL, signal: AbortSignal): Promise<{ readonly stream: ByteStream; readonly reused: boolean }> {
  const pooled = context.pool.take(originOf(url));
  if (pooled !== undefined) return { stream: pooled, reused: true };
  const secure = url.protocol === "https:", port = url.port === "" ? (secure ? 443 : 80) : Number(url.port);
  const timer = deadline(FETCH_TIMEOUTS.connectMs, signal, "Connecting");
  try {
    return { stream: await dial(context.sockets, context.reach, context.tls, { host: urlHost(url), port, tls: secure, alpn: ["http/1.1"], signal: timer.signal }), reused: false };
  } catch (error: unknown) {
    if (timer.expired() && !signal.aborted) throw new NetError("ETIMEDOUT", `connect ETIMEDOUT ${urlHost(url)}`, { syscall: "connect", hostname: urlHost(url) });
    throw error;
  } finally { timer.clear(); }
}

async function writeBody(stream: ByteStream, body: Body, signal: AbortSignal): Promise<void> {
  if (body.kind === "bytes") { if (body.bytes.length > 0) await stream.write(body.bytes, signal); return; }
  if (body.kind === "none") return;
  const reader = body.stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError("A request body stream must yield Uint8Array chunks");
      if (value.length === 0) continue;
      await stream.write(new Uint8Array([...encoder.encode(`${value.length.toString(16)}\r\n`), ...value, 13, 10]), signal);
    }
    await stream.write(encoder.encode("0\r\n\r\n"), signal);
  } finally { reader.releaseLock(); }
}

async function exchange(context: FetchContext, url: URL, method: string, headers: Headers, body: Body, signal: AbortSignal): Promise<Exchange> {
  for (let attempt = 0; ; attempt++) {
    const { stream, reused } = await connection(context, url, signal);
    const fields: [string, string][] = [["host", url.host]];
    for (const [name, value] of headers) if (name !== "host") fields.push([name, value]);
    if (!headers.has("accept")) fields.push(["accept", "*/*"]);
    if (!headers.has("accept-encoding")) fields.push(["accept-encoding", "gzip, deflate"]);
    if (!headers.has("user-agent")) fields.push(["user-agent", "oxidevm-module"]);
    if (body.kind === "bytes" || body.kind === "none" && !["GET", "HEAD", "OPTIONS", "TRACE"].includes(method)) fields.push(["content-length", String(body.kind === "bytes" ? body.bytes.length : 0)]);
    if (body.kind === "stream") fields.push(["transfer-encoding", "chunked"]);
    const reader = new BufferedStream(stream), timer = deadline(FETCH_TIMEOUTS.headersMs, signal, "Waiting for the response");
    try {
      await stream.write(encodeRequestHead({ method, target: `${url.pathname}${url.search}`, fields }), timer.signal);
      await writeBody(stream, body, timer.signal);
      let head = await readResponseHead(reader, timer.signal);
      // Interim answers (100 Continue, 103 Early Hints) precede the real one.
      while (head !== null && head.status >= 100 && head.status < 200 && head.status !== 101) head = await readResponseHead(reader, timer.signal);
      if (head === null) throw new NetError("ECONNRESET", `The server closed the connection before answering ${url.host}`, { hostname: urlHost(url) });
      return { head, reader, source: bodySource(reader, head, method), stream, origin: originOf(url), reused };
    } catch (error: unknown) {
      await stream.close();
      // A keep-alive connection the server had already closed: once more on a fresh one, when the body can be sent again.
      const stale = reused && error instanceof NetError && (error.code === "ECONNRESET" || error.code === "EPIPE");
      if (stale && attempt === 0 && body.kind !== "stream" && !signal.aborted) continue;
      if (timer.expired() && !signal.aborted) throw new NetError("ETIMEDOUT", `No response from ${url.host} within ${String(FETCH_TIMEOUTS.headersMs / 1000)} s`, { hostname: urlHost(url) });
      throw error;
    } finally { timer.clear(); }
  }
}

/** Ends an exchange whose body nobody reads: a short body is read so the connection can be reused, anything else closes it. */
async function discard(context: FetchContext, done: Exchange, signal: AbortSignal): Promise<void> {
  try {
    let total = 0;
    for (let chunk = await done.source.next(signal); chunk !== null; chunk = await done.source.next(signal)) { total += chunk.length; if (total > DRAIN_BYTES) throw new NetError("ERR_HTTP_BOUNDS", "redirect body too large to drain"); }
    if (done.source.delimited && keepsAlive(done.head) && done.reader.buffered === 0) context.pool.give(done.origin, done.stream); else await done.stream.close();
  } catch { await done.stream.close(); }
}

function bodyStream(context: FetchContext, done: Exchange, signal: AbortSignal): ReadableStream<Uint8Array> {
  let finished = false;
  const finish = async (reuse: boolean): Promise<void> => {
    if (finished) return; finished = true;
    signal.removeEventListener("abort", onAbort);
    if (reuse && done.source.delimited && keepsAlive(done.head) && done.reader.buffered === 0) context.pool.give(done.origin, done.stream); else await done.stream.close();
  };
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const onAbort = (): void => { controllerRef?.error(abortReason(signal)); void finish(false); };
  signal.addEventListener("abort", onAbort, { once: true });
  return new ReadableStream<Uint8Array>({
    start: controller => { controllerRef = controller; },
    pull: async controller => {
      const timer = deadline(FETCH_TIMEOUTS.bodyMs, signal, "Reading the response body");
      try {
        const chunk = await done.source.next(timer.signal);
        if (chunk === null) { await finish(true); controller.close(); } else controller.enqueue(chunk);
      } catch (error: unknown) {
        await finish(false);
        if (signal.aborted) controller.error(abortReason(signal));
        else controller.error(timer.expired() ? failed(new NetError("ETIMEDOUT", "The response body stalled", {})) : isAbort(error) ? error : failed(error));
      } finally { timer.clear(); }
    },
    cancel: async () => { await finish(false); },
  }, { highWaterMark: 0 });
}

/** Pipes `stream` through the browser's decompressor; an error on either side reaches the other. */
function decompress(stream: ReadableStream<Uint8Array>, format: CompressionFormat): ReadableStream<Uint8Array> {
  const decompressor = new DecompressionStream(format), writer = decompressor.writable.getWriter(), reader = stream.getReader();
  void (async () => {
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) await writer.write(new Uint8Array(next.value));
      await writer.close();
    } catch (error: unknown) {
      await writer.abort(error).catch(() => undefined);
      await reader.cancel(error).catch(() => undefined);
    }
  })();
  return decompressor.readable;
}

function decoded(stream: ReadableStream<Uint8Array>, encoding: string | undefined): ReadableStream<Uint8Array> {
  const codings = (encoding ?? "").toLowerCase().split(",").map(token => token.trim()).filter(token => token !== "" && token !== "identity").reverse();
  let current = stream;
  for (const coding of codings) {
    if (coding === "gzip" || coding === "x-gzip") current = decompress(current, "gzip");
    else if (coding === "deflate") current = decompress(current, "deflate");
    else return stream;
  }
  return current;
}

function responseOf(context: FetchContext, done: Exchange, url: URL, redirected: boolean, method: string, signal: AbortSignal): Response {
  const { head } = done, headers = new Headers();
  for (const [name, value] of head.fields) headers.append(name, value);
  if (head.status < 200 || head.status > 599) { void done.stream.close(); throw failed(new NetError("ERR_HTTP_PARSE", `HTTP response: status ${String(head.status)} cannot be returned`)); }
  const empty = NULL_BODY.has(head.status) || method === "HEAD";
  const body = empty ? null : decoded(bodyStream(context, done, signal), field(head, "content-encoding"));
  if (empty) void discard(context, done, signal);
  const finalUrl = new URL(url); finalUrl.hash = "";
  return new ModuleResponse(body, { status: head.status, statusText: head.statusText }, finalUrl.href, redirected, headers);
}

interface Normalized { readonly url: URL; readonly method: string; readonly headers: Headers; readonly body: BodyInit | null; readonly redirect: RequestRedirect; readonly signal: AbortSignal | null }

function normalize(input: RequestInfo | URL, init: RequestInit | undefined): Normalized {
  const request = input instanceof Request ? input : null;
  let url: URL;
  const text = request?.url ?? (input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
  try { url = new URL(text); } catch (error: unknown) { throw failed(new NetError("ERR_INVALID_URL", `Invalid URL ${text}`, { cause: error })); }
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(request?.headers);
  if (init?.headers !== undefined) for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  const body = init?.body ?? request?.body ?? null;
  if (body !== null && (method === "GET" || method === "HEAD")) throw new TypeError(`A ${method} request cannot have a body`);
  return { url, method, headers, body, redirect: init?.redirect ?? request?.redirect ?? "follow", signal: init?.signal ?? request?.signal ?? null };
}

/** The `fetch` a module with a network reach receives. */
export function createFetch(context: FetchContext): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = normalize(input, init);
    if (request.url.protocol === "blob:" && context.local !== undefined) return context.local(input, init);
    if (request.url.protocol !== "http:" && request.url.protocol !== "https:") throw failed(new NetError("ERR_UNSUPPORTED_SCHEME", `${request.url.protocol} URLs are not supported`));
    const signal = request.signal === null ? context.signal : AbortSignal.any([request.signal, context.signal]);
    if (signal.aborted) throw abortReason(signal);
    let { url, method, headers } = request, body = await requestBody(request.body, request.headers);
    try {
      for (let redirects = 0; ; redirects++) {
        const done = await exchange(context, url, method, headers, body, signal);
        const location = field(done.head, "location");
        if (!REDIRECTS.has(done.head.status) || location === undefined || request.redirect === "manual") return responseOf(context, done, url, redirects > 0, method, signal);
        await discard(context, done, signal);
        if (request.redirect === "error") throw failed(new NetError("ERR_HTTP_PARSE", `Redirected to ${location} with redirect: "error"`));
        if (redirects >= MAX_REDIRECTS) throw failed(new NetError("ERR_HTTP_BOUNDS", `More than ${String(MAX_REDIRECTS)} redirects`));
        let next: URL;
        try { next = new URL(location, url); } catch (error: unknown) { throw failed(new NetError("ERR_INVALID_URL", `Invalid redirect location ${location}`, { cause: error })); }
        if (next.protocol !== "http:" && next.protocol !== "https:") throw failed(new NetError("ERR_UNSUPPORTED_SCHEME", `Redirect to a ${next.protocol} URL`));
        if (done.head.status === 303 && method !== "GET" && method !== "HEAD" || (done.head.status === 301 || done.head.status === 302) && method === "POST") {
          method = "GET"; body = { kind: "none" };
          headers = new Headers(headers); for (const name of BODY_HEADERS) headers.delete(name);
        } else if (body.kind === "stream") throw failed(new NetError("ERR_HTTP_PARSE", "A streamed request body cannot follow a redirect"));
        if (originOf(next) !== originOf(url)) { headers = new Headers(headers); for (const name of CROSS_ORIGIN_HEADERS) headers.delete(name); }
        url = next;
      }
    } catch (error: unknown) {
      if (aborted(signal)) throw abortReason(signal);
      if (error instanceof TypeError || isAbort(error)) throw error;
      throw failed(error);
    }
  };
}
