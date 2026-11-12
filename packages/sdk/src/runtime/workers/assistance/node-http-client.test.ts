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
  const retain = () => { active++; return () => { active--; }; };
  return { http: createHttpClients(net, module, context, queueMicrotask, retain), net, context, retain, connections: () => connections, active: () => active };
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

function secure(f: ReturnType<typeof fixture>) {
  const createConnection = vi.fn<(options: unknown) => ReturnType<typeof f.net.createConnection>>(() => f.net.createConnection({ host: "localhost", port: 3000 }));
  return { createConnection, https: createHttpClients({ createConnection }, module, f.context, queueMicrotask, f.retain, "https:") };
}
const viteOptions = { port: 0, host: "api.open-meteo.com", hostname: "api.open-meteo.com", socketPath: undefined, pfx: undefined,
  key: undefined, passphrase: undefined, cert: undefined, ca: undefined, ciphers: undefined, secureProtocol: undefined,
  localAddress: undefined, rejectUnauthorized: true, agent: false, method: "GET",
  headers: { host: "api.open-meteo.com", accept: "*/*" }, path: "/v1/forecast?latitude=35.68&longitude=139.69" };

it("accepts the https options Vite 7.2.4's http-proxy-3 builds", async () => {
  // The object http-proxy-3 1.22.0 setupOutgoing passes for target https://api.open-meteo.com, changeOrigin: true
  const seen: string[] = [];
  const f = fixture((request, response) => { request.resume(); seen.push(`${request.method} ${request.url}`); response.end("ok"); });
  const { https, createConnection } = secure(f);
  const request = https.request(viteOptions);
  const closed = new Promise(resolve => request.once("close", resolve));
  request.end(); await closed;
  expect(createConnection).toHaveBeenCalledTimes(1);
  expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({ host: "api.open-meteo.com", port: 443, servername: "api.open-meteo.com", rejectUnauthorized: true }));
  expect(seen).toEqual(["GET /v1/forecast?latitude=35.68&longitude=139.69"]);
});

it("refuses a set socketPath or localAddress with FEATURE_NOT_AVAILABLE before connecting", () => {
  const f = fixture(() => {});
  const { https, createConnection } = secure(f);
  for (const key of ["socketPath", "localAddress"]) {
    let error: unknown; try { https.request({ ...viteOptions, [key]: "/tmp/x.sock" }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { lateFailure: "unavailable-builtin", subject: `node:https.request ${key}` } });
  }
  expect(() => f.http.request({ host: "localhost", family: 6 })).toThrow(expect.objectContaining({ detail: { lateFailure: "unavailable-builtin", subject: "node:http.request family" } }));
  expect(createConnection).not.toHaveBeenCalled();
  expect(f.connections()).toBe(0);
  const ignored = https.request({ ...viteOptions, family: 0, hints: 0, setHost: true, insecureHTTPParser: false, maxHeaderSize: undefined, defaultPort: 443 });
  ignored.destroy(); ignored.on("error", () => {});
  expect(() => https.request({ ...viteOptions, ciphers: "HIGH" })).toThrow(expect.objectContaining({ detail: { lateFailure: "unavailable-builtin", subject: "node:https.request ciphers" } }));
});

it("uses the default port for 0, empty string and null, as Node does", () => {
  const f = fixture(() => {});
  const { https, createConnection } = secure(f);
  for (const port of [0, "", null, undefined]) { const request = https.request({ host: "localhost", port }); request.on("error", () => {}); request.destroy(); }
  expect(createConnection).toHaveBeenCalledTimes(4);
  for (const [options] of createConnection.mock.calls) expect(options).toMatchObject({ port: 443 });
  expect(() => f.http.request({ host: "localhost", port: 70000 })).toThrow(TypeError);
});

it("accepts the node-fetch 2 and node-fetch 3 option shapes", () => {
  const f = fixture(() => {});
  for (const extra of [{ slashes: true, auth: null, search: "", hash: null }, { insecureHTTPParser: false, signal: null, agent: null }]) {
    const request = f.http.request({ protocol: "http:", hostname: "localhost", port: "3000", path: "/", method: "GET", ...extra });
    request.on("error", () => {}); request.destroy();
  }
});

