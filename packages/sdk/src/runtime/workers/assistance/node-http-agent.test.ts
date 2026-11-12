import { expect, it, vi } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeSockets, type NodeSocket } from "./node-socket.js";
import { createHttpAgents, type HttpAgent } from "./node-http-agent.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";

function sockets() {
  const context = createAsyncContext(); const controls: AssistanceOperation[] = []; let id = 0;
  const readers = new Map<number, PromiseWithResolvers<AssistanceResult>>();
  const net = createNodeSockets({ retain: () => () => {},
    callSync(operation) { controls.push(operation); return { kind: "unit" }; },
    call(operation) {
      if (operation.kind === "socket-connect-local") return Promise.resolve({ kind: "socket", fd: ++id, local: { address: "127.0.0.1", port: 1000 + id }, peer: operation.address });
      if (operation.kind === "socket-read") {
        const read = Promise.withResolvers<AssistanceResult>(); readers.set(operation.fd, read); return read.promise;
      }
      if (operation.kind === "socket-close") readers.get(operation.fd)?.resolve({ kind: "data", bytes: new Uint8Array() });
      return Promise.resolve({ kind: "unit" });
    },
  }, context);
  return { context, net, controls, count: () => id };
}
function requestThrough(agent: HttpAgent, origin: { host: string; port: number }) {
  const assigned = Promise.withResolvers<NodeSocket>();
  const request = { destroyed: false, reusedSocket: false, onSocket(socket?: NodeSocket, error?: Error) {
    if (error !== undefined) assigned.reject(error);
    else if (socket !== undefined) assigned.resolve(socket);
    else assigned.reject(new Error("Socket missing"));
  } };
  agent.addRequest(request, origin);
  return { request, assigned: assigned.promise };
}
function fixture() {
  const { context, net, controls, count } = sockets();
  const { Agent } = createHttpAgents(net, context);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  return { agent, request: (port = 3000) => requestThrough(agent, { host: "127.0.0.1", port }), controls, count };
}
/** https agents whose connections are recorded and then made as plain sockets, so no TLS helper runs. */
function secureAgents() {
  const { context, net } = sockets();
  const createConnection = vi.fn<(options: unknown) => NodeSocket>(() => net.createConnection({ host: "127.0.0.1", port: 3000 }));
  return { createConnection, https: createHttpAgents({ createConnection }, context, queueMicrotask, "https:"), http: createHttpAgents(net, context) };
}
const lateFailure = (subject: string): unknown => expect.objectContaining({ code: "FEATURE_NOT_AVAILABLE", detail: { lateFailure: "unavailable-builtin", subject } });

it("queues at maxSockets and reuses the released connection without another native connect", async () => {
  const f = fixture(); const first = f.request(); const socket = await first.assigned;
  if (socket.connecting) await new Promise(resolve => socket.once("connect", resolve));
  const second = f.request(); let assigned = false; void second.assigned.then(() => { assigned = true; });
  await Promise.resolve(); expect(assigned).toBe(false);
  socket.emit("free");
  expect(await second.assigned).toBe(socket); expect(second.request.reusedSocket).toBe(false); expect(f.count()).toBe(1);
  socket.emit("free");
  expect(f.controls).toContainEqual({ kind: "socket-keepalive", fd: 1, enabled: true, delaySeconds: 1 });
  expect(f.agent.freeSockets[f.agent.getName({ host: "127.0.0.1", port: 3000 })]).toEqual([socket]);
  const third = f.request();
  expect(await third.assigned).toBe(socket); expect(third.request.reusedSocket).toBe(true);
  f.agent.destroy();
});

it("separates origins and transfers capacity after close while retiring cancelled requests", async () => {
  const f = fixture(); f.agent.maxTotalSockets = 1;
  const first = await f.request().assigned;
  const second = f.request(3001);
  first.destroy(); const replacement = await second.assigned;
  expect(replacement).not.toBe(first); expect(f.count()).toBe(2);
  const cancelled = f.request(3001); cancelled.request.destroyed = true;
  const failure = cancelled.assigned.catch((error: unknown) => error);
  replacement.emit("free");
  expect(await failure).toMatchObject({ code: "ECONNRESET" });
  f.agent.destroy();
});

