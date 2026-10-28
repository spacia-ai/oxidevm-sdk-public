import { describe, expect, it } from "vitest";
import { decodeRequest, decodeWebSocketRequest, encodeHead, encodeUpgradeHead, parseHead, rewriteResponseHeaders } from "./preview-http-codec.js";
import { UNKNOWN_CLIENT } from "./preview-cookies.js";

const head = (headers: string) => new TextEncoder().encode(`HTTP/1.1 200 OK\r\n${headers}\r\n`);

describe("preview HTTP trust boundary", () => {
  it.each(["/ok\r\nX-Injected: true", "/has space", "/tab\t", "/fragment#wrong", "/nul\0", "/del\x7f"])(
    "rejects a request target that cannot be forwarded literally: %j", path => {
      const channel = new MessageChannel();
      try {
        expect(() => decodeRequest({ kind: "request", port: channel.port1, method: "GET", path, headers: [], hasBody: false })).toThrow();
        expect(() => decodeWebSocketRequest({ kind: "websocket", port: channel.port1, path, protocols: [] })).toThrow();
      } finally { channel.port1.close(); channel.port2.close(); }
    },
  );

  it.each([
    "Content-Length: 1\r\nContent-Length: 2\r\n",
    "Content-Length: 1\r\nContent-Length: 1\r\n",
    "Content-Length: 1\r\nTransfer-Encoding: chunked\r\n",
    "Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n",
    "Transfer-Encoding: gzip, chunked\r\n",
    "Content-Length: -1\r\n",
    "Content-Length: 1, 1\r\n",
    "Content-Length : 1\r\n",
    "X-Invalid: before\0after\r\n",
    "X-Invalid: \v\r\n",
  ])("rejects ambiguous or unsupported response framing: %j", headers => {
    expect(() => parseHead(head(headers))).toThrow();
  });

  it("rejects oversized or unterminated response headers", () => {
    expect(() => parseHead(head(`X-Large: ${"a".repeat(64 * 1024)}\r\n`))).toThrow();
    expect(() => parseHead(new TextEncoder().encode("HTTP/1.1 200 OK\r\n"))).toThrow();
    expect(() => parseHead(head("X-A: b\r\n".repeat(129)))).toThrow();
  });

  it("retains independent Set-Cookie fields and accepts supported framing", () => {
    const response = parseHead(head("Transfer-Encoding: chunked\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n"));
    expect(response.headers).toEqual([["transfer-encoding", "chunked"], ["set-cookie", "a=1"], ["set-cookie", "b=2"]]);
    expect(parseHead(head("Content-Length: 0\r\n")).status).toBe(200);
  });
});