it("plain http ignores TLS options", () => {
  const f = fixture(() => {});
  const request = f.http.request({ host: "localhost", port: 3000, ca: "pem", key: "k", rejectUnauthorized: false });
  request.on("error", () => {}); request.destroy();
});

it("keys Node never reads are ignored", () => {
  const f = fixture(() => {});
  const request = f.http.request({ host: "localhost", port: 3000, maxRedirects: 21, agents: {} });
  request.on("error", () => {}); request.destroy();
});

it("refuses secureContext and a non-default defaultPort, and accepts the protocol's own", () => {
  const f = fixture(() => {});
  const { https, createConnection } = secure(f);
  expect(() => https.request({ ...viteOptions, secureContext: {} })).toThrow(expect.objectContaining({ detail: { lateFailure: "unavailable-builtin", subject: "node:https.request secureContext" } }));
  expect(() => https.request({ ...viteOptions, defaultPort: "8080" })).toThrow(expect.objectContaining({ detail: { lateFailure: "unavailable-builtin", subject: "node:https.request defaultPort" } }));
  expect(() => f.http.request({ host: "localhost", defaultPort: "8080" })).toThrow(expect.objectContaining({ detail: { lateFailure: "unavailable-builtin", subject: "node:http.request defaultPort" } }));
  expect(createConnection).not.toHaveBeenCalled();
  for (const [client, port] of [[https, "443"], [https, 443], [f.http, "80"]] as const) {
    const request = client.request({ host: "localhost", port: 3000, defaultPort: port }); request.on("error", () => {}); request.destroy();
  }
});

it("plain http refuses a set fd or blockList, which only its net sockets read, and https ignores both", () => {
  const f = fixture(() => {});
  const { https, createConnection } = secure(f);
  // net.Socket opens options.fd when it is not undefined and applies a truthy blockList; tls.connect never passes either.
  for (const [key, value] of [["fd", 0], ["blockList", {}]] as const) {
    expect(() => f.http.request({ host: "localhost", port: 3000, [key]: value })).toThrow(expect.objectContaining({ detail: { lateFailure: "unavailable-builtin", subject: `node:http.request ${key}` } }));
  }
  expect(f.connections()).toBe(0);
  const unset = f.http.request({ host: "localhost", port: 3000, fd: undefined, blockList: null, createConnection: undefined }); unset.on("error", () => {}); unset.destroy();
  const ignored = https.request({ host: "localhost", port: 3000, fd: 3, blockList: {} }); ignored.on("error", () => {}); ignored.destroy();
  expect(createConnection).toHaveBeenCalledTimes(1);
  // http.request reads createConnection itself (with no agent), so it stays refused there.
  expect(() => https.request({ host: "localhost", createConnection: () => {} })).toThrow(expect.objectContaining({ detail: { lateFailure: "unavailable-builtin", subject: "node:https.request createConnection" } }));
});

function refusal(subject: string): unknown {
  return expect.objectContaining({ code: "FEATURE_NOT_AVAILABLE", detail: { lateFailure: "unavailable-builtin", subject } });
}

it("refuses a defined falsy setHost and a false setDefaultHeaders, which leave out the Host header in Node", () => {
  const f = fixture(() => {});
  const { https, createConnection } = secure(f);
  // ClientRequest sends Host only when `setHost !== undefined ? Boolean(setHost) : setDefaultHeaders !== false`.
  for (const setHost of [false, null, 0, "", Number.NaN]) {
    expect(() => https.request({ ...viteOptions, setHost })).toThrow(refusal("node:https.request setHost"));
    expect(() => f.http.request({ host: "localhost", port: 3000, setHost })).toThrow(refusal("node:http.request setHost"));
  }
  expect(() => f.http.request({ host: "localhost", port: 3000, setDefaultHeaders: false })).toThrow(refusal("node:http.request setDefaultHeaders"));
  expect(() => f.http.request({ host: "localhost", port: 3000, setHost: true, setDefaultHeaders: false })).toThrow(refusal("node:http.request setDefaultHeaders"));
  expect(createConnection).not.toHaveBeenCalled();
  expect(f.connections()).toBe(0);
  for (const extra of [{ setHost: undefined }, { setHost: true }, { setHost: 1 }, { setHost: "yes" }, { setDefaultHeaders: true }, { setDefaultHeaders: null }, { setDefaultHeaders: undefined }]) {
    const request = f.http.request({ host: "localhost", port: 3000, ...extra }); request.on("error", () => {}); request.destroy();
  }
});