it("https.Agent accepts maxCachedSessions as Node does", async () => {
  const { https, createConnection } = secureAgents();
  // Tuning keys, keys Node never reads on this API, and values Node's own test treats as unset are ignored.
  const agent = new https.Agent({ keepAlive: true, maxCachedSessions: 0, agentKeepAliveTimeoutBuffer: 500, freeSocketTimeout: 4000, highWaterMark: 16384,
    ca: null, servername: undefined, lookup: undefined, family: 0, localAddress: null, socketPath: "", defaultPort: 443, protocol: "https:", proxyEnv: {},
    // Agent.createSocket calls its own createConnection method; TLSSocket builds its socket without fd or blockList.
    createConnection: () => {}, fd: 3, blockList: {}, host: undefined, port: undefined, signal: null,
    // tls.connect hard-codes requestCert and never passes pskIdentityHint; passphrase and privateKeyEngine only
    // qualify a key, pfx or privateKeyIdentifier; and these values are falsy where Node tests truthiness.
    requestCert: true, pskIdentityHint: "hint", passphrase: "secret", privateKeyEngine: "engine",
    honorCipherOrder: false, secureOptions: 0, enableTrace: false, session: "", secureProtocol: "", requestOCSP: false });
  expect(agent.options["maxCachedSessions"]).toBe(0);
  const { assigned } = requestThrough(agent, { host: "api.example.test", port: 443 });
  await assigned;
  expect(createConnection).toHaveBeenCalledTimes(1);
  expect(createConnection).toHaveBeenCalledWith({ host: "api.example.test", port: 443, servername: "api.example.test" });
  agent.destroy();
});

it("refuses a set connection key on http.Agent and https.Agent by name, and plain http ignores TLS keys", () => {
  const { https, http, createConnection } = secureAgents();
  // An agent's own options override every request's (Agent.addRequest), so a host, port or signal there redirects or
  // aborts all of its connections.
  const refused: readonly (readonly [string, unknown])[] = [["lookup", () => {}], ["family", 6], ["localAddress", "10.0.0.2"],
    ["socketPath", "/var/run/docker.sock"], ["defaultPort", 8080], ["host", "other.example.test"], ["port", 8080], ["signal", new AbortController().signal]];
  for (const [key, value] of refused) {
    expect(() => new http.Agent({ [key]: value })).toThrow(lateFailure(`node:http.Agent ${key}`));
    expect(() => new https.Agent({ [key]: value })).toThrow(lateFailure(`node:https.Agent ${key}`));
  }
  // The guest TLS helper takes no client certificate: set on https, refused; plain http never reads it.
  expect(() => new https.Agent({ cert: "pem" })).toThrow(lateFailure("node:https.Agent cert"));
  new http.Agent({ cert: "pem", key: "pem", ca: "pem", rejectUnauthorized: false, maxCachedSessions: 0, socket: {} }).destroy();
  expect(createConnection).not.toHaveBeenCalled();
});

it("refuses the keys only one protocol's agent reads, and the proxy variable of its own protocol", () => {
  const { https, http } = secureAgents();
  const httpProxy = { HTTP_PROXY: "http://proxy.example.test:3128" }, httpsProxy = { https_proxy: "http://proxy.example.test:3128" };
  // net.Socket opens fd and applies blockList; a plain agent's connections are net sockets, an https agent's are not.
  for (const [key, value] of [["fd", 3], ["blockList", {}], ["protocol", "https:"], ["proxyEnv", httpProxy]] as const) {
    expect(() => new http.Agent({ [key]: value })).toThrow(lateFailure(`node:http.Agent ${key}`));
  }
  // tls.connect wraps an existing socket when one is given.
  for (const [key, value] of [["socket", {}], ["protocol", "http:"], ["proxyEnv", httpsProxy]] as const) {
    expect(() => new https.Agent({ [key]: value })).toThrow(lateFailure(`node:https.Agent ${key}`));
  }
  // Node reads only the proxy variable of the agent's own protocol (lower case first).
  new http.Agent({ proxyEnv: httpsProxy }).destroy(); new https.Agent({ proxyEnv: httpProxy }).destroy();
  new http.Agent({ fd: undefined, protocol: "http:" }).destroy(); new https.Agent({ fd: 3, blockList: {} }).destroy();
});
