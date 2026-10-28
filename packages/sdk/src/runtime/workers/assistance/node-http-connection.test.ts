import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeSockets } from "./node-socket.js";
import { createHttpResponses } from "./node-http-response.js";
import { createHttpConnection } from "./node-http-connection.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";

const wasm: unknown = createRequire(import.meta.url)("undici/lib/llhttp/llhttp-wasm.js");
if (!(wasm instanceof Uint8Array)) throw new TypeError("Missing llhttp artifact");
const module = new WebAssembly.Module(new Uint8Array(wasm));
function transport() {
  let reader: PromiseWithResolvers<AssistanceResult> | undefined;
  const input: Uint8Array<ArrayBuffer>[] = []; const output: Uint8Array[] = [];
  const context = createAsyncContext();
  const socket = new (createNodeSockets({ retain: () => () => {},
    callSync: () => ({ kind: "socket", fd: 1, local: { address: "127.0.0.1", port: 3000 }, peer: { address: "127.0.0.1", port: 1234 } }),
    call(operation) {
      if (operation.kind === "socket-read") {
        const bytes = input.shift();
        if (bytes !== undefined) return Promise.resolve({ kind: "data", bytes });
        reader = Promise.withResolvers<AssistanceResult>(); return reader.promise;
      }
      if (operation.kind === "socket-write") { output.push(operation.bytes); return Promise.resolve({ kind: "written", count: operation.bytes.length }); }
      if (operation.kind === "socket-close") reader?.resolve({ kind: "data", bytes: new Uint8Array() });
      return Promise.resolve({ kind: "unit" });
    },
  }, context).Socket)({ fd: 1, allowHalfOpen: true });
  return { socket, context, output: () => Buffer.concat(output).toString(), send(value: string) {
    const bytes = Uint8Array.from(Buffer.from(value));
    if (reader !== undefined) { const pending = reader; reader = undefined; pending.resolve({ kind: "data", bytes }); }
    else input.push(bytes);
  } };
}