describe("preview session forwarding", () => {
  it("decodes the client context, defaults it when absent, and rejects a malformed one", () => {
    const channel = new MessageChannel();
    try {
      const base = { kind: "request", port: channel.port1, method: "GET", path: "/", headers: [], hasBody: false };
      expect(decodeRequest(base).client).toEqual(UNKNOWN_CLIENT);
      const client = { frame: "nested", ancestor: "https://oxidevm-ide.test:4473", navigate: true };
      expect(decodeRequest({ ...base, client }).client).toEqual(client);
      expect(() => decodeRequest({ ...base, client: { frame: "window", ancestor: null, navigate: false } })).toThrow();
      expect(() => decodeRequest({ ...base, client: { frame: "top", ancestor: 5, navigate: false } })).toThrow();
      expect(() => decodeRequest({ ...base, client: { frame: "top", ancestor: null } })).toThrow();
    } finally { channel.port1.close(); channel.port2.close(); }
  });

  it("forwards Host as the guest's own localhost listener, keeps X-Forwarded with the session origin, and replaces the browser's cookie", () => {
    const channel = new MessageChannel();
    try {
      const request = decodeRequest({ kind: "request", port: channel.port1, method: "GET", path: "/api", headers: [["cookie", "forged=1"], ["accept", "*/*"], ["host", "abc.oxidevm-preview.test:4573"]], hasBody: false });
      const session = new TextDecoder().decode(encodeHead(request, 3000, { origin: SESSION, cookie: "secret=1; visible=2" }));
      expect(session).toContain("host: localhost:3000\r\n");
      expect(session).not.toMatch(/^host: abc/mu);
      expect(session).toContain("x-forwarded-proto: https\r\n");
      expect(session).toContain("x-forwarded-host: abc.oxidevm-preview.test:4573\r\n");
      expect(session).toContain("cookie: secret=1; visible=2\r\n");
      expect(session).not.toContain("forged");
      const loopback = new TextDecoder().decode(encodeHead(request, 3000));
      expect(loopback).toContain("host: localhost:3000\r\n");
      expect(loopback).not.toContain("x-forwarded");
      expect(loopback).not.toContain("cookie:");
      expect(new TextDecoder().decode(encodeHead(request, 80))).toContain("host: localhost\r\n");
    } finally { channel.port1.close(); channel.port2.close(); }
  });

  it("rewrites Origin and Referer naming the session origin to the guest listener and leaves other origins alone", () => {
    const channel = new MessageChannel();
    try {
      const forward = (headers: [string, string][]) => new TextDecoder().decode(encodeHead(
        decodeRequest({ kind: "request", port: channel.port1, method: "POST", path: "/", headers, hasBody: false }), 5173, { origin: SESSION }));
      const own = forward([["origin", "https://abc.oxidevm-preview.test:4573"], ["referer", "https://abc.oxidevm-preview.test:4573/src/main.ts?t=1"]]);
      expect(own).toContain("origin: http://localhost:5173\r\n");
      expect(own).toContain("referer: http://localhost:5173/src/main.ts?t=1\r\n");
      const foreign = forward([["origin", "https://evil.example"], ["referer", "https://abc.oxidevm-preview.test/other-port"]]);
      expect(foreign).toContain("origin: https://evil.example\r\n");
      expect(foreign).toContain("referer: https://abc.oxidevm-preview.test/other-port\r\n");
      expect(forward([["origin", "null"]])).toContain("origin: null\r\n");
    } finally { channel.port1.close(); channel.port2.close(); }
  });

  it("opens a WebSocket upgrade the way a browser on localhost does", () => {
    const channel = new MessageChannel();
    try {
      const request = decodeWebSocketRequest({ kind: "websocket", port: channel.port1, path: "/?token=abc", protocols: ["vite-hmr"] });
      const head = new TextDecoder().decode(encodeUpgradeHead(request, 5173, "a2V5", { origin: SESSION }));
      expect(head.startsWith("GET /?token=abc HTTP/1.1\r\n")).toBe(true);
      expect(head).toContain("host: localhost:5173\r\n");
      expect(head).toContain("origin: http://localhost:5173\r\n");
      expect(head).toContain("x-forwarded-host: abc.oxidevm-preview.test:4573\r\n");
      expect(head).toContain("sec-websocket-key: a2V5\r\n");
      expect(head).toContain("sec-websocket-protocol: vite-hmr\r\n");
      expect(head.endsWith("\r\n\r\n")).toBe(true);
      expect(new TextDecoder().decode(encodeUpgradeHead({ ...request, protocols: [] }, 5173, "a2V5"))).not.toContain("sec-websocket-protocol");
    } finally { channel.port1.close(); channel.port2.close(); }
  });

  it.each([
    ["location", "http://localhost:5173/login?next=%2F", "https://abc.oxidevm-preview.test:4573/login?next=%2F"],
    ["location", "http://127.0.0.1:5173", "https://abc.oxidevm-preview.test:4573"],
    ["location", "http://LOCALHOST:5173#top", "https://abc.oxidevm-preview.test:4573#top"],
    ["content-location", "http://[::1]:5173/a", "https://abc.oxidevm-preview.test:4573/a"],
    ["access-control-allow-origin", "http://localhost:5173", "https://abc.oxidevm-preview.test:4573"],
    ["refresh", "0; url=http://localhost:5173/next", "0; url=https://abc.oxidevm-preview.test:4573/next"],
    ["location", "http://localhost:3000/elsewhere", "http://localhost:3000/elsewhere"],
    ["location", "http://localhost/no-port", "http://localhost/no-port"],
    ["location", "http://localhost:51730/", "http://localhost:51730/"],
    ["location", "https://localhost:5173/", "https://localhost:5173/"],
    ["location", "http://localhost.example:5173/", "http://localhost.example:5173/"],
    ["location", "/relative", "/relative"],
    ["access-control-allow-origin", "*", "*"],
    ["link", "<http://localhost:5173/a>; rel=preload", "<http://localhost:5173/a>; rel=preload"],
  ])("maps a response %s of %j back to the session origin only for the guest listener", (name, value, expected) => {
    expect(rewriteResponseHeaders([[name, value]], 5173, SESSION)).toEqual([[name, expected]]);
    expect(rewriteResponseHeaders([[name, value]], 5173, undefined)).toEqual([[name, value]]);
  });

  it("maps the default HTTP port only when the guest listens on it", () => {
    expect(rewriteResponseHeaders([["location", "http://localhost/a"]], 80, SESSION)).toEqual([["location", "https://abc.oxidevm-preview.test:4573/a"]]);
    expect(rewriteResponseHeaders([["location", "http://localhost:80/a"]], 80, SESSION)).toEqual([["location", "https://abc.oxidevm-preview.test:4573/a"]]);
  });
});

const SESSION = new URL("https://abc.oxidevm-preview.test:4573");
