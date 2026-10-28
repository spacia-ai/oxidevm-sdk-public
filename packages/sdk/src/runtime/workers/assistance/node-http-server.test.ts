import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeNet } from "./node-net.js";
import { createHttpServers } from "./node-http-server.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";

const wasm: unknown = createRequire(import.meta.url)("undici/lib/llhttp/llhttp-wasm.js");
if (!(wasm instanceof Uint8Array)) throw new TypeError("Missing llhttp artifact");
const module = new WebAssembly.Module(new Uint8Array(wasm));

function fixture(requestBytes: string) {
  const context = createAsyncContext(); const output: Uint8Array[] = []; const closed: number[] = [];
  const listener = { kind: "socket", fd: 1, local: { address: "127.0.0.1", port: 3000 }, peer: null } as const;
  const accepted = { ...listener, fd: 2, peer: { address: "127.0.0.1", port: 1234 } } as const;
  const accept = Promise.withResolvers<AssistanceResult>(); const read = Promise.withResolvers<AssistanceResult>();
  let accepts = 0; let reads = 0;
  const net = createNodeNet({ retain: () => () => {}, callSync: () => accepted,
    call(operation) {
      if (operation.kind === "socket-listen") return Promise.resolve(listener);
      if (operation.kind === "socket-accept") return ++accepts === 1 ? Promise.resolve(accepted) : accept.promise;
      if (operation.kind === "socket-read") return ++reads === 1
        ? Promise.resolve({ kind: "data", bytes: new TextEncoder().encode(requestBytes) }) : read.promise;
      if (operation.kind === "socket-write") { output.push(operation.bytes); return Promise.resolve({ kind: "written", count: operation.bytes.length }); }
      if (operation.kind === "socket-close") {
        closed.push(operation.fd);
        if (operation.fd === 1) accept.resolve({ kind: "error", errno: 9, code: "EBADF", syscall: "accept", path: null, destination: null });
        else read.resolve({ kind: "data", bytes: new Uint8Array() });
      }
      return Promise.resolve({ kind: "unit" });
    },
  }, context);
  return { http: createHttpServers(net, module, context), net, output, closed };
}

it("serves a Linux accepted connection and closes the listener plus idle sockets", async () => {
  const { http, net, output, closed } = fixture("GET /api HTTP/1.1\r\nHost: local\r\n\r\n");
  const done = Promise.withResolvers<undefined>();
  const server = http.createServer((request, response) => {
    expect(request).toBeInstanceOf(Reflect.get(http, "IncomingMessage"));
    expect(response).toBeInstanceOf(Reflect.get(http, "ServerResponse"));
    expect(request.url).toBe("/api"); request.resume();
    response.sendDate = false; response.setHeader("Content-Type", "application/json"); response.end('{"ok":true}');
    server.close(() => done.resolve(undefined));
  });
  expect(server instanceof net.Server).toBe(true);
  server.listen(3000); await done.promise;
  expect(closed).toEqual([1, 2]);
  expect(Buffer.concat(output).toString()).toBe('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\nb\r\n{"ok":true}\r\n0\r\n\r\n');
});

it("sends a framed default error response for malformed input", async () => {
  const { http, net, output, closed } = fixture("INVALID / HTTP/1.1\r\n\r\n");
  const retired = Promise.withResolvers<undefined>();
  const server = http.createServer(() => { throw new Error("Malformed request dispatched"); });
  server.on("connection", (socket: unknown) => {
    if (!(socket instanceof net.Socket)) throw new Error("Socket missing");
    socket.once("close", () => server.close(() => retired.resolve(undefined)));
  });
  server.listen(3000); await retired.promise;
  expect(Buffer.concat(output).toString()).toBe("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  expect(closed).toEqual([2, 1]);
});

it("sends Continue before request dispatch and allows an application to own expectations", async () => {
  for (const own of [false, true]) {
    const { http, output } = fixture("POST / HTTP/1.1\r\nHost: local\r\nExpect: 100-continue\r\nContent-Length: 0\r\n\r\n");
    const retired = Promise.withResolvers<undefined>();
    const server = http.createServer((request, response) => {
      if (own) throw new Error("checkContinue also dispatched request");
      request.resume(); response.sendDate = false; response.setHeader("Content-Length", 0); response.end();
      server.close(() => retired.resolve(undefined));
    });
    if (own) server.on("checkContinue", (request: unknown, response: unknown) => {
      if (typeof request !== "object" || request === null || typeof response !== "object" || response === null) throw new Error("Missing HTTP objects");
      // Owning the expectation may reject it without reading a body.
      server.closeAllConnections(); server.close(() => retired.resolve(undefined));
    });
    server.listen(3000); await retired.promise;
    const text = Buffer.concat(output).toString();
    expect(text.startsWith("HTTP/1.1 100 Continue\r\n\r\n")).toBe(!own);
  }
});

it("rejects unsupported expectations without dispatching the request", async () => {
  const { http, output } = fixture("POST / HTTP/1.1\r\nHost: local\r\nExpect: unsupported\r\nContent-Length: 0\r\n\r\n");
  const server = http.createServer(() => { throw new Error("Unsupported expectation dispatched"); });
  server.listen(3000);
  await vi.waitFor(() => expect(Buffer.concat(output).toString()).toContain("HTTP/1.1 417 Expectation Failed\r\n"));
  await new Promise(resolve => server.close(resolve));
  expect(http.STATUS_CODES[417]).toBe("Expectation Failed");
});

it("applies server inactivity timeouts and lets the server callback own retirement", async () => {
  for (const handled of [false, true]) {
    const { http, net } = fixture("GET / HTTP/1.1\r\nHost: local\r\n\r\n");
    const retired = Promise.withResolvers<undefined>(); let events = 0;
    const server = http.createServer(request => { request.resume(); });
    server.on("connection", (socket: unknown) => {
      if (!(socket instanceof net.Socket)) throw new Error("Socket missing");
      socket.once("close", () => server.close(() => retired.resolve(undefined)));
    });
    server.setTimeout(5, handled ? (socket: unknown) => {
      if (!(socket instanceof net.Socket)) throw new Error("Socket missing");
      expect(socket.destroyed).toBe(false); events++; socket.destroy();
    } : undefined);
    server.listen(3000); await retired.promise;
    expect(events).toBe(handled ? 1 : 0);
  }
});

it("retires an idle keep-alive socket after its configured response deadline", async () => {
  const { http, net } = fixture("GET / HTTP/1.1\r\nHost: local\r\n\r\n");
  const retired = Promise.withResolvers<undefined>();
  const server = http.createServer((request, response) => { request.resume(); response.end("ok"); });
  server.keepAliveTimeout = 5; server.keepAliveTimeoutBuffer = 0;
  server.on("connection", (socket: unknown) => {
    if (!(socket instanceof net.Socket)) throw new Error("Socket missing");
    socket.once("close", () => server.close(() => retired.resolve(undefined)));
  });
  server.listen(3000); await retired.promise;
});

it("lists the HTTP methods Node 24.18.1 parses, in its order, as an array each process owns", () => {
  const { http } = fixture("");
  // `node -p "require('node:http').METHODS"` on the pinned Node 24.18.1.
  expect(http.METHODS).toEqual(["ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL",
    "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND",
    "UNLINK", "UNLOCK", "UNSUBSCRIBE"]);
  expect(fixture("").http.METHODS).not.toBe(http.METHODS);
});
