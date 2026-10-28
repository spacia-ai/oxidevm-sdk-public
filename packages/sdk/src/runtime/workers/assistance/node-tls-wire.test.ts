import { Buffer } from "buffer";
import { PassThrough } from "readable-stream";
import { expect, it } from "vitest";
import { readTlsFrame, tlsControl, tlsData } from "./node-tls-wire.js";

it("reads fragmented frames without a second body queue", async () => {
  const stream = new PassThrough();
  const ready = readTlsFrame(stream);
  const bytes = tlsData(Buffer.from("hello"));
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  expect(await ready).toEqual({ kind: "data", bytes: Buffer.from("hello") });
  const next = readTlsFrame(stream); stream.end(tlsControl({ kind: "end" }));
  expect(await next).toEqual({ kind: "end" });
  expect(await readTlsFrame(stream)).toBe(null);
});
it("rejects oversized, unknown, truncated and malformed helper output", async () => {
  for (const bytes of [Buffer.from([0, 0, 1, 0, 1]), Buffer.from([3, 0, 0, 0, 1, 0]), Buffer.from([0, 0, 0]), Buffer.from([0, 0, 0, 0, 2, 1]), Buffer.alloc(5)]) {
    const stream = new PassThrough(); const pending = readTlsFrame(stream);
    stream.end(bytes); await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  }
  for (const value of [{ kind: "written", count: 65537 }, { kind: "close", hadError: "false" }, { kind: "end", ignored: true }, { kind: "error", code: "EIO", message: 42 }]) {
    const stream = new PassThrough(); const payload = Buffer.from(JSON.stringify(value));
    const frame = Buffer.alloc(5 + payload.length); frame[0] = 1; frame.writeUInt32BE(payload.length, 1); frame.set(payload, 5);
    const pending = readTlsFrame(stream); stream.end(frame);
    await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  }
});

it("rejects contradictory TLS authentication metadata", async () => {
  const secure = { kind: "secure", authorized: true, authorizationError: null, servername: "localhost", alpnProtocol: false,
    protocol: "TLSv1.3", cipher: { name: "TLS_AES_256_GCM_SHA384", standardName: "TLS_AES_256_GCM_SHA384", version: "TLSv1.3" },
    localAddress: "127.0.0.1", localPort: 1234, localFamily: "IPv4", remoteAddress: "127.0.0.1", remotePort: 443, remoteFamily: "IPv4" };
  for (const change of [{ authorized: false }, { authorizationError: "CERT_REVOKED" }, { protocol: "plaintext" }, { remoteFamily: "IPv6" }]) {
    const bytes = Buffer.from(JSON.stringify({ ...secure, ...change })); const frame = Buffer.alloc(bytes.length + 5);
    frame[0] = 1; frame.writeUInt32BE(bytes.length, 1); frame.set(bytes, 5);
    const stream = new PassThrough(); const pending = readTlsFrame(stream); stream.end(frame);
    await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  }
});
