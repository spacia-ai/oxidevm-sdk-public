import { createRequire } from "node:module";
import { Buffer } from "buffer";
import { expect, it, vi } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeSockets } from "./node-socket.js";
import { receiveHttpResponse } from "./node-http-client-connection.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";

const wasm: unknown = createRequire(import.meta.url)("undici/lib/llhttp/llhttp-wasm.js");
if (!(wasm instanceof Uint8Array)) throw new TypeError("Missing llhttp artifact");
const module = new WebAssembly.Module(new Uint8Array(wasm));
function transport() {
  let reader: PromiseWithResolvers<AssistanceResult> | undefined;
  const input: Uint8Array<ArrayBuffer>[] = [];
  const context = createAsyncContext();
  const socket = new (createNodeSockets({ retain: () => () => {},
    callSync: () => ({ kind: "socket", fd: 1, local: { address: "127.0.0.1", port: 1234 }, peer: { address: "127.0.0.1", port: 3000 } }),
    call(operation) {
      if (operation.kind === "socket-read") {
        const bytes = input.shift();
        if (bytes !== undefined) return Promise.resolve({ kind: "data", bytes });
        reader = Promise.withResolvers<AssistanceResult>(); return reader.promise;
      }
      if (operation.kind === "socket-close") reader?.resolve({ kind: "data", bytes: new Uint8Array() });
      return Promise.resolve({ kind: "unit" });
    },
  }, context).Socket)({ fd: 1, allowHalfOpen: true });
  return { socket, context, send(value: string) {
    const bytes = Uint8Array.from(Buffer.from(value));
    if (reader !== undefined) { const pending = reader; reader = undefined; pending.resolve({ kind: "data", bytes }); }
    else input.push(bytes);
  } };
}

