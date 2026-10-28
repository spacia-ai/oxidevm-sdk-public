import { expect, it } from "vitest";
import { Writable } from "readable-stream";
import { createAsyncContext } from "./async-context.js";
import { createHttpResponses } from "./node-http-response.js";

function destination() {
  const bytes: Uint8Array[] = [];
  const socket = new Writable({ write(chunk, _encoding, done) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("Expected bytes");
    bytes.push(chunk.slice()); done();
  } });
  return { socket, text: () => Buffer.concat(bytes).toString("latin1") };
}
const request = { method: "GET", major: 1, minor: 1, keepAlive: true } as const;

it("exposes sealed header text to middleware without sending another header block", async () => {
  const { socket, text } = destination(), { ServerResponse } = createHttpResponses(createAsyncContext());
  const response = new ServerResponse(socket, request); response.sendDate = false;
  expect(response._header).toBeNull();
  response._implicitHeader();
  expect(response._header).toBe("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n");
  if (response._header === null) response._implicitHeader();
  response.end("ok"); await response.completion;
  expect(text().match(/HTTP\/1\.1/gu)).toHaveLength(1);
});

it.each([false, true])("runs an implicit header hook once before sending response bytes (explicit=%s)", async explicit => {
  const { socket, text } = destination(), { ServerResponse } = createHttpResponses(createAsyncContext());
  const response = new ServerResponse(socket, request); response.sendDate = false; response.statusCode = 201;
  const implicit = response._implicitHeader.bind(response); let calls = 0;
  response._implicitHeader = () => { calls++; response.setHeader("X-Hook", "yes"); implicit(); };
  if (explicit) response._implicitHeader();
  response.end("ok"); await response.completion;
  expect(calls).toBe(1); expect(response.headersSent).toBe(true);
  expect(text()).toBe("HTTP/1.1 201 Created\r\nX-Hook: yes\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n2\r\nok\r\n0\r\n\r\n");
  expect(() => response.setHeader("X-Late", "no")).toThrow("sent");
});

it("streams chunked responses, repeated cookies and trailers over the socket", async () => {
  const { socket, text } = destination();
  const { ServerResponse } = createHttpResponses(createAsyncContext());
  const response = new ServerResponse(socket, request);
  response.sendDate = false;
  response.setHeader("Set-Cookie", ["a=1; HttpOnly", "b=2"]);
  response.setHeader("Trailer", "X-Done");
  response.write("abc"); response.addTrailers({ "X-Done": "yes" }); response.end("def");
  await response.completion;
  expect(text()).toBe("HTTP/1.1 200 OK\r\nSet-Cookie: a=1; HttpOnly\r\nSet-Cookie: b=2\r\nTrailer: X-Done\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n3\r\nabc\r\n3\r\ndef\r\n0\r\nX-Done: yes\r\n\r\n");
  expect(socket.destroyed).toBe(false);
  expect(response.headersSent).toBe(true);
  expect(() => response.setHeader("X-Late", "no")).toThrow("sent");
});

it("keeps pipelined response bytes ordered and suppresses HEAD bodies", async () => {
  const { socket, text } = destination(); const { ServerResponse } = createHttpResponses(createAsyncContext());
  const first = new ServerResponse(socket, request); first.sendDate = false;
  const second = new ServerResponse(socket, { ...request, method: "HEAD" }, first.completion); second.sendDate = false;
  second.setHeader("Content-Length", "5"); second.end("hello");
  await Promise.resolve(); expect(text()).toBe("");
  first.setHeader("Content-Length", "3"); first.end("one");
  await Promise.all([first.completion, second.completion]);
  expect(text()).toBe("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: keep-alive\r\n\r\noneHTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: keep-alive\r\n\r\n");
});

it("rejects header injection and mismatched lengths without publishing another response", async () => {
  const { socket } = destination(); const { ServerResponse } = createHttpResponses(createAsyncContext());
  const response = new ServerResponse(socket, request);
  response.on("error", () => {}); socket.on("error", () => {});
  expect(() => response.setHeader("bad\r\nname", "x")).toThrow();
  expect(() => response.setHeader("X-Value", "x\r\nInjected: yes")).toThrow();
  response.strictContentLength = true; response.setHeader("Content-Length", "2"); response.end("abc");
  await expect(response.completion).rejects.toMatchObject({ code: "ERR_HTTP_CONTENT_LENGTH_MISMATCH" });
  expect(socket.destroyed).toBe(true);
});

it("closes explicitly chunked no-body responses like Node without writing a terminal chunk", async () => {
  for (const status of [204, 304]) {
    const { socket, text } = destination(); const { ServerResponse } = createHttpResponses(createAsyncContext());
    const response = new ServerResponse(socket, request); response.sendDate = false;
    response.statusCode = status; response.setHeader("Transfer-Encoding", "chunked"); response.end("ignored");
    await response.completion;
    expect(text()).toBe(`HTTP/1.1 ${status} ${status === 204 ? "No Content" : "Not Modified"}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`);
    expect(socket.writableFinished).toBe(true);
  }
});

it("keeps socket backpressure and write callback context through response framing", async () => {
  const context = createAsyncContext(); const store = new context.AsyncLocalStorage<string>();
  const blocked = Promise.withResolvers<() => void>();
  const socket = new Writable({ write(chunk, _encoding, done) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("Expected bytes");
    if (chunk.length === 65536) blocked.resolve(() => done()); else done();
  } });
  const { ServerResponse } = createHttpResponses(context);
  const response = new ServerResponse(socket, request); response.sendDate = false;
  const seen: unknown[] = [];
  const writable = store.run("writer", () => response.write(new Uint8Array(65536), error => seen.push([error, store.getStore()])));
  expect(writable).toBe(false);
  response.end();
  const release = await blocked.promise;
  expect(seen).toEqual([]); expect(response.writableFinished).toBe(false);
  release(); await response.completion;
  expect(seen).toEqual([[undefined, "writer"]]);
});

it("orders an informational response before final headers without committing them", async () => {
  const { socket, text } = destination(); const context = createAsyncContext();
  const store = new context.AsyncLocalStorage<string>();
  const { ServerResponse } = createHttpResponses(context);
  const response = new ServerResponse(socket, request); response.sendDate = false;
  const continued = store.run("continue", () => new Promise(resolve => response.writeContinue(() => resolve(store.getStore()))));
  expect(response.headersSent).toBe(false);
  response.setHeader("Content-Length", 2); response.end("ok");
  expect(await continued).toBe("continue"); await response.completion;
  expect(text()).toBe("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok");
});
