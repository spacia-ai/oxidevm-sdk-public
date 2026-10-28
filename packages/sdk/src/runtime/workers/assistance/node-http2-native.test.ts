import { createServer, createSecureServer, connect } from "node:http2";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { nativeServiceFixture } from "./native-service.test-support.js";
import { record } from "../../decode.js";
import { createNodeHttp2 } from "./node-http2.js";
import { Http2Stream } from "./node-http2-stream.js";
import { Http2ServerRequest, Http2ServerResponse } from "./node-http2-compat.js";
import { streamError, type EventEmitter, type Readable } from "./node-streams.js";
import { http2GuestArguments } from "./node-http2-guest.js";
import { encodeNativeFrame, readNativeFrame } from "./native-frames.js";
import { decodeHttp2Event } from "./node-http2-wire.js";
import { createTLSTestIdentity } from "./tls-test-identity.test-support.js";

// Fresh test-only identity per run; never used by managed guest artifacts.
const { key, cert } = await createTLSTestIdentity();
function assistedEvent(emitter: EventEmitter, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const error = (value: unknown) => { emitter.removeListener(name, ready); reject(value instanceof Error ? value : new Error(String(value))); };
    const ready = () => { emitter.removeListener("error", error); resolve(); };
    emitter.once(name, ready); emitter.once("error", error);
  });
}
async function text(stream: Readable): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const value of stream) { if (!(value instanceof Uint8Array)) throw new TypeError("Expected HTTP/2 bytes"); chunks.push(value); }
  return Buffer.concat(chunks).toString();
}

