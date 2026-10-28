import { createRequire } from "node:module";
import { Buffer } from "buffer";
import { Readable } from "readable-stream";
import { expect, it, vi } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeSockets } from "./node-socket.js";
import { createHttpClients } from "./node-http-client.js";
import { createHttpConnection } from "./node-http-connection.js";
import { createHttpResponses } from "./node-http-response.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";

const wasm: unknown = createRequire(import.meta.url)("undici/lib/llhttp/llhttp-wasm.js");
if (!(wasm instanceof Uint8Array)) throw new TypeError("Missing llhttp artifact");
const module = new WebAssembly.Module(new Uint8Array(wasm));
function fixture(handler: Parameters<typeof createHttpConnection>[3]["request"]) {
  const context = createAsyncContext(); const responses = createHttpResponses(context);
  type Endpoint = { peer: number; queue: Uint8Array<ArrayBuffer>[]; reader?: PromiseWithResolvers<AssistanceResult> };
  const endpoints = new Map<number, Endpoint>(); let connections = 0; let active = 0;
  function endpoint(fd: number): Endpoint { const value = endpoints.get(fd); if (value === undefined) throw new Error("Bad fd"); return value; }
  function push(fd: number, bytes: Uint8Array<ArrayBuffer>): void {
    const entry = endpoint(fd);
    if (entry.reader !== undefined) { const reader = entry.reader; delete entry.reader; reader.resolve({ kind: "data", bytes }); }
    else entry.queue.push(bytes);
  }
  function info(fd: number): AssistanceResult {
    return { kind: "socket", fd, local: { address: "127.0.0.1", port: fd % 2 === 0 ? 3000 : 2000 + fd }, peer: { address: "127.0.0.1", port: fd % 2 === 0 ? 2000 + fd - 1 : 3000 } };
  }
  const net = createNodeSockets({ retain: () => () => {}, callSync(operation) {
    return operation.kind === "socket-address" ? info(operation.fd) : { kind: "unit" };
  }, call(operation) {
    if (operation.kind === "socket-connect-local") {
      const client = ++connections * 2 - 1; const server = client + 1;
      endpoints.set(client, { peer: server, queue: [] }); endpoints.set(server, { peer: client, queue: [] });
      const socket = new net.Socket({ fd: server, allowHalfOpen: true });
      createHttpConnection(socket, module, context, { Response: responses.ServerResponse, request: handler, upgrade: () => false, clientError: () => false, closed() {} });
      return Promise.resolve(info(client));
    }
    if (operation.kind === "socket-read") {
      const entry = endpoint(operation.fd); const bytes = entry.queue.shift();
      if (bytes !== undefined) return Promise.resolve({ kind: "data", bytes });
      const reader = Promise.withResolvers<AssistanceResult>(); entry.reader = reader; return reader.promise;
    }
    if (operation.kind === "socket-write") { push(endpoint(operation.fd).peer, operation.bytes); return Promise.resolve({ kind: "written", count: operation.bytes.length }); }
    if (operation.kind === "socket-close" || operation.kind === "socket-shutdown") {
      push(endpoint(operation.fd).peer, new Uint8Array());
      if (operation.kind === "socket-close") push(operation.fd, new Uint8Array());
    }
    return Promise.resolve({ kind: "unit" });
  } }, context);
  return { http: createHttpClients(net, module, context, queueMicrotask, () => { active++; return () => { active--; }; }), context, connections: () => connections, active: () => active };
}
function body(message: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    message.on("data", bytes => { if (!(bytes instanceof Uint8Array)) throw new TypeError("Body bytes required"); chunks.push(bytes); });
    message.once("end", () => resolve(Buffer.concat(chunks).toString())); message.once("error", reject);
  });
}

