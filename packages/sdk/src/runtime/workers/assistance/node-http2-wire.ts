import { Buffer } from "buffer";
import { exactKeys, integer, record, string } from "../../decode.js";
import { VMError } from "../../errors.js";
import { headerName, headerValue, type HeaderValue } from "./node-http-outgoing.js";

export const HTTP2_SERVICE_PROTOCOL_VERSION = 1;

export type Http2Headers = Readonly<Record<string, HeaderValue>>;
export type Http2Settings = Readonly<Partial<Record<"headerTableSize" | "initialWindowSize" | "maxFrameSize" | "maxConcurrentStreams" | "maxHeaderSize" | "maxHeaderListSize", number>> & { enablePush?: boolean; enableConnectProtocol?: boolean }>;
export interface Http2SocketInfo {
  readonly localAddress: string; readonly localPort: number; readonly localFamily: string;
  readonly remoteAddress: string; readonly remotePort: number; readonly remoteFamily: string;
  readonly encrypted: boolean; readonly authorized: boolean; readonly alpnProtocol: string | false;
}
type ErrorInfo = { readonly code: string; readonly message: string };
type StreamTarget = { readonly session: number; readonly stream: number };
export type Http2Event =
  | { readonly kind: "done" }
  | ({ readonly kind: "fatal" | "server-error" } & ErrorInfo)
  | { readonly kind: "server-close" | "server-timeout" }
  | { readonly kind: "listening"; readonly address: { readonly address: string; readonly port: number; readonly family: string } }
  | { readonly kind: "session" | "connect"; readonly session: number; readonly socket: Http2SocketInfo }
  | { readonly kind: "session-close" | "session-timeout"; readonly session: number }
  | ({ readonly kind: "session-error"; readonly session: number } & ErrorInfo)
  | { readonly kind: "localSettings" | "remoteSettings"; readonly session: number; readonly settings: Http2Settings }
  | { readonly kind: "goaway"; readonly session: number; readonly code: number; readonly lastStreamID: number; readonly data: Buffer }
  | ({ readonly kind: "stream"; readonly id: number; readonly headers: Http2Headers; readonly flags: number; readonly rawHeaders: string[] } & StreamTarget)
  | ({ readonly kind: "response" | "headers" | "trailers"; readonly headers: Http2Headers; readonly flags: number; readonly rawHeaders: string[] } & StreamTarget)
  | ({ readonly kind: "stream-ready"; readonly id: number } & StreamTarget)
  | ({ readonly kind: "end" | "aborted" | "wantTrailers" | "timeout" } & StreamTarget)
  | ({ readonly kind: "stream-close"; readonly rstCode: number } & StreamTarget)
  | ({ readonly kind: "stream-error" } & StreamTarget & ErrorInfo)
  | { readonly kind: "reply"; readonly request: number; readonly error: ErrorInfo | null }
  | { readonly kind: "settings-ack"; readonly request: number; readonly error: ErrorInfo | null; readonly settings: Http2Settings; readonly duration: number }
  | { readonly kind: "ping-ack"; readonly request: number; readonly error: ErrorInfo | null; readonly duration: number; readonly data: Buffer };

