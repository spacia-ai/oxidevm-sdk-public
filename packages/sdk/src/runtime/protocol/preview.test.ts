import { afterEach, describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "./common.js";
import { decodeExposePreviewPort, encodeExposePreviewPort } from "./preview.js";

const SESSION = "0a".repeat(16);
const ports: MessagePort[] = [];
afterEach(() => { for (const port of ports.splice(0)) port.close(); });

function sessionPort(): MessagePort {
  const { port1 } = new MessageChannel();
  ports.push(port1);
  return port1;
}

function exposure(fields: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    version: PROTOCOL_VERSION, type: "expose-preview-port", runtime: "userspace", isolation: "per-session", session: SESSION, port: 3000,
    sessionPort: sessionPort(), sessionOrigin: `http://${SESSION}.localhost:5174`, ...fields,
  };
}

describe("expose-preview-port", () => {
  it("round-trips an exposure through the encoder", () => {
    const port = sessionPort();
    const encoded = encodeExposePreviewPort({ runtime: "system", isolation: "per-session", session: SESSION, port: 8080, sessionPort: port, sessionOrigin: `https://${SESSION}.preview.example` });
    expect(encoded).toEqual({ version: PROTOCOL_VERSION, type: "expose-preview-port", runtime: "system", isolation: "per-session", session: SESSION, port: 8080, sessionPort: port, sessionOrigin: `https://${SESSION}.preview.example` });
    const decoded = decodeExposePreviewPort(encoded);
    expect(decoded).toMatchObject({ runtime: "system", session: SESSION, port: 8080, sessionPort: port });
    expect(decoded.origin.href).toBe(`https://${SESSION}.preview.example/`);
  });

  it("accepts only 32 lowercase hex session ids", () => {
    for (const session of ["g".repeat(32), "A".repeat(32), "a".repeat(31), "0".repeat(33)]) {
      expect(() => decodeExposePreviewPort(exposure({ session, sessionOrigin: `http://${session}.localhost:5174` }))).toThrow("invalid preview session");
    }
    expect(decodeExposePreviewPort(exposure()).session).toBe(SESSION);
  });

  it("accepts a shared exposure only on its bare origin", () => {
    const shared = decodeExposePreviewPort(exposure({ isolation: "shared", sessionOrigin: "https://fedora.tail133191.ts.net:8443" }));
    expect(shared).toMatchObject({ isolation: "shared", session: SESSION, sessionOrigin: "https://fedora.tail133191.ts.net:8443" });
    expect(() => decodeExposePreviewPort(exposure({ isolation: "shared" }))).toThrow("invalid preview session origin");
    expect(() => decodeExposePreviewPort(exposure({ isolation: "shared", sessionOrigin: "https://fedora.tail133191.ts.net:8443/x" }))).toThrow("invalid preview session origin");
    expect(() => decodeExposePreviewPort(exposure({ sessionOrigin: "https://fedora.tail133191.ts.net:8443" }))).toThrow("invalid preview session origin");
    expect(() => decodeExposePreviewPort(exposure({ isolation: "private" }))).toThrow("invalid preview session");
  });

  it.each([
    ["another session's origin", { sessionOrigin: `http://${"1".repeat(32)}.localhost:5174` }],
    ["an origin with a path", { sessionOrigin: `http://${SESSION}.localhost:5174/app` }],
  ])("refuses %s", (_name, fields) => {
    expect(() => decodeExposePreviewPort(exposure(fields))).toThrow("invalid preview session origin");
  });

  it.each([
    ["an extra field", { extra: 1 }],
    ["another runtime", { runtime: "browser" }],
    ["port 0", { port: 0 }],
    ["port 65536", { port: 65_536 }],
    ["a session port that is not a port", { sessionPort: "port" }],
    ["an origin that is not a URL", { sessionOrigin: "localhost" }],
  ])("refuses %s", (_name, fields) => {
    expect(() => decodeExposePreviewPort(exposure(fields))).toThrow();
  });
});
