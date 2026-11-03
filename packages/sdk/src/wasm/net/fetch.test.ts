import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync, deflateSync } from "node:zlib";
import { createFetch, FETCH_TIMEOUTS } from "./fetch.js";
import { dnsAnswerer } from "./dns-server.js";
import { rawHttpServer, responseBytes, type ParsedRequest } from "./memory-http.js";
import { MemoryNetwork, PASS_THROUGH_TLS, VM_ADDRESS } from "./memory-network.js";
import { ConnectionPool } from "./pool.js";
import { TlsError } from "./tls.js";
import type { TlsLayer } from "./streams.js";
import type { ModuleReach } from "../reach.js";

afterEach(() => { vi.useRealTimers(); });

const PUBLIC = "93.184.215.14";
const text = (value: string) => new TextEncoder().encode(value);

function setup(reach: ModuleReach = "internet", tls: TlsLayer = PASS_THROUGH_TLS) {
  const net = new MemoryNetwork(reach), pool = new ConnectionPool(), lifecycle = new AbortController();
  net.file("/etc/resolv.conf", "nameserver 10.0.2.3\n");
  net.file("/etc/hosts", `127.0.0.1 localhost\n${VM_ADDRESS} vm\n`);
  net.listenDatagram("10.0.2.3", 53, dnsAnswerer({ "example.com": [PUBLIC], "other.example": ["93.184.215.15"] }));
  net.state = "connected";
  const fetch = createFetch({ sockets: net.sockets(), reach, tls, pool, signal: lifecycle.signal });
  return { net, pool, lifecycle, fetch };
}

function serve(net: MemoryNetwork, address: string, port: number, respond: (request: ParsedRequest, write: (bytes: Uint8Array | string) => void, end: () => void) => void) {
  const server = rawHttpServer((request, connection) => { respond(request, bytes => { connection.write(typeof bytes === "string" ? text(bytes) : bytes); }, () => { connection.end(); }); });
  net.listen(address, port, server);
  return server;
}

