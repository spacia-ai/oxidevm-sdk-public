import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { createServer, type Server } from "node:https";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineModulePath } from "../../runtime/workers/engine-wasm.test-support.js";
import { nodeSockets } from "./node-sockets.test-support.js";
import { ConnectionPool } from "./pool.js";
import { createFetch } from "./fetch.js";
import { engineTls, dial } from "./streams.js";
import { decodeTrust } from "./tls-trust.js";
import type { NetTlsSession } from "../capabilities.js";
import { createTestPki, type Identity, type TestPki } from "./tls-pki.test-support.js";
import type { NetSyncSockets } from "./ports.js";

// The engine's TLS module (oxidevm_tls.wasm, TLS API 2) against real TLS servers on loopback (engine ADR 0029, N-7):
// it verifies every server against the trust store the VM's /etc/ssl/cert.pem holds, and fetch reports a certificate
// failure as TypeError("fetch failed") with the typed failure as its cause.
let pki: TestPki, module: WebAssembly.Module;
const servers: Server[] = [];
const ports: Record<string, number> = {};

function serve(name: string, identity: Identity): Promise<void> {
  const server = createServer({ key: identity.key, cert: identity.cert, ALPNProtocols: ["http/1.1"] }, (request, response) => {
    if (request.url === "/gzip") { response.writeHead(200, { "content-encoding": "gzip" }); response.end(gzipSync("compressed over TLS")); return; }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`hello ${request.headers.host ?? ""}`);
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) { reject(new Error("no address")); return; }
      ports[name] = address.port; resolve();
    });
  });
}

beforeAll(async () => {
  [pki, module] = await Promise.all([createTestPki(), readFile(engineModulePath("oxidevm_tls.wasm")).then(bytes => WebAssembly.compile(bytes))]);
  await Promise.all([serve("server", pki.server), serve("mismatch", pki.mismatch), serve("expired", pki.expired), serve("unknown", pki.unknown)]);
}, 60_000);
afterAll(async () => { await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }))); });

const unused = (): never => { throw new Error("unused"); };
const unusedSync: NetSyncSockets = { stream: unused, connect: unused, read: unused, readNow: unused, write: unused, shutdown: unused, close: unused, datagram: unused, sendTo: unused, receiveNow: unused, sleep: unused, readFile: unused };
function setup(files: Readonly<Record<string, string>> = { "/etc/ssl/cert.pem": pki.root }) {
  const sockets = nodeSockets({ "/etc/hosts": "127.0.0.1 tls.test other.test\n", ...files });
  // A sans-IO session reads the trust store synchronously; the async path reads it through `sockets`.
  const sync: NetSyncSockets = { ...unusedSync, readFile: path => { const text = files[path]; return text === undefined ? null : new TextEncoder().encode(text); } };
  const tls = engineTls(module, sockets, sync);
  return { sockets, tls, fetch: createFetch({ sockets, reach: "vm", tls, pool: new ConnectionPool(), signal: new AbortController().signal }) };
}
const url = (name: string, path = "/") => `https://tls.test:${String(ports[name])}${path}`;

