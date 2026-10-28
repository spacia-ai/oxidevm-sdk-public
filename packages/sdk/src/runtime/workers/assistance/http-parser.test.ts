import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { HttpParser, type HttpRequestHead, type HttpResponseHead } from "./http-parser.js";

const require = createRequire(import.meta.url);
const bytes: unknown = require("undici/lib/llhttp/llhttp-wasm.js");
if (!(bytes instanceof Uint8Array)) throw new TypeError("Invalid llhttp artifact bytes");
if (createHash("sha256").update(bytes).digest("hex") !== "57184a16144b5bc880e29105fa35d75c93dd318563e1b743e110de845e2ab661") throw new Error("llhttp artifact identity drift");
const module = new WebAssembly.Module(new Uint8Array(bytes));

it("parses fragmented chunked bodies, empty headers, trailers and pipelined requests", () => {
  const heads: HttpRequestHead[] = []; const bodies: string[] = []; const trailers: unknown[] = [];
  const parser = new HttpParser(module, { kind: "request", headers: head => heads.push(head),
    body: bytes => { bodies.push(Buffer.from(bytes).toString()); return true; },
    complete: value => { trailers.push(value); return true; } });
  const input = Buffer.from("POST /api?q=1 HTTP/1.1\r\nHost: local\r\nX-Empty:\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\nX-Trailer: yes\r\n\r\nGET /next HTTP/1.1\r\nHost: local\r\n\r\n");
  for (const byte of input) expect(parser.feed(Uint8Array.of(byte))).toEqual({ consumed: 1, state: "ready" });
  parser.finish(); parser.close(); parser.close();
  expect(heads.map(head => [head.method, head.url, head.keepAlive])).toEqual([["POST", "/api?q=1", true], ["GET", "/next", true]]);
  expect(heads[0]?.headers).toEqual([["Host", "local"], ["X-Empty", ""], ["Transfer-Encoding", "chunked"]]);
  expect(bodies.join("")).toBe("abc");
  expect(trailers).toEqual([[["X-Trailer", "yes"]], []]);
});

it("pauses without consuming the next request and retains upgrade bytes", () => {
  const heads: string[] = [];
  const parser = new HttpParser(module, { kind: "request", headers: head => heads.push(head.url), body: () => true, complete: () => false });
  const first = "GET /first HTTP/1.1\r\nHost: local\r\n\r\n";
  const next = "GET /next HTTP/1.1\r\nHost: local\r\n\r\n";
  const input = Buffer.from(first + next);
  expect(parser.feed(input)).toEqual({ consumed: first.length, state: "paused" });
  expect(() => parser.feed(input)).toThrow("paused");
  parser.resume();
  expect(parser.feed(input.subarray(first.length))).toEqual({ consumed: next.length, state: "paused" });
  expect(heads).toEqual(["/first", "/next"]); parser.close();
  const upgrade = new HttpParser(module, { kind: "request", headers: head => expect(head.upgrade).toBe(true), body: () => true, complete: () => true });
  const header = "GET /socket HTTP/1.1\r\nHost: local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";
  expect(upgrade.feed(Buffer.from(header + "frame"))).toEqual({ consumed: header.length, state: "upgrade" });
  upgrade.close();
});

it("rejects ambiguous framing, incomplete bodies, excessive headers and reentry", () => {
  const callbacks = { kind: "request" as const, headers: () => {}, body: () => true, complete: () => true };
  for (const input of [
    "POST / HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n",
    "GET / HTTP/1.1\r\n" + "X: y\r\n".repeat(129) + "\r\n",
    "GET /" + "x".repeat(8192) + " HTTP/1.1\r\n\r\n",
  ]) {
    const parser = new HttpParser(module, callbacks);
    expect(() => parser.feed(Buffer.from(input))).toThrow();
    expect(() => parser.feed(new Uint8Array())).toThrow("retired");
  }
  const incomplete = new HttpParser(module, callbacks);
  incomplete.feed(Buffer.from("POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nx"));
  expect(() => incomplete.finish()).toThrow("Incomplete");
  expect(() => incomplete.feed(new Uint8Array())).toThrow("retired"); incomplete.close();
  const reentrant = new HttpParser(module, { ...callbacks, headers: () => reentrant.feed(new Uint8Array()) });
  expect(() => reentrant.feed(Buffer.from("GET / HTTP/1.1\r\n\r\n"))).toThrow("reentered");
});

