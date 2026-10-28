import { constants, getDefaultSettings } from "node:http2";
import { expect, it } from "vitest";
import { HTTP2_CONSTANTS, HTTP2_DEFAULT_SETTINGS } from "./node-http2-constants.js";
import { http2Authority, http2Options } from "./node-http2-options.js";
import { decodeHttp2Event, decodeHttp2Headers, decodeHttp2Settings } from "./node-http2-wire.js";
import { createAsyncContext } from "./async-context.js";
import { Http2Session } from "./node-http2-session.js";

it("provides the Node header metadata read eagerly by bundled Undici", () => {
  for (const [name, value] of Object.entries(HTTP2_CONSTANTS)) expect(Reflect.get(constants, name), name).toEqual(value);
  expect(HTTP2_DEFAULT_SETTINGS).toEqual(getDefaultSettings());
});
it("publishes session settings only after native metadata arrives", () => {
  const session = new Http2Session(1, createAsyncContext(), false, () => () => undefined);
  expect(session.localSettings).toEqual({});
  expect(session.remoteSettings).toEqual({});
  session.receive({ kind: "localSettings", session: 1, settings: { maxConcurrentStreams: 9 } });
  session.receive({ kind: "remoteSettings", session: 1, settings: { enablePush: false } });
  expect(session.localSettings).toEqual({ maxConcurrentStreams: 9 });
  expect(session.remoteSettings).toEqual({ enablePush: false });
  session.retire();
});
it("validates configuration before creating native processes", () => {
  expect(http2Authority(new URL("https://localhost:443"))).toBe("https://localhost/");
  expect(http2Options({ ca: "PEM", settings: { enablePush: false } })).toEqual({ ca: "UEVN", settings: { enablePush: false } });
  for (const value of ["file:///tmp/socket", "https://user:password@localhost"]) expect(() => http2Authority(value)).toThrow();
  for (const value of [{ allowHTTP1: true }, { createConnection() {} }, { ca: 1 }, { key: "x".repeat(32769) }, { rejectUnauthorized: "false" }]) expect(() => http2Options(value)).toThrow();
});
it("bounds HTTP/2 headers and settings", () => {
  expect(decodeHttp2Headers({ ":status": 200, "set-cookie": ["a=1", "b=2"] })).toEqual({ ":status": 200, "set-cookie": ["a=1", "b=2"] });
  for (const value of [{ connection: "close" }, { "x-bad": "a\r\nb" }, { ":bad-header": "x" }, { "x-large": "x".repeat(13000) }]) expect(() => decodeHttp2Headers(value)).toThrow();
  for (const value of [{ maxFrameSize: 1 }, { initialWindowSize: 0x80000000 }, { ignored: 1 }]) expect(() => decodeHttp2Settings(value)).toThrow();
});
it("decodes exact bounded native events", () => {
  const event = (value: unknown) => decodeHttp2Event(new TextEncoder().encode(JSON.stringify(value)));
  expect(event({ kind: "stream-close", session: 1, stream: 3, rstCode: 8 })).toEqual({ kind: "stream-close", session: 1, stream: 3, rstCode: 8 });
  for (const value of [
    { kind: "stream-close", session: 0, stream: 3, rstCode: 8 },
    { kind: "session-close", session: 1, ignored: true },
    { kind: "ping-ack", request: 1, error: null, duration: 0, data: "AA==" },
    { kind: "reply", request: 1, error: { code: "EIO", message: "failed", ignored: true } },
    { kind: "unrecognized" },
  ]) expect(() => event(value)).toThrow();
});
