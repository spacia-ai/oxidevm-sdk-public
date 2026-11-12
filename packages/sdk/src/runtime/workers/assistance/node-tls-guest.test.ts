import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { createHttpClients } from "./node-http-client.js";
import { Buffer } from "node:buffer";
import { Readable } from "readable-stream";
import { expect, it } from "vitest";
import { decodeAssistanceOperation } from "../../protocol/assistance.js";
import { nativeServiceFixture } from "./native-service.test-support.js";
import { createNodeTls, tlsOptions, type TlsSocket } from "./node-tls.js";
import { tlsGuestArguments } from "./node-tls-guest.js";
import { createTLSTestIdentity } from "./tls-test-identity.test-support.js";

// Fresh test-only identity per run; never used by managed guest artifacts.
const { key, cert } = await createTLSTestIdentity();
function frame(tag: number, bytes: Uint8Array): Buffer {
  const result = Buffer.alloc(5 + bytes.length); result[0] = tag;
  result.writeUInt32BE(bytes.length, 1); result.set(bytes, 5); return result;
}
function control(value: object): Buffer { return frame(1, Buffer.from(JSON.stringify(value))); }
function child(port: number, trust: boolean) {
  const args = tlsGuestArguments({ host: "127.0.0.1", port, servername: "localhost", ...(trust ? { ca: cert } : {}) });
  decodeAssistanceOperation({ kind: "spawn", command: "/usr/bin/node", args, cwd: ".", env: {} });
  return spawn(process.env["OXIDEVM_TEST_NODE"] ?? process.execPath, args);
}
async function output(process: ReturnType<typeof child>): Promise<{ events: unknown[]; data: Buffer }> {
  const events: unknown[] = []; const data: Buffer[] = [];
  async function consume(stream: typeof process.stdout, tag: number): Promise<void> {
    let buffered = Buffer.alloc(0);
    for await (const value of stream) {
      if (!(value instanceof Uint8Array)) throw new TypeError("Expected child bytes");
      buffered = Buffer.concat([buffered, value]);
      while (buffered.length >= 5) {
        const length = buffered.readUInt32BE(1); expect(length).toBeLessThanOrEqual(65536);
        if (buffered.length < length + 5) break;
        expect(buffered[0]).toBe(tag); const payload = buffered.subarray(5, length + 5);
        if (tag === 0) data.push(Buffer.from(payload)); else events.push(JSON.parse(payload.toString()));
        buffered = buffered.subarray(length + 5);
      }
    }
    expect(buffered.length).toBe(0);
  }
  await Promise.all([consume(process.stdout, 0), consume(process.stderr, 1)]);
  return { events, data: Buffer.concat(data) };
}
it("uses real TLS with verified identity, bounded plaintext and ordered finish", async () => {
  const server = createServer({ key, cert }, socket => socket.pipe(socket));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const process = child(address.port, true); const closed = once(process, "close");
  try {
    const received = output(process); const bytes = Buffer.alloc(192 * 1024, 97);
    for (let offset = 0; offset < bytes.length; offset += 16384) process.stdin.write(frame(0, bytes.subarray(offset, offset + 16384)));
    process.stdin.end(control({ kind: "end" }));
    const result = await received; expect(await closed).toEqual([0, null]);
    expect(result.data).toEqual(bytes);
    expect(result.events[0]).toMatchObject({ kind: "connect", remoteAddress: "127.0.0.1", remotePort: address.port });
    expect(result.events[1]).toMatchObject({ kind: "secure", authorized: true, servername: "localhost", remoteAddress: "127.0.0.1", remotePort: address.port });
    expect(result.events).toContainEqual({ kind: "finished" });
    expect(result.events).toContainEqual({ kind: "end" });
    expect(result.events.at(-1)).toEqual({ kind: "close", hadError: false });
    expect(result.events.filter(value => typeof value === "object" && value !== null && "kind" in value && value.kind === "written")).toHaveLength(12);
  } finally { process.kill("SIGKILL"); server.close(); await once(server, "close"); }
}, 20000);
it("rejects an untrusted certificate before exposing plaintext", async () => {
  const server = createServer({ key, cert }, socket => socket.end("private"));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const process = child(address.port, false); const closed = once(process, "close");
  try {
    const result = await output(process); expect(await closed).toEqual([0, null]);
    expect(result.data.length).toBe(0);
    expect(result.events).toEqual([expect.objectContaining({ kind: "connect" }), expect.objectContaining({ kind: "error", code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), { kind: "close", hadError: true }]);
  } finally { process.kill("SIGKILL"); server.close(); await once(server, "close"); }
}, 20000);
it("retires malformed and truncated input without an unbounded staging buffer", async () => {
  const server = createServer({ key, cert }, socket => socket.resume());
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  try {
    for (const input of [Buffer.from([0, 0, 1, 0, 1]), Buffer.from([0, 0, 0]), control({ kind: "end", ignored: true })]) {
      const process = child(address.port, true); const closed = once(process, "close");
      const received = output(process); process.stdin.end(input);
      const result = await received; expect(await closed).toEqual([0, null]);
      expect(result.events).toContainEqual(expect.objectContaining({ kind: "error", code: "ERR_TLS_BRIDGE_PROTOCOL" }));
      expect(result.events.at(-1)).toEqual({ kind: "close", hadError: true });
    }
  } finally { server.close(); await once(server, "close"); }
}, 20000);

function assistedTls() {
  const fixture = nativeServiceFixture();
  return { ...fixture, tls: createNodeTls(fixture.native, fixture.context, fixture.retain) };
}
it("adapts real guest TLS to the pinned Duplex, async context and resource lifetime", async () => {
  const server = createServer({ key, cert }, socket => socket.pipe(socket));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const f = assistedTls(); const store = new f.context.AsyncLocalStorage<string>();
  try {
    const socket = store.run("TLS", () => f.tls.connect({ host: "127.0.0.1", port: address.port, ca: cert, servername: "localhost" }));
    const bytes: Uint8Array[] = []; const events: string[] = [];
    const closed = store.run("TLS", () => new Promise<void>((resolve, reject) => {
      socket.on("error", reject); socket.on("close", () => resolve());
      socket.on("connect", () => { expect(store.getStore()).toBe("TLS"); events.push("connect"); });
      socket.on("secureConnect", () => {
        expect(store.getStore()).toBe("TLS"); events.push("secure");
        expect(socket.authorized).toBe(true); expect(socket.encrypted).toBe(true);
        expect(socket.remotePort).toBe(address.port); expect(socket.getProtocol()).toMatch(/^TLSv1\.[23]$/u);
        expect(f.references()).toBe(1); socket.unref(); expect(f.references()).toBe(0); socket.ref(); expect(f.references()).toBe(1);
      });
      socket.on("data", value => { if (!(value instanceof Uint8Array)) throw new TypeError("Expected TLS bytes"); bytes.push(value); });
    }));
    const payload = Buffer.alloc(192 * 1024, 98); socket.end(payload);
    await closed; expect(Buffer.concat(bytes)).toEqual(payload);
    expect(events).toEqual(["connect", "secure"]); expect(f.references()).toBe(0); expect(f.native.hasPending).toBe(false);
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 20000);

it("keeps TLS writes and errors live while application reads are paused", async () => {
  const payload = Buffer.alloc(512 * 1024, 99); let uploaded = 0;
  const server = createServer({ key, cert }, socket => {
    socket.write(payload);
    socket.on("data", (bytes: Buffer) => { uploaded += bytes.length; });
    socket.on("end", () => socket.end());
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const f = assistedTls();
  try {
    const socket = f.tls.connect({ host: "127.0.0.1", port: address.port, ca: cert, servername: "localhost" });
    const closed = new Promise<void>((resolve, reject) => { socket.on("error", reject); socket.on("close", () => resolve()); });
    socket.pause();
    for (let offset = 0; offset < payload.length; offset += 16384) {
      await new Promise<void>((resolve, reject) => socket.write(payload.subarray(offset, offset + 16384), error => error ? reject(error) : resolve()));
    }
    const received: Uint8Array[] = [];
    socket.on("data", value => { if (!(value instanceof Uint8Array)) throw new TypeError("Expected TLS bytes"); received.push(value); });
    socket.resume(); socket.end(); await closed;
    expect(uploaded).toBe(payload.length); expect(Buffer.concat(received)).toEqual(payload); expect(f.references()).toBe(0);
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 20000);

it("delivers certificate identity failures without plaintext or retained service lifetime", async () => {
  const server = createServer({ key, cert }, socket => socket.end("secret"));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const f = assistedTls();
  try {
    const socket = f.tls.connect({ host: "127.0.0.1", port: address.port, ca: cert, servername: "wrong.invalid" });
    const events: string[] = []; let error: unknown;
    const closed = new Promise<void>(resolve => {
      socket.on("data", () => events.push("data")); socket.on("secureConnect", () => events.push("secure"));
      socket.on("error", value => { error = value; events.push("error"); }); socket.on("close", () => resolve());
    });
    await closed; expect(events).toEqual(["error"]);
    expect(error).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" }); expect(f.references()).toBe(0); expect(f.native.hasPending).toBe(false);
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 20000);

it("trusts every certificate of a ca list, as Node adds each entry", async () => {
  const other = await createTLSTestIdentity();
  const servers = [createServer({ key, cert }, socket => socket.end("first")), createServer({ key: other.key, cert: other.cert }, socket => socket.end("second"))];
  const ports: number[] = [];
  for (const server of servers) {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
    ports.push(address.port);
  }
  const [first, second] = ports; if (first === undefined || second === undefined) throw new Error("Missing ports");
  const f = assistedTls();
  const read = (port: number, ca: unknown): Promise<string> => new Promise((resolve, reject) => {
    const socket = f.tls.connect({ host: "127.0.0.1", port, ca, servername: "localhost" });
    let text = "";
    socket.on("data", bytes => { if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected TLS bytes"); text += Buffer.from(bytes).toString(); });
    socket.on("error", reject); socket.on("close", () => resolve(text));
  });
  try {
    // Strings and Buffers alike, as with `ca: [...tls.rootCertificates, myCa]`.
    const list = [cert, Buffer.from(other.cert)];
    expect(await read(first, list)).toBe("first");
    expect(await read(second, list)).toBe("second");
    expect(await read(second, [Buffer.from(other.cert)])).toBe("second");
    await expect(read(second, [cert])).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    // Node refuses an entry that is neither a string nor bytes.
    expect(() => f.tls.connect({ host: "127.0.0.1", port: first, ca: [cert, 5], servername: "localhost" })).toThrow(TypeError);
    expect(f.references()).toBe(0); expect(f.native.hasPending).toBe(false);
  } finally { f.dispose(); for (const server of servers) { server.close(); await once(server, "close"); } }
}, 20000);

it("keeps a truthy ca without a certificate trusting no CA and a falsy ca on the default roots, as Node does", async () => {
  // Node trusts its default roots, here with NODE_EXTRA_CA_CERTS holding the test certificate, only when ca is falsy
  // (`if (ca)` in configSecureContext); an empty list, a list of empty entries and an empty Buffer are truthy and add
  // no certificate.
  const server = createServer({ key, cert }, socket => socket.end("reached"));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-tls-roots-")); const roots = join(directory, "roots.pem");
  await writeFile(roots, cert);
  const handshake = async (ca: unknown): Promise<unknown> => {
    const args = tlsGuestArguments({ host: "127.0.0.1", port: address.port, servername: "localhost", ...tlsOptions({ ca }) });
    decodeAssistanceOperation({ kind: "spawn", command: "/usr/bin/node", args, cwd: ".", env: {} });
    const helper = spawn(process.env["OXIDEVM_TEST_NODE"] ?? process.execPath, args, { env: { ...process.env, NODE_EXTRA_CA_CERTS: roots } });
    const closed = once(helper, "close");
    try {
      helper.stdin.end(control({ kind: "end" }));
      const result = await output(helper); await closed;
      return result.events.find(event => typeof event === "object" && event !== null && "kind" in event && (event.kind === "secure" || event.kind === "error"));
    } finally { helper.kill("SIGKILL"); }
  };
  try {
    for (const ca of [undefined, null, false, 0, ""]) expect(await handshake(ca)).toMatchObject({ kind: "secure", authorized: true });
    for (const ca of [[], [""], [new Uint8Array(0)], Buffer.alloc(0), ["", ""]]) {
      expect(await handshake(ca)).toMatchObject({ kind: "error", code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    }
  } finally { server.close(); await once(server, "close"); await rm(directory, { recursive: true, force: true }); }
}, 20000);

it("runs HTTPS through the shared HTTP client and partitions reuse by TLS identity", async () => {
  let connections = 0;
  const server = createHttpsServer({ key, cert }, (request, response) => {
    const body: Buffer[] = []; request.on("data", (bytes: Buffer) => body.push(bytes));
    request.on("end", () => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ path: request.url, body: Buffer.concat(body).toString() })); });
  });
  server.on("connection", () => { connections++; });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const wasm: unknown = createRequire(import.meta.url)("undici/lib/llhttp/llhttp-wasm.js");
  if (!(wasm instanceof Uint8Array)) throw new TypeError("Missing llhttp");
  const f = assistedTls();
  const https = createHttpClients({ createConnection: f.tls.connect }, new WebAssembly.Module(new Uint8Array(wasm)), f.context, queueMicrotask, () => () => {}, "https:");
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, ca: cert });
  const port = address.port;
  function request(servername: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.request(`https://127.0.0.1:${port}/tls`, { method: "POST", agent, servername }, (message: unknown) => {
        if (!(message instanceof Readable)) throw new TypeError("Missing response");
        const body: Uint8Array[] = [];
        message.on("data", (bytes: unknown) => { if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected HTTP body"); body.push(bytes); });
        message.on("end", () => resolve(Buffer.concat(body).toString())); message.on("error", reject);
      });
      req.on("error", reject); req.end("encrypted");
    });
  }
  try {
    expect(agent.protocol).toBe("https:"); expect(agent.defaultPort).toBe(443);
    expect(JSON.parse(await request("localhost"))).toEqual({ path: "/tls", body: "encrypted" });
    await new Promise(resolve => setImmediate(resolve));
    expect(JSON.parse(await request("localhost"))).toEqual({ path: "/tls", body: "encrypted" });
    expect(connections).toBe(1);
    await expect(request("wrong.invalid")).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(connections).toBe(2);
    agent.options["ca"] = "invalid CA";
    await expect(request("localhost")).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect(connections).toBe(3);
  } finally { agent.destroy(); f.dispose(); server.close(); await once(server, "close"); }
}, 20000);

it("closes normally when the TLS peer ends before the application ends its writable", async () => {
  const server = createServer({ key, cert }, socket => socket.end("bye"));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const f = assistedTls();
  try {
    const socket = f.tls.connect({ host: "127.0.0.1", port: address.port, ca: cert, servername: "localhost" });
    let body = "";
    await new Promise<void>((resolve, reject) => {
      socket.on("data", bytes => { if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected body"); body += Buffer.from(bytes).toString(); });
      socket.on("error", reject); socket.on("close", () => resolve());
    });
    expect(body).toBe("bye"); expect(socket.writableFinished).toBe(true); expect(f.references()).toBe(0);
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 20000);

const lateFailure = (subject: string): unknown => expect.objectContaining({ code: "FEATURE_NOT_AVAILABLE", detail: { lateFailure: "unavailable-builtin", subject } });

it("tls.connect ignores keys Node does not read and refuses a set lookup", async () => {
  const server = createServer({ key, cert }, socket => socket.pipe(socket));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const f = assistedTls();
  try {
    // http.request's own keys, which tls.connect never reads; tuning keys it reads; and the values Node's own test
    // treats as unset. Only host, port and the guest helper's TLS keys reach the guest.
    const socket = f.tls.connect({ host: "127.0.0.1", port: address.port, ca: cert, servername: "localhost",
      method: "GET", headers: { accept: "*/*" }, maxRedirects: 21, setHost: false, insecureHTTPParser: true, maxHeaderSize: 16384, defaultPort: 8443, agent: false,
      highWaterMark: 16384, keepAlive: true, keepAliveInitialDelay: 1000, noDelay: true, autoSelectFamily: true, maxCachedSessions: 0,
      session: null, socket: undefined, path: "", localAddress: null, family: 0, hints: 0, lookup: undefined, timeout: 0, signal: null,
      rejectUnauthorized: undefined, ALPNProtocols: null, minVersion: null, pfx: undefined, cert: undefined, checkServerIdentity: undefined,
      // TLSSocket builds its socket from a fixed set of keys (no fd or blockList), connect never reads createConnection,
      // requestCert is fixed for clients, pskIdentityHint is never passed, and passphrase only qualifies a key or pfx.
      createConnection: () => {}, fd: 3, blockList: {}, requestCert: false, pskIdentityHint: "hint", passphrase: "secret", privateKeyEngine: "engine",
      // Node tests these by truthiness: if (honorCipherOrder), if (secureOptions), if (enableTrace), if (options.session).
      honorCipherOrder: false, secureOptions: 0, enableTrace: false, secureProtocol: "", requestOCSP: false, secureContext: null,
      onread: { buffer: 1, callback: null } });
    const echoed = await new Promise<string>((resolve, reject) => {
      let text = "";
      socket.on("data", bytes => { if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected TLS bytes"); text += Buffer.from(bytes).toString(); });
      socket.on("error", reject); socket.on("close", () => resolve(text));
      socket.end("unread keys ignored");
    });
    expect(echoed).toBe("unread keys ignored"); expect(socket.authorized).toBe(true); expect(f.references()).toBe(0);
    const unset = f.tls.connect({ host: "127.0.0.1", port: address.port, ca: cert, servername: "localhost", session: "" });
    await new Promise<void>((resolve, reject) => { unset.on("secureConnect", () => { unset.destroy(); }); unset.on("error", reject); unset.on("close", () => resolve()); });
    // A lookup function decides where the host resolves, which the guest helper cannot take: refused by name, before any helper starts.
    expect(() => f.tls.connect({ host: "localhost", port: address.port, lookup: () => {} })).toThrow(lateFailure("node:tls.connect lookup"));
    expect(() => f.tls.connect(address.port, "localhost", { lookup: () => {} })).toThrow(lateFailure("node:tls.connect lookup"));
    expect(f.references()).toBe(0); expect(f.native.hasPending).toBe(false);
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 20000);

it("tls.connect refuses a set Unix socket path, wrapped socket, signal or client certificate by name", () => {
  const f = assistedTls();
  try {
    const refused: readonly (readonly [string, unknown])[] = [["path", "/run/tls.sock"], ["socket", { readable: true }], ["signal", new AbortController().signal],
      ["family", 4], ["localAddress", "127.0.0.1"], ["allowHalfOpen", true], ["onread", { buffer: new Uint8Array(1), callback: () => true }],
      ["cert", "pem"], ["session", new Uint8Array(1)], ["honorCipherOrder", true], ["secureOptions", 4], ["enableTrace", true], ["ecdhCurve", "auto"]];
    for (const [name, value] of refused) expect(() => f.tls.connect({ host: "localhost", port: 443, [name]: value })).toThrow(lateFailure(`node:tls.connect ${name}`));
    // net.normalizeArgs reads a first argument that is not a port number as a pipe path.
    expect(() => f.tls.connect("/run/tls.sock")).toThrow(lateFailure("node:tls.connect path"));
    expect(f.references()).toBe(0); expect(f.native.hasPending).toBe(false);
  } finally { f.dispose(); }
});

it("tls.connect arms a truthy timeout on its socket, as Node does, and leaves timeout 0 unset", async () => {
  const server = createServer({ key, cert }, socket => { socket.on("error", () => {}); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const f = assistedTls();
  try {
    const event = (socket: TlsSocket, name: string) => new Promise<void>((resolve, reject) => { socket.once(name, () => resolve()); socket.once("error", reject); });
    // The guest helper applies the timeout: the silent peer leaves the connection idle until it fires.
    const armed = f.tls.connect({ host: "127.0.0.1", port: address.port, ca: cert, servername: "localhost", timeout: 100 });
    expect(armed.timeout).toBe(100);
    await event(armed, "timeout");
    const armedClosed = event(armed, "close"); armed.destroy(); await armedClosed;
    const unarmed = f.tls.connect({ host: "127.0.0.1", port: address.port, ca: cert, servername: "localhost", timeout: 0 });
    expect(unarmed.timeout).toBeUndefined();
    await event(unarmed, "secureConnect");
    const unarmedClosed = event(unarmed, "close"); unarmed.destroy(); await unarmedClosed;
    expect(() => f.tls.connect({ host: "127.0.0.1", port: address.port, timeout: -1 })).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
    expect(f.references()).toBe(0);
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 20000);

it("tls.connect assigns an options object over the positional port and host, as Node does", async () => {
  // Bound to 127.0.0.2 only: a connection that used the positional host (or the default, localhost) is refused.
  const server = createServer({ key, cert }, socket => socket.end("reached"));
  server.listen(0, "127.0.0.2"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const f = assistedTls();
  try {
    const trust = { ca: cert, servername: "localhost" };
    for (const args of [[address.port, { host: "127.0.0.2", ...trust }], [address.port, "127.0.0.1", { host: "127.0.0.2", ...trust }], [1, "127.0.0.1", { host: "127.0.0.2", port: address.port, ...trust }]] as const) {
      const socket = f.tls.connect(...args);
      const reached = await new Promise<string>((resolve, reject) => {
        let text = "";
        socket.on("data", bytes => { if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected TLS bytes"); text += Buffer.from(bytes).toString(); });
        socket.on("error", reject); socket.on("close", () => resolve(text));
      });
      expect(reached).toBe("reached"); expect(socket.remoteAddress).toBe("127.0.0.2");
    }
    expect(f.references()).toBe(0);
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 20000);