it("resumes body backpressure at the exact byte and preserves Latin-1 header octets", () => {
  const bodies: Uint8Array[] = []; let completions = 0;
  const parser = new HttpParser(module, { kind: "request",
    headers: head => expect(head.headers).toContainEqual(["X-Octet", "\u0080"]),
    body: bytes => { bodies.push(bytes); return false; }, complete: () => { completions++; return true; },
  });
  const prefix = Buffer.from("POST / HTTP/1.1\r\nContent-Length: 6\r\nX-Octet: \x80\r\n\r\nabc", "latin1");
  expect(parser.feed(prefix)).toEqual({ consumed: prefix.length, state: "paused" });
  parser.resume();
  expect(parser.feed(Buffer.from("def"))).toEqual({ consumed: 3, state: "paused" });
  parser.resume(); parser.feed(new Uint8Array()); parser.finish(); parser.close();
  expect(Buffer.concat(bodies).toString()).toBe("abcdef");
  expect(completions).toBe(1);
});

it("parses fragmented interim and final responses with streamed bodies and trailers", () => {
  const heads: HttpResponseHead[] = []; const chunks: Uint8Array[] = []; const trailers: unknown[] = [];
  const parser = new HttpParser(module, { kind: "response",
    headers(head) { heads.push(head); return "body"; },
    body(bytes) { chunks.push(bytes); return true; },
    complete(value) { trailers.push(value); return true; },
  });
  try {
    const response = Buffer.from("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n3\r\nabc\r\n0\r\nX-Trailer: yes\r\n\r\n");
    for (const byte of response) expect(parser.feed(Uint8Array.of(byte)).state).toBe("ready");
    parser.finish();
    expect(heads.map(head => [head.statusCode, head.statusMessage, head.keepAlive])).toEqual([[100, "Continue", true], [201, "Created", true]]);
    expect(heads[1]?.headers).toContainEqual(["Set-Cookie", "b=2"]);
    expect(Buffer.concat(chunks).toString()).toBe("abc");
    expect(trailers).toEqual([[], [["X-Trailer", "yes"]]]);
  } finally { parser.close(); }
});

it("handles HEAD framing, EOF-delimited bodies, and CONNECT upgrade boundaries", () => {
  let completed = 0;
  const head = new HttpParser(module, { kind: "response", headers: () => "skip-body", body: () => { throw new Error("HEAD body"); }, complete: () => { completed++; return true; } });
  head.feed(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n"));
  head.finish(); head.close(); expect(completed).toBe(1);
  const chunks: Uint8Array[] = [];
  const eof = new HttpParser(module, { kind: "response", headers: () => "body", body: bytes => { chunks.push(bytes); return true; }, complete: () => { completed++; return true; } });
  eof.feed(Buffer.from("HTTP/1.0 200 OK\r\n\r\nbody"));
  expect(completed).toBe(1); eof.finish(); eof.close();
  expect(completed).toBe(2); expect(Buffer.concat(chunks).toString()).toBe("body");
  const tunnel = new HttpParser(module, { kind: "response", headers: () => "upgrade", body: () => true, complete: () => true });
  const header = "HTTP/1.1 200 Connection Established\r\n\r\n";
  expect(tunnel.feed(Buffer.from(header + "tunnel bytes"))).toEqual({ consumed: header.length, state: "upgrade" });
  tunnel.close();
});

it("rejects ambiguous or truncated responses and preserves response backpressure", () => {
  const callbacks = { kind: "response" as const, headers: () => "body" as const, body: () => true, complete: () => true };
  const invalid = new HttpParser(module, callbacks);
  expect(() => invalid.feed(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n"))).toThrow();
  expect(() => invalid.feed(new Uint8Array())).toThrow("retired");
  const incomplete = new HttpParser(module, callbacks);
  incomplete.feed(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nx"));
  expect(() => incomplete.finish()).toThrow("Incomplete");
  const oversized = new HttpParser(module, callbacks);
  oversized.feed(Buffer.from("HTTP/1.1 200 " + "x".repeat(65_000)));
  expect(() => oversized.feed(Buffer.from("x".repeat(1000)))).toThrow("exceed");
  const chunks: Uint8Array[] = []; let completed = 0;
  const parser = new HttpParser(module, { ...callbacks,
    body(bytes) { chunks.push(bytes); return false; }, complete() { completed++; return true; },
  });
  try {
    const first = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nabc");
    expect(parser.feed(first)).toEqual({ consumed: first.length, state: "paused" });
    parser.resume();
    expect(parser.feed(Buffer.from("def"))).toEqual({ consumed: 3, state: "paused" });
    parser.resume(); parser.feed(new Uint8Array()); parser.finish();
    expect(Buffer.concat(chunks).toString()).toBe("abcdef"); expect(completed).toBe(1);
  } finally { parser.close(); }
});
