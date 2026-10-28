import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:tls";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { createHttpClients } from "./node-http-client.js";
import { Buffer } from "node:buffer";
import { Readable } from "readable-stream";
import { expect, it } from "vitest";
import { decodeAssistanceOperation } from "../../protocol/assistance.js";
import { nativeServiceFixture } from "./native-service.test-support.js";
import { createNodeTls } from "./node-tls.js";
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