it("sends Host when setHost is truthy or unset, as Node does", async () => {
  const hosts: (string | string[] | undefined)[] = [];
  const f = fixture((request, response) => { request.resume(); hosts.push(request.headers["host"]); response.end("ok"); });
  for (const setHost of [undefined, true, "yes"]) {
    const request = f.http.request({ host: "localhost", port: 3000, setHost });
    const closed = new Promise(resolve => request.once("close", resolve));
    request.end(); await closed;
  }
  expect(hosts).toEqual(["localhost:3000", "localhost:3000", "localhost:3000"]);
  f.http.globalAgent.destroy();
});

it("refuses uniqueHeaders and joinDuplicateHeaders when Node would apply them", () => {
  const f = fixture(() => {});
  const { https, createConnection } = secure(f);
  // parseUniqueHeadersOption reads only an array, and joins the listed headers' values with "; ".
  expect(() => f.http.request({ host: "localhost", port: 3000, uniqueHeaders: ["x-unique"] })).toThrow(refusal("node:http.request uniqueHeaders"));
  expect(() => https.request({ ...viteOptions, uniqueHeaders: ["X-Unique"] })).toThrow(refusal("node:https.request uniqueHeaders"));
  // The response parser joins the duplicates of single-value fields with ", " when joinDuplicateHeaders is true.
  expect(() => f.http.request({ host: "localhost", port: 3000, joinDuplicateHeaders: true })).toThrow(refusal("node:http.request joinDuplicateHeaders"));
  expect(() => https.request({ ...viteOptions, joinDuplicateHeaders: true })).toThrow(refusal("node:https.request joinDuplicateHeaders"));
  expect(createConnection).not.toHaveBeenCalled();
  expect(f.connections()).toBe(0);
  // An empty list and a value that is not an array change nothing in Node.
  for (const extra of [{ uniqueHeaders: [] }, { uniqueHeaders: null }, { uniqueHeaders: "x-unique" }, { uniqueHeaders: undefined }, { joinDuplicateHeaders: false }, { joinDuplicateHeaders: undefined }]) {
    const request = f.http.request({ host: "localhost", port: 3000, ...extra }); request.on("error", () => {}); request.destroy();
  }
});

it("treats falsy headers as unset and refuses an array of raw headers, as Node reads them", async () => {
  const seen: { host: string | string[] | undefined; accept: string | string[] | undefined }[] = [];
  const f = fixture((request, response) => { request.resume(); seen.push({ host: request.headers["host"], accept: request.headers["accept"] }); response.end("ok"); });
  // ClientRequest sets the headers of `if (options.headers)` only.
  for (const headers of [null, undefined, 0, "", false]) {
    const request = f.http.request({ host: "localhost", port: 3000, headers });
    const closed = new Promise(resolve => request.once("close", resolve));
    request.end(); await closed;
  }
  expect(seen).toEqual(Array.from({ length: 5 }, () => ({ host: "localhost:3000", accept: undefined })));
  // An array is Node's raw header list, written as given and without a Host header of its own.
  const connections = f.connections();
  expect(() => f.http.request({ host: "localhost", port: 3000, headers: ["Accept", "*/*"] })).toThrow(refusal("node:http.request headers"));
  expect(f.connections()).toBe(connections);
  f.http.globalAgent.destroy();
});