it("runs GET and streamed POST through the HTTP owners and reuses the consumed connection", async () => {
  const seen: string[] = [];
  const f = fixture((request, response) => {
    void body(request).then(value => {
      seen.push(`${request.method} ${request.url} ${value}`);
      response.setHeader("Set-Cookie", ["one=1", "two=2"]); response.end(`reply:${value}`);
    });
  });
  const first = Promise.withResolvers<string>();
  const request = f.http.get("http://localhost:3000/one", (value: unknown) => {
    if (!(value instanceof Readable)) throw new Error("Missing response");
    void body(value).then(first.resolve, first.reject);
  });
  request.on("error", first.reject);
  expect(await first.promise).toBe("reply:");
  const second = f.http.request({ host: "localhost", port: 3000, path: "/two", method: "POST" });
  const finished = Promise.withResolvers<undefined>(); second.on("error", finished.reject); second.once("close", () => finished.resolve(undefined));
  second.write("abc"); second.end("def");
  await finished.promise;
  expect(seen).toEqual(["GET /one ", "POST /two abcdef"]);
  expect(second.reusedSocket).toBe(true); expect(f.connections()).toBe(1);
  f.http.globalAgent.destroy();
});

it("retains overlapping request contexts and returns cancelled queue capacity", async () => {
  const f = fixture((request, response) => { request.resume(); response.end(request.url); });
  const store = new f.context.AsyncLocalStorage<string>();
  const agent = new f.http.Agent({ keepAlive: true, maxSockets: 1 });
  const result = (name: string) => store.run(name, () => new Promise<string>((resolve, reject) => {
    const request = f.http.get({ host: "localhost", port: 3000, path: `/${name}`, agent }, (value: unknown) => {
      if (!(value instanceof Readable)) throw new Error("Missing response");
      expect(store.getStore()).toBe(name);
      void body(value).then(resolve, reject);
    });
    request.on("error", reject);
  }));
  expect(await Promise.all([result("one"), result("two")])).toEqual(["/one", "/two"]);
  expect(f.connections()).toBe(1); agent.destroy();

  const controller = new AbortController(); controller.abort();
  const aborted = f.http.get({ host: "localhost", port: 3000, signal: controller.signal });
  const error = await new Promise(resolve => aborted.once("error", resolve));
  expect(error).toMatchObject({ code: "ABORT_ERR" });
  expect(f.connections()).toBe(1); f.http.globalAgent.destroy();
});

it("rejects ambiguous framing and retires failed uploads", async () => {
  const f = fixture((request, response) => { request.resume(); response.end("unused"); });
  const request = f.http.request({ host: "localhost", port: 3000, method: "POST", headers: { "Content-Length": 3, "Transfer-Encoding": "chunked" } });
  const error = new Promise(resolve => request.once("error", resolve));
  request.end("bad");
  expect(await error).toMatchObject({ code: "ERR_HTTP_INVALID_HEADER_VALUE" });
  expect(request.destroyed).toBe(true);
  f.http.globalAgent.destroy();
  expect(() => f.http.request({ headers: { "x-value": "bad\r\nheader" } })).toThrow();
  expect(() => f.http.request("https://localhost/")).toThrow();
});


it("cancels a queued request without connecting it or losing the active request reference", async () => {
  let respond: (() => void) | undefined;
  const f = fixture((request, response) => { request.resume(); respond = () => { response.end("ok"); }; });
  const agent = new f.http.Agent({ keepAlive: true, maxSockets: 1 });
  const first = f.http.get({ host: "localhost", port: 3000, agent });
  const firstClosed = new Promise(resolve => first.once("close", resolve));
  const controller = new AbortController();
  const second = f.http.get({ host: "localhost", port: 3000, agent, signal: controller.signal });
  const error = new Promise(resolve => second.once("error", resolve));
  expect(f.active()).toBe(2); controller.abort();
  expect(await error).toMatchObject({ code: "ABORT_ERR" });
  expect(f.active()).toBe(1); expect(Object.values(agent.requests).flat()).toHaveLength(0);
  await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
  respond?.(); await firstClosed;
  expect(f.active()).toBe(0); expect(f.connections()).toBe(1); agent.destroy();
});