it("delivers informational responses and a streamed final body before releasing a reusable socket", async () => {
  const wire = transport(); const information: number[] = []; const chunks: string[] = [];
  const released = Promise.withResolvers<boolean>();
  receiveHttpResponse(wire.socket, module, wire.context, "GET", {
    information(head) { information.push(head.statusCode); },
    response(message) {
      expect(message.statusCode).toBe(201);
      expect(message.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
      message.on("data", bytes => { if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected body bytes"); chunks.push(Buffer.from(bytes).toString()); });
      message.on("end", () => expect(message.trailers).toEqual({ "x-result": "ok" }));
    },
    upgrade() { throw new Error("Unexpected upgrade"); },
    complete: value => released.resolve(value), error: error => released.reject(error),
  });
  wire.send("HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\nHTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n3\r\none\r\n");
  await vi.waitFor(() => expect(chunks).toEqual(["one"]));
  wire.send("3\r\ntwo\r\n0\r\nX-Result: ok\r\n\r\n");
  expect(await released.promise).toBe(true);
  expect(information).toEqual([103]); expect(chunks.join("")).toBe("onetwo");
  expect(wire.socket.listenerCount("data")).toBe(0);
  wire.socket.destroy();
});

it("hands CONNECT tunnel bytes off without consuming them as an HTTP body", async () => {
  const wire = transport(); const upgraded = Promise.withResolvers<string>();
  receiveHttpResponse(wire.socket, module, wire.context, "CONNECT", {
    information() {}, response() { throw new Error("Unexpected response"); },
    upgrade(message, head) { expect(message.statusCode).toBe(200); upgraded.resolve(Buffer.from(head).toString()); },
    complete() { throw new Error("Unexpected completion"); }, error: error => upgraded.reject(error),
  });
  wire.send("HTTP/1.1 200 Connection Established\r\n\r\ntunnel");
  expect(await upgraded.promise).toBe("tunnel");
  expect(wire.socket.destroyed).toBe(false);
  expect(wire.socket.listenerCount("data")).toBe(0);
  wire.socket.destroy();
});

it("does not release an unread body and aborts a truncated response", async () => {
  const wire = transport(); const completed = vi.fn(); const errors: Error[] = [];
  let response: Parameters<Parameters<typeof receiveHttpResponse>[4]["response"]>[0] | undefined;
  receiveHttpResponse(wire.socket, module, wire.context, "GET", {
    information() {}, upgrade() {}, complete: completed, error: error => errors.push(error),
    response(message) { response = message; },
  });
  wire.send("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
  await vi.waitFor(() => expect(response?.complete).toBe(true));
  expect(completed).not.toHaveBeenCalled();
  response?.resume();
  await vi.waitFor(() => expect(completed).toHaveBeenCalledWith(true));
  wire.socket.destroy(); expect(errors).toEqual([]);

  const broken = transport(); const failed = Promise.withResolvers<Error>();
  let aborted = false;
  receiveHttpResponse(broken.socket, module, broken.context, "GET", {
    information() {}, upgrade() {}, complete() { throw new Error("Truncated response completed"); },
    error: error => failed.resolve(error),
    response(message) { message.on("aborted", () => { aborted = true; }); message.resume(); },
  });
  broken.send("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe"); broken.send("");
  expect(await failed.promise).toBeInstanceOf(Error);
  await vi.waitFor(() => expect(aborted).toBe(true));
});

it("skips HEAD bodies and retires EOF-delimited sockets", async () => {
  for (const method of ["HEAD", "GET"]) {
    const wire = transport(); const finished = Promise.withResolvers<boolean>(); const body: Uint8Array[] = [];
    receiveHttpResponse(wire.socket, module, wire.context, method, {
      information() {}, upgrade() {}, complete: value => finished.resolve(value), error: error => finished.reject(error),
      response(message) { message.on("data", bytes => { if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected body bytes"); body.push(bytes); }); },
    });
    wire.send(method === "HEAD" ? "HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n" : "HTTP/1.0 200 OK\r\n\r\nbody");
    if (method === "GET") wire.send("");
    expect(await finished.promise).toBe(method === "HEAD");
    expect(Buffer.concat(body).toString()).toBe(method === "HEAD" ? "" : "body");
    wire.socket.destroy();
  }
});

it("bounds an unread response and resumes parsing when the body is consumed", async () => {
  const wire = transport(); const complete = Promise.withResolvers<boolean>();
  let response: Parameters<Parameters<typeof receiveHttpResponse>[4]["response"]>[0] | undefined;
  receiveHttpResponse(wire.socket, module, wire.context, "GET", {
    information() {}, upgrade() {}, complete: value => complete.resolve(value), error: error => complete.reject(error),
    response(message) { response = message; },
  });
  wire.send("HTTP/1.1 200 OK\r\nContent-Length: 196608\r\n\r\n");
  for (let index = 0; index < 6; index++) wire.send("x".repeat(32768));
  await vi.waitFor(() => expect(response?.readableLength).toBe(65536));
  expect(response?.complete).toBe(false);
  let count = 0;
  response?.on("data", bytes => { if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected body bytes"); count += bytes.length; });
  expect(await complete.promise).toBe(true);
  expect(count).toBe(196608); wire.socket.destroy();
});

it("rejects empty, malformed and unsolicited trailing responses without releasing the socket", async () => {
  for (const input of ["", "not HTTP\r\n\r\n", "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\nextra"]) {
    const wire = transport(); const failed = Promise.withResolvers<Error>(); const completed = vi.fn();
    receiveHttpResponse(wire.socket, module, wire.context, "GET", {
      information() {}, upgrade() {}, complete: completed, error: error => failed.resolve(error), response(message) { message.resume(); },
    });
    wire.send(input);
    expect(await failed.promise).toBeInstanceOf(Error);
    expect(completed).not.toHaveBeenCalled(); expect(wire.socket.destroyed).toBe(true);
  }
});

it("retires the socket if a complete but unread response is destroyed", async () => {
  const wire = transport(); const failed = Promise.withResolvers<Error>(); const completed = vi.fn();
  let response: Parameters<Parameters<typeof receiveHttpResponse>[4]["response"]>[0] | undefined;
  receiveHttpResponse(wire.socket, module, wire.context, "GET", {
    information() {}, upgrade() {}, complete: completed, error: error => failed.resolve(error),
    response(message) { response = message; },
  });
  wire.send("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
  await vi.waitFor(() => expect(response?.complete).toBe(true));
  response?.destroy();
  expect(await failed.promise).toMatchObject({ code: "ECONNRESET" });
  expect(completed).not.toHaveBeenCalled(); expect(wire.socket.destroyed).toBe(true);
});
