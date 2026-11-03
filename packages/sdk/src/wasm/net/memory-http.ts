import type { MemoryConnection, MemoryServer } from "./memory-network.js";

/**
 * HTTP/1.1 servers for the in-memory network (`testHost` and unit tests): one that hands each parsed request to a raw
 * responder, which writes exact bytes, and one that answers with a standard `Request` → `Response` handler. Requests are
 * parsed with Content-Length or chunked bodies; several may arrive on one connection.
 */
export interface ParsedRequest {
  readonly method: string;
  readonly target: string;
  /** Field names in lower case, in order. */
  readonly fields: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}

const latin1 = new TextDecoder("latin1"), encoder = new TextEncoder();

function find(bytes: Uint8Array, text: string, from = 0): number {
  const needle = encoder.encode(text);
  outer: for (let index = from; index <= bytes.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) if (bytes[index + offset] !== needle[offset]) continue outer;
    return index;
  }
  return -1;
}

/** Parses one complete request from the front of `buffer`; null when more bytes are needed. */
function parseRequest(buffer: Uint8Array): { readonly request: ParsedRequest; readonly used: number } | null {
  const end = find(buffer, "\r\n\r\n");
  if (end < 0) return null;
  const [line = "", ...rest] = latin1.decode(buffer.subarray(0, end)).split("\r\n"), [method = "", target = ""] = line.split(" ");
  const fields = rest.map(item => { const colon = item.indexOf(":"); return [item.slice(0, colon).toLowerCase(), item.slice(colon + 1).trim()] as const; });
  const value = (name: string): string | undefined => fields.find(([key]) => key === name)?.[1];
  let at = end + 4;
  if (value("transfer-encoding")?.toLowerCase() === "chunked") {
    const parts: Uint8Array[] = [];
    for (;;) {
      const lineEnd = find(buffer, "\r\n", at);
      if (lineEnd < 0) return null;
      const size = Number.parseInt(latin1.decode(buffer.subarray(at, lineEnd)), 16);
      if (buffer.length < lineEnd + 2 + size + 2) return null;
      parts.push(buffer.slice(lineEnd + 2, lineEnd + 2 + size)); at = lineEnd + 2 + size + 2;
      if (size === 0) break;
    }
    const body = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0; for (const part of parts) { body.set(part, offset); offset += part.length; }
    return { request: { method, target, fields, body }, used: at };
  }
  const length = Number(value("content-length") ?? "0");
  if (buffer.length < at + length) return null;
  return { request: { method, target, fields, body: buffer.slice(at, at + length) }, used: at + length };
}

/** A server that hands every request to `respond`, which writes the raw answer on the connection. */
export function rawHttpServer(respond: (request: ParsedRequest, connection: MemoryConnection) => void): MemoryServer & { readonly requests: ParsedRequest[] } {
  const buffers = new Map<MemoryConnection, Uint8Array>(), requests: ParsedRequest[] = [];
  return {
    requests,
    data(connection, bytes) {
      const previous = buffers.get(connection) ?? new Uint8Array();
      let buffer = new Uint8Array(previous.length + bytes.length);
      buffer.set(previous); buffer.set(bytes, previous.length);
      for (let parsed = parseRequest(buffer); parsed !== null; parsed = parseRequest(buffer)) {
        buffer = buffer.slice(parsed.used); requests.push(parsed.request); respond(parsed.request, connection);
      }
      buffers.set(connection, buffer);
    },
    ended(connection) { buffers.delete(connection); },
  };
}

/** The bytes of a response with a Content-Length body. */
export function responseBytes(status: number, fields: readonly (readonly [string, string])[], body: Uint8Array | string = ""): Uint8Array {
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  const head = encoder.encode(`HTTP/1.1 ${String(status)} ${status === 200 ? "OK" : "Status"}\r\n${[...fields, ["content-length", String(bytes.length)]].map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`);
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head); out.set(bytes, head.length);
  return out;
}

/** A server that answers each request with a `Request` → `Response` handler, the response body read whole. */
export function handlerServer(scheme: "http" | "https", handler: (request: Request) => Response | Promise<Response>): MemoryServer {
  return rawHttpServer((parsed, connection) => {
    const host = parsed.fields.find(([name]) => name === "host")?.[1] ?? "localhost";
    const headers = new Headers();
    for (const [name, value] of parsed.fields) headers.append(name, value);
    const body = parsed.method === "GET" || parsed.method === "HEAD" ? null : new Uint8Array(parsed.body);
    void Promise.resolve()
      .then(() => handler(new Request(`${scheme}://${host}${parsed.target}`, { method: parsed.method, headers, body })))
      .then(async response => {
        const bytes = new Uint8Array(await response.arrayBuffer()), fields: [string, string][] = [];
        response.headers.forEach((value, name) => { if (name !== "content-length" && name !== "transfer-encoding") fields.push([name, value]); });
        connection.write(responseBytes(response.status, fields, parsed.method === "HEAD" ? new Uint8Array() : bytes));
        // A client that asked to close gets the end of the stream after its answer, as an HTTP/1.1 server gives it.
        if (parsed.fields.some(([name, value]) => name === "connection" && value.toLowerCase() === "close")) connection.end();
      }, () => { connection.write(responseBytes(500, [], "handler failed")); });
  });
}
