import { expect, it } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeSockets } from "./node-socket.js";
import { createIncomingMessage } from "./node-http-incoming.js";

function socket() {
  return new (createNodeSockets({ retain: () => () => {},
    callSync: () => ({ kind: "socket", fd: 1, local: { address: "127.0.0.1", port: 3000 }, peer: { address: "127.0.0.1", port: 1234 } }),
    call: () => Promise.resolve({ kind: "unit" }),
  }, createAsyncContext()).Socket)({ fd: 1 });
}
const head = { method: "POST", url: "/api", major: 1, minor: 1, keepAlive: true, upgrade: false,
  headers: [["Host", "first"], ["host", "second"], ["Cookie", "a=1"], ["cookie", "b=2"], ["Set-Cookie", "x=1"], ["Set-Cookie", "y=2"], ["X-Test", "one"], ["x-test", "two"], ["__proto__", "safe"]] } as const;

it("preserves raw headers and Node duplicate rules without prototype pollution", () => {
  const peer = socket(); const incoming = createIncomingMessage(peer, head, () => {}, createAsyncContext());
  const request = incoming.message;
  expect(request.statusCode).toBeNull(); expect(request.statusMessage).toBeNull();
  expect(request.method).toBe("POST"); expect(request.url).toBe("/api"); expect(request.httpVersion).toBe("1.1");
  expect(request.socket).toBe(peer); expect(request.connection).toBe(peer);
  expect(request.headers).toMatchObject({ host: "first", cookie: "a=1; b=2", "set-cookie": ["x=1", "y=2"], "x-test": "one, two", "__proto__": "safe" });
  expect(Object.getPrototypeOf(request.headers)).toBeNull();
  expect(request.headers["__proto__"]).toBe("safe");
  expect(request.headersDistinct["host"]).toEqual(["first", "second"]);
  expect(request.rawHeaders).toEqual(head.headers.flat());
  incoming.finish([["X-Trailer", "yes"]]);
  expect(request.complete).toBe(true); expect(request.trailers).toMatchObject({ "x-trailer": "yes" });
  expect(request.rawTrailers).toEqual(["X-Trailer", "yes"]);
  request.resume(); peer.destroy();
});

it("pauses at the readable high water mark and resumes when the application consumes", () => {
  const peer = socket(); let resumed = 0;
  const incoming = createIncomingMessage(peer, head, () => { resumed++; }, createAsyncContext());
  expect(incoming.body(new Uint8Array(65536))).toBe(false);
  expect(incoming.message.readableLength).toBe(65536);
  incoming.message.read();
  expect(resumed).toBeGreaterThan(0);
  incoming.finish([]); incoming.message.resume(); peer.destroy();
});

it("reports premature socket termination as aborted without claiming a complete request", async () => {
  const peer = socket(); const incoming = createIncomingMessage(peer, head, () => {}, createAsyncContext());
  const request = incoming.message; const events: string[] = [];
  peer.on("error", () => {});
  request.on("aborted", () => events.push("aborted")); request.on("error", () => events.push("error"));
  const closed = new Promise(resolve => request.on("close", resolve));
  incoming.abort(new Error("connection lost")); await closed;
  expect(request.aborted).toBe(true); expect(request.complete).toBe(false);
  expect(events).toEqual(["aborted", "error"]);
  expect(peer.destroyed).toBe(true);
});

it("does not turn an unhandled client abort into a server process error", async () => {
  const peer = socket(); peer.on("error", () => {});
  const incoming = createIncomingMessage(peer, head, () => {}, createAsyncContext());
  const closed = new Promise(resolve => incoming.message.once("close", resolve));
  incoming.abort(new Error("client left")); await closed;
  expect(incoming.message.aborted).toBe(true);
});

it("uses one incoming stream owner for response status, duplicate cookies, body and trailers", async () => {
  const peer = socket(); let resumed = 0;
  const incoming = createIncomingMessage(peer, { statusCode: 201, statusMessage: "Created", major: 1, minor: 1,
    headers: [["Set-Cookie", "a=1"], ["Set-Cookie", "b=2"]], keepAlive: true, upgrade: false },
  () => { resumed++; }, createAsyncContext());
  const response = incoming.message;
  expect(response.method).toBeNull(); expect(response.url).toBe("");
  expect(response.statusCode).toBe(201); expect(response.statusMessage).toBe("Created");
  expect(response.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
  expect(incoming.body(new Uint8Array(65536))).toBe(false);
  expect(response.readableLength).toBe(65536); response.read();
  expect(resumed).toBeGreaterThan(0);
  incoming.finish([["X-Trailer", "complete"]]);
  const ended = new Promise<void>(resolve => response.once("end", () => resolve()));
  response.resume(); await ended;
  expect(response.complete).toBe(true); expect(response.aborted).toBe(false);
  expect(response.trailers).toMatchObject({ "x-trailer": "complete" });
  peer.destroy();
});