describe("module fetch (ADR 0029, N-3)", () => {
  it("sends any header with Node's defaults and keeps header fidelity, including Set-Cookie", async () => {
    const { net, fetch } = setup();
    const server = serve(net, PUBLIC, 443, (_request, write) => { write(responseBytes(200, [["set-cookie", "a=1"], ["set-cookie", "b=2"], ["x-multi", "one"], ["x-multi", "two"]], "hello")); });
    const response = await fetch("https://example.com/path?q=1#frag", { headers: { cookie: "c=3", origin: "https://anything", "x-custom": "yes" } });
    expect([response.status, response.url, response.redirected, await response.text()]).toEqual([200, "https://example.com/path?q=1", false, "hello"]);
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(response.headers.get("x-multi")).toBe("one, two");
    const request = server.requests[0];
    expect(request?.target).toBe("/path?q=1");
    expect(Object.fromEntries(request?.fields ?? [])).toMatchObject({ host: "example.com", cookie: "c=3", origin: "https://anything", "x-custom": "yes", accept: "*/*", "accept-encoding": "gzip, deflate" });
  });

  it("follows redirects as the Fetch standard does: 303 to GET, cross-origin drops credentials, manual and error modes", async () => {
    const { net, fetch } = setup();
    serve(net, PUBLIC, 443, (request, write) => {
      if (request.target === "/start") write(responseBytes(303, [["location", "/next"]], "moved"));
      else if (request.target === "/next") write(responseBytes(302, [["location", "https://other.example/final"]]));
      else write(responseBytes(200, [], request.method));
    });
    const other = serve(net, "93.184.215.15", 443, (request, write) => { write(responseBytes(200, [], request.method)); });
    const response = await fetch("https://example.com/start", { method: "POST", body: "data", headers: { authorization: "secret", "x-keep": "1" } });
    expect([await response.text(), response.redirected, response.url]).toEqual(["GET", true, "https://other.example/final"]);
    const fields = Object.fromEntries(other.requests[0]?.fields ?? []);
    expect([fields["authorization"], fields["x-keep"], fields["content-type"]]).toEqual([undefined, "1", undefined]);
    const manual = await fetch("https://example.com/start", { redirect: "manual" });
    expect([manual.status, manual.headers.get("location")]).toEqual([303, "/next"]);
    await expect(fetch("https://example.com/start", { redirect: "error" })).rejects.toThrow(TypeError);
  });

  it("decodes chunked, gzip and deflate bodies and streams them", async () => {
    const { net, fetch } = setup();
    serve(net, PUBLIC, 80, (request, write) => {
      if (request.target === "/chunked") { write("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n"); write("6\r\n world\r\n0\r\nx-trailer: t\r\n\r\n"); }
      if (request.target === "/gzip") write(responseBytes(200, [["content-encoding", "gzip"]], gzipSync("zipped")));
      if (request.target === "/deflate") write(responseBytes(200, [["content-encoding", "deflate"]], deflateSync("deflated")));
    });
    expect(await (await fetch("http://example.com/chunked")).text()).toBe("hello world");
    expect(await (await fetch("http://example.com/gzip")).text()).toBe("zipped");
    expect(await (await fetch("http://example.com/deflate")).text()).toBe("deflated");
  });

  it("reuses a keep-alive connection, and retries once when the server had closed it", async () => {
    const { net, fetch, pool } = setup();
    let connections = 0;
    // The server closes each connection after its second answer, without saying so: the third request finds it closed.
    const answered = new Map<unknown, number>();
    net.listen(PUBLIC, 80, { ...rawHttpServer((_request, connection) => {
      connection.write(responseBytes(200, [], "ok"));
      const count = (answered.get(connection) ?? 0) + 1;
      answered.set(connection, count);
      if (count === 2) connection.end();
    }), connected: () => { connections++; } });
    await (await fetch("http://example.com/a")).text();
    expect(pool.size).toBe(1);
    await (await fetch("http://example.com/b")).text();
    expect(connections).toBe(1);
    expect(await (await fetch("http://example.com/c")).text()).toBe("ok");
    expect(connections).toBe(2);
  });

  it("streams a request body with chunked encoding", async () => {
    const { net, fetch } = setup();
    const server = serve(net, PUBLIC, 80, (request, write) => { write(responseBytes(200, [], request.body)); });
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(text("ab")); controller.enqueue(text("cd")); controller.close(); } });
    const init: RequestInit & { readonly duplex: "half" } = { method: "PUT", body, duplex: "half" };
    expect(await (await fetch("http://example.com/up", init)).text()).toBe("abcd");
    expect(Object.fromEntries(server.requests[0]?.fields ?? [])["transfer-encoding"]).toBe("chunked");
  });

  it("aborts mid-body: the stream errors with the abort reason and the connection is closed", async () => {
    const { net, fetch, pool } = setup();
    serve(net, PUBLIC, 80, (_request, write) => { write("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\nfirst"); });
    const controller = new AbortController(), response = await fetch("http://example.com/slow", { signal: controller.signal });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    const next = reader.read();
    controller.abort(new DOMException("stop", "AbortError"));
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    expect(pool.size).toBe(0);
  });

  it("bounds the response head and times out a silent server", async () => {
    const { net, fetch } = setup();
    serve(net, PUBLIC, 80, (request, write) => { if (request.target === "/huge") write(`HTTP/1.1 200 OK\r\nx: ${"a".repeat(70 * 1024)}\r\n\r\n`); });
    await expect(fetch("http://example.com/huge")).rejects.toMatchObject({ message: "fetch failed", cause: { code: "ERR_HTTP_BOUNDS" } });
    vi.useFakeTimers();
    const pending = fetch("http://example.com/silent"), outcome = expect(pending).rejects.toMatchObject({ cause: { code: "ETIMEDOUT" } });
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUTS.headersMs);
    await outcome;
  });

  it("local-only is EPERM vm-local-only, a revoke is ECONNRESET, and a VM-only module gets module-network-reach", async () => {
    const offline = setup();
    offline.net.state = "local-only";
    await expect(offline.fetch(`http://${PUBLIC}/`)).rejects.toMatchObject({ name: "TypeError", message: "fetch failed", cause: { code: "EPERM", reason: "vm-local-only" } });
    const revoked = setup();
    serve(revoked.net, PUBLIC, 80, (_request, write) => { write("HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nabc"); });
    const response = await revoked.fetch("http://example.com/download"), reader = response.body?.getReader();
    await reader?.read();
    revoked.net.revoke();
    await expect(reader?.read()).rejects.toMatchObject({ cause: { code: "ECONNRESET" } });
    const vmOnly = setup("vm");
    serve(vmOnly.net, VM_ADDRESS, 8080, (_request, write) => { write(responseBytes(200, [], "inside")); });
    expect(await (await vmOnly.fetch("http://vm:8080/")).text()).toBe("inside");
    await expect(vmOnly.fetch(`http://${PUBLIC}/`)).rejects.toMatchObject({ cause: { code: "EACCES", reason: "module-network-reach" } });
  });

  it("a certificate failure rejects with TypeError and the TLS failure as its cause", async () => {
    const failing: TlsLayer = { wrap: () => Promise.reject(new TlsError("unknown-issuer", "example.com")), wrapSync: () => { throw new TlsError("unknown-issuer"); }, session: () => { throw new TlsError("unknown-issuer"); } };
    const { net, fetch } = setup("internet", failing);
    serve(net, PUBLIC, 443, (_request, write) => { write(responseBytes(200, [])); });
    await expect(fetch("https://example.com/")).rejects.toMatchObject({ name: "TypeError", cause: { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", tlsFailure: "unknown-issuer" } });
  });
});
