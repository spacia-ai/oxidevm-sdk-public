import { exactKeys, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { UNKNOWN_CLIENT, type ClientContext } from "./preview-cookies.js";

export const MAX_HEADER_BYTES = 64 * 1024;

export interface PreviewRequest {
  readonly port: MessagePort;
  readonly method: string;
  readonly path: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly hasBody: boolean;
  /** Where the request comes from, for the session jar's SameSite decisions. */
  readonly client: ClientContext;
}

/** What a forwarded request carries besides the browser's headers: the session
 * origin (named only in X-Forwarded headers, and mapped to and from the guest
 * listener in Origin, Referer and response URLs) and the cookie header the
 * session jar assembled; the browser's own cookie header is never forwarded. */
export interface ForwardingOptions {
  readonly origin?: URL;
  readonly cookie?: string;
}

/** Response headers that never reach the browser: cookies travel as jar
 * decisions, and the rest would bind the session origin or its embedder. */
export const RESPONSE_STRIP_HEADERS = new Set(["set-cookie", "clear-site-data", "strict-transport-security", "x-frame-options", "alt-svc", "report-to"]);

export interface PreviewWebSocketRequest {
  readonly port: MessagePort;
  readonly path: string;
  readonly protocols: readonly string[];
}

export function decodeRequest(value: unknown): PreviewRequest {
  const request = record(value, "preview request");
  exactKeys(request, ["kind", "port", "method", "path", "headers", "hasBody"], ["client"]);
  if (request["kind"] !== "request" || !(request["port"] instanceof MessagePort) || typeof request["hasBody"] !== "boolean") throw new TypeError("invalid preview request");
  const method = string(request["method"], "preview method");
  const path = string(request["path"], "preview path");
  if (!/^[A-Z]{1,16}$/.test(method) || !validTarget(path)) throw new TypeError("invalid preview request target");
  if (!Array.isArray(request["headers"]) || request["headers"].length > 128) throw new TypeError("invalid preview headers");
  let total = 0;
  const headers = request["headers"].map((value) => {
    if (!Array.isArray(value) || value.length !== 2) throw new TypeError("invalid preview header");
    const name = string(value[0], "preview header name").toLowerCase();
    const header = string(value[1], "preview header value");
    total += name.length + header.length;
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || !validHeaderValue(header) || total > MAX_HEADER_BYTES) throw new TypeError("invalid preview header");
    return [name, header] as const;
  });
  return { port: request["port"], method, path, headers, hasBody: request["hasBody"],
    client: request["client"] === undefined ? UNKNOWN_CLIENT : decodeClient(request["client"]) };
}

function decodeClient(value: unknown): ClientContext {
  const client = record(value, "preview client");
  exactKeys(client, ["frame", "ancestor", "navigate"]);
  const frame = client["frame"];
  const ancestor = client["ancestor"];
  const navigate = client["navigate"];
  if ((frame !== "top" && frame !== "nested" && frame !== "none") || typeof navigate !== "boolean"
    || (ancestor !== null && (typeof ancestor !== "string" || ancestor.length > 256))) {
    throw new TypeError("invalid preview client context");
  }
  return { frame, ancestor, navigate };
}

export function decodeWebSocketRequest(value: unknown): PreviewWebSocketRequest {
  const request = record(value, "preview WebSocket request");
  exactKeys(request, ["kind", "port", "path", "protocols"]);
  if (request["kind"] !== "websocket" || !(request["port"] instanceof MessagePort)) throw new TypeError("invalid preview WebSocket request");
  const path = string(request["path"], "preview WebSocket path");
  if (!validTarget(path)) throw new TypeError("invalid preview WebSocket target");
  const protocols = request["protocols"];
  if (!Array.isArray(protocols) || protocols.length > 16 || protocols.some((value) => typeof value !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(value)) || new Set(protocols).size !== protocols.length) throw new TypeError("invalid preview WebSocket protocols");
  return { port: request["port"], path, protocols };
}

/** The guest sees exactly what a developer's browser sends to its own server:
 * `Host: localhost:<port>`, and Origin/Referer on `http://localhost:<port>` when
 * they name the session origin. Development servers trust only localhost-like
 * hosts and origins by default (Vite's allowedHosts, Next.js allowedDevOrigins,
 * webpack-dev-server), so a session host would be refused. X-Forwarded-Proto
 * and X-Forwarded-Host still name the session origin for proxy-aware servers;
 * those checks read Host and Origin only. */
export function encodeHead(request: PreviewRequest, port: number, options: ForwardingOptions = {}): Uint8Array {
  const headers: Array<readonly [string, string]> = request.headers
    .filter(([name]) => !HOP_HEADERS.has(name) && name !== "host" && name !== "cookie")
    .map(([name, value]) => [name, towardGuest(name, value, port, options.origin)] as const);
  headers.push(["host", guestHost(port)], ["connection", "close"], ...forwarded(options.origin));
  if (options.cookie !== undefined) headers.push(["cookie", options.cookie]);
  headers.push(request.hasBody ? ["transfer-encoding", "chunked"] : ["content-length", "0"]);
  return encodeRequestHead(request.method, request.path, headers);
}

/** A WebSocket upgrade as a browser on localhost opens it: browsers always send
 * Origin, and Vite then requires the token its client puts in the path. */