it("multiplexes independent streams against a real Node HTTP/2 server", async () => {
  const server = createServer();
  server.on("stream", (stream, headers) => { stream.respond({ ":status": 200, "x-bridge": "http2" }); stream.end(String(headers[":path"])); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing server port");
  const f = nativeServiceFixture(), http2 = createNodeHttp2(f.native, f.context, f.retain);
  try {
    const session = http2.connect(`http://127.0.0.1:${String(address.port)}`);
    await assistedEvent(session, "connect");
    const first = session.request({ ":path": "/one" }), second = session.request({ ":path": "/two" });
    first.end(); second.end();
    expect(await Promise.all([text(first), text(second)])).toEqual(["/one", "/two"]);
    const closed = assistedEvent(session, "close"); session.close(); await closed;
    expect(f.references()).toBe(0);
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 20000);

it("verifies TLS identity and negotiates h2 with the original Node runtime", async () => {
  const server = createSecureServer({ key, cert });
  server.on("stream", stream => { stream.respond({ ":status": 200 }); stream.end("secure-http2"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing server port");
  const f = nativeServiceFixture(), http2 = createNodeHttp2(f.native, f.context, f.retain);
  try {
    const session = http2.connect(`https://localhost:${String(address.port)}`, { ca: cert, host: "127.0.0.1" });
    await assistedEvent(session, "connect"); expect(session.alpnProtocol).toBe("h2");
    const request = session.request({ ":path": "/" }); request.end(); expect(await text(request)).toBe("secure-http2");
    const closed = assistedEvent(session, "close"); session.close(); await closed;
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 20000);

it("serves real Node clients through cleartext and TLS server streams", async () => {
  for (const secure of [false, true]) {
    const f = nativeServiceFixture(), http2 = createNodeHttp2(f.native, f.context, f.retain);
    const server = secure ? http2.createSecureServer({ key, cert }) : http2.createServer();
    server.on("stream", (stream: unknown, headers: unknown) => {
      if (!(stream instanceof Http2Stream)) throw new TypeError("Expected an HTTP/2 stream");
      stream.respond({ ":status": 201 }); stream.end(JSON.stringify(headers));
    });
    try {
      server.listen(0, "127.0.0.1"); await assistedEvent(server, "listening");
      const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing server port");
      const client = connect(`${secure ? "https" : "http"}://127.0.0.1:${String(address.port)}`, secure ? { ca: cert, servername: "localhost" } : {});
      try {
        const request = client.request({ ":path": "/from-node" }); request.end();
        const chunks: Buffer[] = []; for await (const value of request) { if (!(value instanceof Uint8Array)) throw new TypeError("Expected bytes"); chunks.push(Buffer.from(value)); }
        expect(Buffer.concat(chunks).toString()).toContain("/from-node");
      } finally { const closed = once(client, "close"); client.close(); await closed; }
      const closed = assistedEvent(server, "close"); server.close(); await closed;
      expect(f.references()).toBe(0);
    } finally { f.dispose(); }
  }
}, 30000);

it("keeps a paused stream independent and preserves large request bodies", async () => {
  const payload = Buffer.alloc(512 * 1024, 97);
  const server = createServer();
  server.on("stream", (stream, headers) => {
    stream.respond({ ":status": 200 });
    if (headers[":path"] === "/echo") stream.pipe(stream);
    else stream.end(headers[":path"] === "/paused" ? payload : "fast");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const f = nativeServiceFixture(), http2 = createNodeHttp2(f.native, f.context, f.retain);
  try {
    const session = http2.connect(`http://127.0.0.1:${String(address.port)}`); await assistedEvent(session, "connect");
    const paused = session.request({ ":path": "/paused" }); paused.pause(); paused.end();
    const fast = session.request({ ":path": "/fast" }); fast.end();
    expect(await text(fast)).toBe("fast"); expect(paused.readableLength).toBe(0);
    expect(await text(paused)).toBe(payload.toString());
    const echo = session.request({ ":method": "POST", ":path": "/echo" }); echo.end(payload);
    expect(await text(echo)).toBe(payload.toString());
    const closed = assistedEvent(session, "close"); session.close(); await closed;
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 20000);

it("acknowledges settings and pings, then cancels one stream without closing its session", async () => {
  const server = createServer();
  server.on("stream", (stream, headers) => { stream.on("error", () => {}); stream.respond({ ":status": 200 }); if (headers[":path"] === "/held") stream.write("pending"); else stream.end("reused"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const f = nativeServiceFixture(), http2 = createNodeHttp2(f.native, f.context, f.retain);
  try {
    const session = http2.connect(`http://127.0.0.1:${String(address.port)}`); await assistedEvent(session, "connect");
    await new Promise<void>((resolve, reject) => session.settings({ maxConcurrentStreams: 9 }, (error: unknown) => { if (error !== null) reject(streamError(error)); else resolve(); }));
    expect(session.localSettings.maxConcurrentStreams).toBe(9);
    const ping = Buffer.from("12345678");
    await new Promise<void>((resolve, reject) => session.ping(ping, (error: unknown, duration: unknown, value: unknown) => {
      if (error !== null) { reject(streamError(error)); return; } expect(duration).toBeTypeOf("number"); expect(value).toEqual(ping); resolve();
    }));
    const held = session.request({ ":path": "/held" }); held.end();
    const retired = assistedEvent(held, "close");
    held.once("data", () => held.close(8)); await retired;
    const reused = session.request({ ":path": "/after-cancel" }); reused.end(); expect(await text(reused)).toBe("reused");
    const closed = assistedEvent(session, "close"); session.close(); await closed;
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 20000);

it("serves the Node request/response compatibility API", async () => {
  const f = nativeServiceFixture(), http2 = createNodeHttp2(f.native, f.context, f.retain);
  const server = http2.createServer((request: unknown, response: unknown) => {
    if (!(request instanceof Http2ServerRequest) || !(response instanceof Http2ServerResponse)) throw new TypeError("Expected HTTP/2 request/response");
    response.setHeader("x-method", request.method); response.writeHead(202); request.pipe(response);
  });
  try {
    server.listen(0, "127.0.0.1"); await assistedEvent(server, "listening");
    const address = server.address(); if (address === null) throw new Error("Missing port");
    const client = connect(`http://127.0.0.1:${String(address.port)}`);
    try {
      const request = client.request({ ":method": "POST", ":path": "/compat" });
      const response = once(request, "response"); request.end("compat-body");
      const headers: unknown = (await response)[0]; expect(headers).toMatchObject({ ":status": 202, "x-method": "POST" });
      const body: Uint8Array[] = []; for await (const chunk of request) { if (!(chunk instanceof Uint8Array)) throw new TypeError("Expected bytes"); body.push(chunk); }
      expect(Buffer.concat(body).toString()).toBe("compat-body");
    } finally { const closed = once(client, "close"); client.close(); await closed; }
    const closed = assistedEvent(server, "close"); server.close(); await closed;
  } finally { f.dispose(); }
}, 20000);

it("rejects untrusted TLS peers and retires a crashed helper", async () => {
  const server = createSecureServer({ key, cert });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const f = nativeServiceFixture(), http2 = createNodeHttp2(f.native, f.context, f.retain);
  try {
    const session = http2.connect(`https://127.0.0.1:${String(address.port)}`);
    const errors: unknown[] = []; session.on("error", (error: unknown) => errors.push(error));
    await new Promise<void>(resolve => session.once("close", () => resolve()));
    expect(errors).toContainEqual(expect.objectContaining({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" })); expect(f.references()).toBe(0);
    const live = http2.connect(`https://127.0.0.1:${String(address.port)}`, { ca: cert, servername: "localhost" });
    await assistedEvent(live, "connect");
    const failures: unknown[] = []; live.on("error", (error: unknown) => failures.push(error));
    const closed = new Promise<void>(resolve => live.once("close", () => resolve())); f.dispose(); await closed;
    expect(failures).toHaveLength(1);
    const failure = record(failures[0], "HTTP/2 helper failure"); expect(failure["code"]).toMatch(/^ERR_HTTP2_BRIDGE_(?:EXIT|EOF)$/u); expect(f.references()).toBe(0);
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 20000);

it("rejects wrong helper versions and truncated frames before network effects", async () => {
  const f = nativeServiceFixture();
  try {
    for (const bytes of [encodeNativeFrame(0, Buffer.from(JSON.stringify({ version: 2, role: "client", options: {}, authority: "http://127.0.0.1:1" }))), Buffer.from([0, 0, 0]), encodeNativeFrame(0, Buffer.from([0xff]))]) {
      const child = f.native.spawnService("/usr/bin/node", http2GuestArguments());
      child.stdin.end(bytes);
      const frame = await readNativeFrame(child.stderr); if (frame === null) throw new Error("Missing protocol failure");
      expect(frame.tag).toBe(1); expect(decodeHttp2Event(frame.bytes)).toMatchObject({ kind: "fatal", code: "ERR_HTTP2_BRIDGE_PROTOCOL" });
      await assistedEvent(child, "close");
    }
  } finally { f.dispose(); }
}, 20000);