export function http2Failure(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
export function http2Id(value: unknown): number { return integer(value, "HTTP/2 identity", 1, 0x7fff_ffff); }
export function decodeHttp2Headers(value: unknown): Http2Headers {
  const source = record(value, "HTTP/2 headers");
  if (Object.keys(source).length > 128) throw http2Failure("ERR_HTTP2_HEADERS_TOO_LARGE", "Too many HTTP/2 headers");
  const result: Record<string, HeaderValue> = {}; Object.setPrototypeOf(result, null);
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith(":")) { if (!/^:[a-z]+$/u.test(name)) throw http2Failure("ERR_HTTP2_INVALID_PSEUDOHEADER", "Invalid HTTP/2 pseudoheader"); }
    else if (headerName(name) !== name) throw http2Failure("ERR_HTTP2_INVALID_HEADER_NAME", "HTTP/2 header names must be lowercase");
    if (["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"].includes(name)) throw http2Failure("ERR_HTTP2_INVALID_CONNECTION_HEADERS", "Connection-specific HTTP/2 header");
    result[name] = headerValue(value);
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 4096) throw http2Failure("ERR_HTTP2_HEADERS_TOO_LARGE", "HTTP/2 headers exceed the 4 KiB bridge limit");
  return result;
}
export function decodeHttp2Settings(value: unknown): Http2Settings {
  const source = record(value, "HTTP/2 settings");
  exactKeys(source, [], ["headerTableSize", "enablePush", "initialWindowSize", "maxFrameSize", "maxConcurrentStreams", "maxHeaderSize", "maxHeaderListSize", "enableConnectProtocol"]);
  const output: Partial<Record<"headerTableSize" | "initialWindowSize" | "maxFrameSize" | "maxConcurrentStreams" | "maxHeaderSize" | "maxHeaderListSize", number>> & { enablePush?: boolean; enableConnectProtocol?: boolean } = {};
  for (const name of ["headerTableSize", "initialWindowSize", "maxFrameSize", "maxConcurrentStreams", "maxHeaderSize", "maxHeaderListSize"] as const) {
    const value = source[name]; if (value !== undefined) output[name] = integer(value, name, name === "maxFrameSize" ? 16384 : 0, name === "initialWindowSize" ? 0x7fff_ffff : name === "maxFrameSize" ? 0xff_ffff : 0xffff_ffff);
  }
  for (const name of ["enablePush", "enableConnectProtocol"] as const) if (source[name] !== undefined) output[name] = boolean(source[name]);
  return output;
}
export function decodeHttp2Event(bytes: Uint8Array): Http2Event {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  const source = record(value, "HTTP/2 event"), kind = source["kind"];
  if (kind === "done" || kind === "server-close" || kind === "server-timeout") { exactKeys(source, ["kind"]); return { kind }; }
  if (kind === "fatal" || kind === "server-error") { exactKeys(source, ["kind", "code", "message"]); return { kind, ...errorInfo(source) }; }
  if (kind === "listening") {
    exactKeys(source, ["kind", "address"]); const address = record(source["address"], "HTTP/2 listening address"); exactKeys(address, ["address", "port", "family"]);
    return { kind, address: { address: text(address["address"], 4096), port: integer(address["port"], "port", 1, 65535), family: text(address["family"], 8) } };
  }
  if (kind === "reply" || kind === "settings-ack" || kind === "ping-ack") {
    exactKeys(source, ["kind", "request", "error", ...(kind === "settings-ack" ? ["settings", "duration"] : kind === "ping-ack" ? ["duration", "data"] : [])]);
    const request = http2Id(source["request"]), failure = source["error"] === null ? null : record(source["error"], "HTTP/2 reply error");
    if (failure !== null) exactKeys(failure, ["code", "message"]);
    const error = failure === null ? null : errorInfo(failure);
    if (kind === "reply") return { kind, request, error };
    const duration = source["duration"]; if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) throw invalid();
    if (kind === "settings-ack") return { kind, request, error, duration, settings: decodeHttp2Settings(source["settings"]) };
    const data = Buffer.from(text(source["data"], 16), "base64"); if (data.length !== (error === null ? 8 : 0)) throw invalid();
    return { kind, request, error, duration, data };
  }
  const session = http2Id(source["session"]);
  if (kind === "session" || kind === "connect") { exactKeys(source, ["kind", "session", "socket"]); return { kind, session, socket: socketInfo(source["socket"]) }; }
  if (kind === "session-close" || kind === "session-timeout") { exactKeys(source, ["kind", "session"]); return { kind, session }; }
  if (kind === "session-error") { exactKeys(source, ["kind", "session", "code", "message"]); return { kind, session, ...errorInfo(source) }; }
  if (kind === "localSettings" || kind === "remoteSettings") { exactKeys(source, ["kind", "session", "settings"]); return { kind, session, settings: decodeHttp2Settings(source["settings"]) }; }
  if (kind === "goaway") {
    exactKeys(source, ["kind", "session", "code", "lastStreamID", "data"]);
    return { kind, session, code: integer(source["code"], "HTTP/2 error", 0, 0xffff_ffff), lastStreamID: integer(source["lastStreamID"], "last stream ID", 0, 0x7fff_ffff), data: Buffer.from(text(source["data"], 8192), "base64") };
  }
  const stream = http2Id(source["stream"]);
  if (kind === "stream-ready") { exactKeys(source, ["kind", "session", "stream", "id"]); return { kind, session, stream, id: http2Id(source["id"]) }; }
  if (kind === "stream" || kind === "response" || kind === "headers" || kind === "trailers") {
    exactKeys(source, ["kind", "session", "stream", "headers", "flags", "rawHeaders", ...(kind === "stream" ? ["id"] : [])]);
    const raw = source["rawHeaders"]; if (!Array.isArray(raw) || raw.length > 256) throw invalid();
    const headers = decodeHttp2Headers(source["headers"]), flags = integer(source["flags"], "HTTP/2 flags", 0, 255), rawHeaders = raw.map((value: unknown) => text(value, 12_288));
    return kind === "stream" ? { kind, session, stream, headers, flags, rawHeaders, id: http2Id(source["id"]) } : { kind, session, stream, headers, flags, rawHeaders };
  }
  if (kind === "end" || kind === "aborted" || kind === "wantTrailers" || kind === "timeout") { exactKeys(source, ["kind", "session", "stream"]); return { kind, session, stream }; }
  if (kind === "stream-close") { exactKeys(source, ["kind", "session", "stream", "rstCode"]); return { kind, session, stream, rstCode: integer(source["rstCode"], "HTTP/2 reset code", 0, 0xffff_ffff) }; }
  if (kind === "stream-error") { exactKeys(source, ["kind", "session", "stream", "code", "message"]); return { kind, session, stream, ...errorInfo(source) }; }
  throw invalid();
}
function socketInfo(value: unknown): Http2SocketInfo {
  const source = record(value, "HTTP/2 socket"); exactKeys(source, ["localAddress", "localPort", "localFamily", "remoteAddress", "remotePort", "remoteFamily", "encrypted", "authorized", "alpnProtocol"]);
  return { localAddress: text(source["localAddress"], 4096), localPort: integer(source["localPort"], "local port", 1, 65535), localFamily: text(source["localFamily"], 8), remoteAddress: text(source["remoteAddress"], 4096), remotePort: integer(source["remotePort"], "remote port", 1, 65535), remoteFamily: text(source["remoteFamily"], 8), encrypted: boolean(source["encrypted"]), authorized: boolean(source["authorized"]), alpnProtocol: source["alpnProtocol"] === false ? false : text(source["alpnProtocol"], 255) };
}
function errorInfo(source: Record<string, unknown>): ErrorInfo { return { code: text(source["code"], 128), message: text(source["message"], 4096) }; }
function text(value: unknown, limit: number): string { const result = string(value, "HTTP/2 text"); if (Buffer.byteLength(result) > limit || result.includes("\0")) throw invalid(); return result; }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw invalid(); return value; }
function invalid(): VMError { return new VMError("PROTOCOL_ERROR", "Invalid native HTTP/2 event"); }