it("dispatches pipelined body streams and preserves response order while handlers overlap", async () => {
  const wire = transport(); const responses = createHttpResponses(wire.context);
  const seen: string[] = []; const ended = Promise.withResolvers<undefined>();
  let first: InstanceType<typeof responses.ServerResponse> | undefined;
  const connection = createHttpConnection(wire.socket, module, wire.context, {
    Response: responses.ServerResponse,
    request(request, response) {
      response.sendDate = false;
      if (request.url === "/first") { first = response; request.resume(); return; }
      let body = "";
      request.on("data", bytes => { if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected bytes"); body += Buffer.from(bytes).toString(); });
      request.on("end", () => {
        seen.push(body); response.setHeader("Content-Length", 3); response.end("two");
        if (first === undefined) throw new Error("First request missing");
        first.setHeader("Content-Length", 3); first.end("one");
        void response.completion.then(() => ended.resolve(undefined));
      });
    },
    upgrade: () => false, clientError: error => { throw error; }, closed: () => {},
  });
  wire.send("GET /first HTTP/1.1\r\nHost: local\r\n\r\nPOST /second HTTP/1.1\r\nHost: local\r\nContent-Length: 4\r\n\r\nbody");
  await ended.promise;
  expect(seen).toEqual(["body"]);
  expect(wire.output()).toBe("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: keep-alive\r\n\r\noneHTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: keep-alive\r\n\r\ntwo");
  expect(connection.idle).toBe(true); connection.closeIdle();
  expect(wire.socket.destroyed).toBe(true);
});

it("hands upgrade bytes to the application once and stops HTTP parsing", async () => {
  const wire = transport(); const upgraded = Promise.withResolvers<string>();
  const frames: string[] = [];
  createHttpConnection(wire.socket, module, wire.context, {
    Response: createHttpResponses(wire.context).ServerResponse,
    request: () => { throw new Error("Upgrade became a request"); },
    upgrade(request, socket, head) {
      expect(request.url).toBe("/socket"); expect(socket).toBe(wire.socket);
      socket.on("data", bytes => { if (bytes instanceof Uint8Array) frames.push(Buffer.from(bytes).toString()); });
      upgraded.resolve(Buffer.from(head).toString()); return true;
    },
    clientError: error => { throw error; }, closed: () => {},
  });
  wire.send("GET /socket HTTP/1.1\r\nHost: local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nframe");
  expect(await upgraded.promise).toBe("frame");
  wire.send("next-frame");
  try { await expect.poll(() => frames, { timeout: 1000 }).toEqual(["next-frame"]); }
  finally { wire.socket.destroy(); }
});

it("does not close a partially received request as an idle connection", async () => {
  const wire = transport(); const reply = Promise.withResolvers<undefined>();
  const connection = createHttpConnection(wire.socket, module, wire.context, {
    Response: createHttpResponses(wire.context).ServerResponse,
    request(request, response) { request.resume(); response.end("ok"); void response.completion.then(() => reply.resolve(undefined)); },
    upgrade: () => false, clientError: error => { throw error; }, closed: () => {},
  });
  wire.send("GET / HT");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(connection.idle).toBe(false); connection.closeIdle();
  expect(wire.socket.writableEnded).toBe(false);
  wire.send("TP/1.1\r\nHost: local\r\n\r\n");
  await reply.promise; wire.socket.destroy();
});

it("bounds an overlapping pipeline and resumes it after response completion", async () => {
  const wire = transport(); const replies: InstanceType<ReturnType<typeof createHttpResponses>["ServerResponse"]>[] = [];
  const ninth = Promise.withResolvers<undefined>();
  createHttpConnection(wire.socket, module, wire.context, {
    Response: createHttpResponses(wire.context).ServerResponse,
    request(request, response) { request.resume(); replies.push(response); if (replies.length === 9) ninth.resolve(undefined); },
    upgrade: () => false, clientError: error => { throw error; }, closed: () => {},
  });
  wire.send("GET / HTTP/1.1\r\nHost: local\r\n\r\n".repeat(9));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(replies).toHaveLength(8);
  replies[0]?.end("first"); await ninth.promise;
  for (const response of replies.slice(1)) response.end("next");
  await Promise.all(replies.map(response => response.completion)); wire.socket.destroy();
});

it("finishes a backpressured body without requiring another socket byte", async () => {
  const wire = transport();
  const incoming = Promise.withResolvers<Parameters<Parameters<typeof createHttpConnection>[3]["request"]>[0]>();
  const completed = Promise.withResolvers<undefined>();
  createHttpConnection(wire.socket, module, wire.context, {
    Response: createHttpResponses(wire.context).ServerResponse,
    request(request, response) {
      incoming.resolve(request);
      request.on("end", () => { response.end("ok"); void response.completion.then(() => completed.resolve(undefined)); });
    },
    upgrade: () => false, clientError: error => { throw error; }, closed: () => {},
  });
  wire.send("POST / HTTP/1.1\r\nHost: local\r\nContent-Length: 65536\r\n\r\n");
  const request = await incoming.promise;
  wire.send("x".repeat(65536));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(request.complete).toBe(false);
  request.resume(); await completed.promise; wire.socket.destroy();
});

it("reports truncated framing once and retires the pending response", async () => {
  const wire = transport(); const failures: Error[] = [];
  const closed = Promise.withResolvers<undefined>();
  let response: InstanceType<ReturnType<typeof createHttpResponses>["ServerResponse"]> | undefined;
  createHttpConnection(wire.socket, module, wire.context, {
    Response: createHttpResponses(wire.context).ServerResponse,
    request(request, value) { response = value; request.resume(); },
    upgrade: () => false, clientError: error => { failures.push(error); }, closed: () => closed.resolve(undefined),
  });
  wire.send("POST / HTTP/1.1\r\nContent-Length: 4\r\n\r\nx");
  await new Promise(resolve => setTimeout(resolve, 0));
  wire.send(""); await closed.promise;
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ code: "HPE_INVALID_EOF_STATE" });
  if (response === undefined) throw new Error("Request was not dispatched");
  await expect(response.completion).rejects.toMatchObject({ code: "ECONNRESET" });
});

it("allows a clientError owner to send a response before closing", async () => {
  const wire = transport(); const sent = Promise.withResolvers<undefined>();
  createHttpConnection(wire.socket, module, wire.context, {
    Response: createHttpResponses(wire.context).ServerResponse,
    request: () => { throw new Error("Malformed request dispatched"); }, upgrade: () => false, closed: () => {},
    clientError(error) {
      expect(error).toMatchObject({ code: "HPE_INVALID_METHOD" });
      wire.socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", () => sent.resolve(undefined));
      return true;
    },
  });
  wire.send("INVALID / HTTP/1.1\r\n\r\n");
  await sent.promise;
  expect(wire.output()).toContain("HTTP/1.1 400 Bad Request\r\n");
  wire.socket.destroy();
});