export function encodeUpgradeHead(request: PreviewWebSocketRequest, port: number, key: string, options: Pick<ForwardingOptions, "origin"> = {}): Uint8Array {
  const headers: Array<readonly [string, string]> = [
    ["host", guestHost(port)], ["origin", guestOrigin(port)], ["connection", "Upgrade"], ["upgrade", "websocket"],
    ["sec-websocket-version", "13"], ["sec-websocket-key", key], ...forwarded(options.origin),
  ];
  if (request.protocols.length !== 0) headers.push(["sec-websocket-protocol", request.protocols.join(", ")]);
  return encodeRequestHead("GET", request.path, headers);
}

/** Response headers whose absolute URLs may name the guest listener. */
const GUEST_URL_HEADERS = new Set(["location", "content-location", "access-control-allow-origin"]);
// The scheme and loopback authority of an absolute URL; the rest is kept byte for byte.
const LOOPBACK_URL = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?(?=[/?#]|$)/iu;
const REFRESH = /^(\s*\d*(?:\.\d*)?\s*[;,]?\s*(?:url\s*=\s*)?["']?)(.*)$/iu;

/** Maps the guest listener's own absolute URLs in redirect, location and CORS
 * headers back to the session origin, so the browser follows them there.
 * Other URLs, other ports and bodies are untouched. */
export function rewriteResponseHeaders(headers: ReadonlyArray<readonly [string, string]>, port: number, origin: URL | undefined): Array<readonly [string, string]> {
  if (origin === undefined) return [...headers];
  return headers.map(([name, value]) => {
    if (GUEST_URL_HEADERS.has(name)) return [name, towardSession(value, port, origin)] as const;
    if (name !== "refresh") return [name, value] as const;
    const match = REFRESH.exec(value);
    return [name, match === null ? value : `${match[1] ?? ""}${towardSession(match[2] ?? "", port, origin)}`] as const;
  });
}

function towardSession(value: string, port: number, origin: URL): string {
  const match = LOOPBACK_URL.exec(value);
  if (match === null || Number(match[1] ?? "80") !== port) return value;
  return `${origin.origin}${value.slice(match[0].length)}`;
}

function towardGuest(name: string, value: string, port: number, origin: URL | undefined): string {
  if (origin === undefined) return value;
  if (name === "origin") return value === origin.origin ? guestOrigin(port) : value;
  if (name !== "referer" || !URL.canParse(value)) return value;
  const referer = new URL(value);
  return referer.origin === origin.origin ? `${guestOrigin(port)}${referer.pathname}${referer.search}` : value;
}

function guestHost(port: number): string {
  return port === 80 ? "localhost" : `localhost:${port}`;
}

function guestOrigin(port: number): string {
  return `http://${guestHost(port)}`;
}

function forwarded(origin: URL | undefined): Array<readonly [string, string]> {
  return origin === undefined ? [] : [["x-forwarded-proto", origin.protocol.slice(0, -1)], ["x-forwarded-host", origin.host]];
}

function encodeRequestHead(method: string, path: string, headers: ReadonlyArray<readonly [string, string]>): Uint8Array {
  return new TextEncoder().encode(`${method} ${path} HTTP/1.1\r\n${headers.map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`);
}

export function parseHead(bytes: Uint8Array): { readonly status: number; readonly statusText: string; readonly headers: Array<readonly [string, string]> } {
  if (bytes.byteLength > MAX_HEADER_BYTES || bytes.byteLength < 4
      || bytes.at(-4) !== 13 || bytes.at(-3) !== 10 || bytes.at(-2) !== 13 || bytes.at(-1) !== 10) {
    throw new VMError("PROTOCOL_ERROR", "invalid preview response header boundary");
  }
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, -4)).split("\r\n");
  const match = lines.shift()?.match(/^HTTP\/1\.[01] ([1-5][0-9]{2})(?: (.{0,128}))?$/);
  if (match?.[1] === undefined || !validHeaderValue(match[2] ?? "") || lines.length > 128) throw new VMError("PROTOCOL_ERROR", "invalid preview response status");
  const headers: Array<readonly [string, string]> = [];
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new VMError("PROTOCOL_ERROR", "invalid preview response header");
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).replace(/^[ \t]+|[ \t]+$/gu, "");
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || !validHeaderValue(value)) throw new VMError("PROTOCOL_ERROR", "invalid preview response header");
    headers.push([name, value]);
  }
  const lengths = headers.filter(([name]) => name === "content-length");
  const encodings = headers.filter(([name]) => name === "transfer-encoding");
  if (lengths.length > 1 || encodings.length > 1 || (lengths.length !== 0 && encodings.length !== 0)) {
    throw new VMError("PROTOCOL_ERROR", "ambiguous preview response framing");
  }
  const length = lengths[0]?.[1];
  const encoding = encodings[0]?.[1];
  if (length !== undefined && (!/^[0-9]+$/u.test(length) || !Number.isSafeInteger(Number(length)))) {
    throw new VMError("PROTOCOL_ERROR", "invalid preview response length");
  }
  if (encoding !== undefined && encoding.toLowerCase() !== "chunked") {
    throw new VMError("PROTOCOL_ERROR", "unsupported preview transfer encoding");
  }
  return { status: Number(match[1]), statusText: match[2] ?? "", headers };
}

export const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length"]);

function validTarget(path: string): boolean {
  if (!path.startsWith("/") || path.length > 8192 || path.includes("#")) return false;
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code <= 32 || code >= 127) return false;
  }
  return true;
}

function validHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code !== 9 && (code < 32 || code === 127)) return false;
  }
  return true;
}