describe("TLS through the engine's TLS module", () => {
  it("fetches over TLS 1.3 with ALPN, verified against the VM's trust store, and decodes gzip", async () => {
    const { fetch, sockets, tls } = setup();
    const response = await fetch(url("server"));
    expect([response.status, await response.text()]).toEqual([200, `hello tls.test:${String(ports["server"])}`]);
    expect(await (await fetch(url("server", "/gzip"))).text()).toBe("compressed over TLS");
    const stream = await dial(sockets, "vm", tls, { host: "tls.test", port: ports["server"] ?? 0, tls: true, alpn: ["h2", "http/1.1"] });
    expect(stream.alpn).toBe("http/1.1");
    await stream.close();
  });

  it.each([
    ["unknown", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unknown-issuer"],
    ["mismatch", "ERR_TLS_CERT_ALTNAME_INVALID", "name-mismatch"],
    ["expired", "CERT_HAS_EXPIRED", "certificate-expired"],
  ] as const)("refuses a server whose certificate is %s with a typed cause", async (name, code, tlsFailure) => {
    const { fetch } = setup();
    await expect(fetch(url(name))).rejects.toMatchObject({ name: "TypeError", message: "fetch failed", cause: { code, tlsFailure } });
  });

  it("has no trust of its own: without /etc/ssl/cert.pem nothing verifies", async () => {
    const { fetch } = setup({});
    await expect(fetch(url("server"))).rejects.toMatchObject({ cause: { code: "ERR_TLS_NO_TRUST_STORE" } });
  });

  /** Runs a sans-IO session's handshake over a loopback TCP connection to the server `name`. */
  async function handshake(session: NetTlsSession, name: string): Promise<void> {
    const socket = connect(ports[name] ?? 0, "127.0.0.1"), chunks: Buffer[] = [];
    const peer = { ended: false };
    let wake: (() => void) | undefined;
    socket.on("data", (chunk: Buffer) => { chunks.push(chunk); wake?.(); });
    socket.on("close", () => { peer.ended = true; wake?.(); });
    socket.on("error", () => { peer.ended = true; wake?.(); });
    try {
      for (;;) {
        const out = session.takeTls();
        if (out.length > 0) socket.write(out);
        if (session.state() !== "handshaking") return;
        while (chunks.length === 0 && !peer.ended) await new Promise<void>(resolve => { wake = resolve; });
        const chunk = chunks.shift();
        if (chunk === undefined) return;
        session.receive(new Uint8Array(chunk));
      }
    } finally { socket.destroy(); }
  }

  it("reports the verified chain, protocol version and cipher suite of a sans-IO session", async () => {
    const session = setup().tls.session("tls.test", ["http/1.1"], []);
    expect([session.peerCertificates(), session.protocolVersion(), session.cipherSuite()]).toEqual([[], null, null]);
    await handshake(session, "server");
    expect(session.state()).toBe("established");
    const chain = session.peerCertificates();
    expect(chain.map(der => Buffer.from(der).equals(new X509Certificate(pki.server.cert).raw))).toEqual([true]);
    expect(session.protocolVersion()).toBe("TLSv1.3");
    expect([0x1301, 0x1302, 0x1303]).toContain(session.cipherSuite());
    expect(session.alpn()).toBe("http/1.1");
    session.free();
  });

  it.each(["PEM", "DER"] as const)("verifies a private CA's server with an extra %s anchor, for that session only", async form => {
    const { tls } = setup(), anchor = form === "PEM" ? new TextEncoder().encode(pki.strangerRoot) : new Uint8Array(new X509Certificate(pki.strangerRoot).raw);
    const trusted = tls.session("tls.test", [], decodeTrust([anchor]));
    await handshake(trusted, "unknown");
    expect(trusted.state()).toBe("established");
    expect(Buffer.from(trusted.peerCertificates()[0] ?? []).equals(new X509Certificate(pki.unknown.cert).raw)).toBe(true);
    const untrusted = tls.session("tls.test", [], []);
    await expect(handshake(untrusted, "unknown")).rejects.toMatchObject({ code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", tlsFailure: "unknown-issuer" });
    // The VM's own store still applies beside an extra anchor.
    const both = tls.session("tls.test", [], decodeTrust([anchor]));
    await handshake(both, "server");
    expect(both.state()).toBe("established");
  });

  it("takes a 150-certificate root bundle larger than the exchange buffer, as certifi's, in one trust entry", async () => {
    const { tls } = setup(), comment = `# Issuer: CN=Example Root\n${"# ".padEnd(1800, "-")}\n`;
    const bundle = new TextEncoder().encode(Array.from({ length: 150 }, () => `${comment}${pki.strangerRoot}\n`).join(""));
    expect(bundle.length).toBeGreaterThan(256 * 1024);
    const session = tls.session("tls.test", [], decodeTrust([bundle]));
    await handshake(session, "unknown");
    expect(session.state()).toBe("established");
  });

  it("refuses an extra anchor that is not a CA certificate, and the next session is unaffected", async () => {
    const { tls } = setup(), key = new TextEncoder().encode(pki.server.key);
    let refusal: unknown;
    try { tls.session("tls.test", [], decodeTrust([new TextEncoder().encode(pki.strangerRoot), key])); } catch (error: unknown) { refusal = error; }
    expect(refusal).toMatchObject({ code: "ERR_TLS_INVALID_TRUST" });
    const next = tls.session("tls.test", [], []);
    await expect(handshake(next, "unknown")).rejects.toMatchObject({ tlsFailure: "unknown-issuer" });
  });
});