it("drains an unconsumed body after an early response so keep-alive can serve the next request", async () => {
  const wire = transport();
  const first = Promise.withResolvers<InstanceType<ReturnType<typeof createHttpResponses>["ServerResponse"]>>();
  const second = Promise.withResolvers<undefined>();
  createHttpConnection(wire.socket, module, wire.context, {
    Response: createHttpResponses(wire.context).ServerResponse,
    request(request, response) {
      if (request.url === "/first") first.resolve(response);
      else { request.resume(); response.end("next"); void response.completion.then(() => second.resolve(undefined)); }
    },
    upgrade: () => false, clientError: error => { throw error; }, closed: () => {},
  });
  wire.send("POST /first HTTP/1.1\r\nHost: local\r\nContent-Length: 131072\r\n\r\n" + "x".repeat(100));
  const response = await first.promise;
  await new Promise(resolve => setTimeout(resolve, 0));
  response.end("early"); await response.completion;
  wire.send("x".repeat(65536)); wire.send("x".repeat(65436));
  wire.send("GET /second HTTP/1.1\r\nHost: local\r\n\r\n");
  await second.promise; wire.socket.destroy();
  expect(wire.output()).toContain("next");
});

it("delivers inactivity to request and response listeners and closes an unhandled timeout", async () => {
  const wire = transport(); const seen: string[] = [];
  const handled = Promise.withResolvers<undefined>(); const closed = Promise.withResolvers<undefined>();
  createHttpConnection(wire.socket, module, wire.context, {
    Response: createHttpResponses(wire.context).ServerResponse,
    request(request, response) {
      request.setTimeout(5, () => { seen.push("request"); });
      response.setTimeout(5, () => { seen.push("response"); handled.resolve(undefined); });
      void handled.promise.then(() => {
        expect(wire.socket.destroyed).toBe(false);
        request.removeAllListeners("timeout"); response.removeAllListeners("timeout");
        wire.socket.setTimeout(5);
      });
    },
    upgrade: () => false, clientError: error => { throw error; }, closed: () => closed.resolve(undefined),
  });
  wire.send("POST / HTTP/1.1\r\nContent-Length: 1\r\n\r\n");
  await closed.promise;
  expect(seen).toEqual(["request", "response"]);
});

it("replaces the keep-alive deadline when the next request starts arriving", async () => {
  const wire = transport(); const first = Promise.withResolvers<undefined>(); const second = Promise.withResolvers<undefined>();
  let activated = 0;
  createHttpConnection(wire.socket, module, wire.context, {
    Response: createHttpResponses(wire.context).ServerResponse,
    request(request, response) {
      request.resume(); response.end("ok");
      void response.completion.then(() => (request.url === "/first" ? first : second).resolve(undefined));
    },
    idle: () => { wire.socket.setTimeout(5); return true; },
    active: () => { activated++; wire.socket.setTimeout(0); },
    upgrade: () => false, clientError: error => { throw error; }, closed: () => {},
  });
  wire.send("GET /first HTTP/1.1\r\nHost: local\r\n\r\n"); await first.promise;
  wire.send("GET /second HT");
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(wire.socket.destroyed).toBe(false); expect(activated).toBe(1);
  wire.send("TP/1.1\r\nHost: local\r\n\r\n"); await second.promise; wire.socket.destroy();
});

it("keeps inactivity retirement after the parser hands an error to the application", async () => {
  const wire = transport(); const closed = Promise.withResolvers<undefined>();
  createHttpConnection(wire.socket, module, wire.context, {
    Response: createHttpResponses(wire.context).ServerResponse,
    request: () => { throw new Error("Malformed request dispatched"); }, upgrade: () => false,
    clientError: () => { wire.socket.setTimeout(5); return true; }, closed: () => closed.resolve(undefined),
  });
  wire.send("INVALID / HTTP/1.1\r\n\r\n"); await closed.promise;
  expect(wire.socket.destroyed).toBe(true);
});
