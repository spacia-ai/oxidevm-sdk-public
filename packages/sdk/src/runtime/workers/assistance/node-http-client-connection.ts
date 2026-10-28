import { HttpParser, type HttpResponseHead } from "./http-parser.js";
import { createIncomingMessage } from "./node-http-incoming.js";
import type { AsyncContext } from "./async-context.js";
import type { NodeSocket } from "./node-socket.js";
import { streamError } from "./node-streams.js";

type Incoming = ReturnType<typeof createIncomingMessage>;
type Handlers = {
  information(head: HttpResponseHead): void;
  response(message: Incoming["message"]): void;
  upgrade(message: Incoming["message"], head: Uint8Array): void;
  complete(reusable: boolean): void;
  error(error: Error): void;
};

/** One response exchange leases a socket until its body is consumed. The socket
 * and IncomingMessage own buffering; only one bounded input chunk is retained. */
export function receiveHttpResponse(socket: NodeSocket, module: WebAssembly.Module, context: AsyncContext, method: string, handlers: Handlers) {
  let input = new Uint8Array();
  let applicationFailed = false;
  let incoming: Incoming | undefined;
  let informational = false; let upgrading = false; let reusable = false;
  let paused = false; let bodyBlocked = false; let scheduled = false;
  let ended = false; let finished = false; let retired = false; let closed = false;
  const parser = new HttpParser(module, { kind: "response",
    headers(head) {
      informational = head.statusCode < 200 && head.statusCode !== 101;
      if (informational) { application(() => handlers.information(head)); return "skip-body"; }
      if (incoming !== undefined) throw failure("HPE_UNEXPECTED_RESPONSE", "Multiple final HTTP responses for one request");
      incoming = createIncomingMessage(socket, head, () => { bodyBlocked = false; schedule(); }, context);
      upgrading = head.statusCode === 101 || (method === "CONNECT" && head.statusCode >= 200 && head.statusCode < 300);
      if (upgrading) return "upgrade";
      reusable = head.keepAlive;
      incoming.message.once("end", release);
      incoming.message.once("close", () => {
        if (!retired && incoming?.message.readableEnded !== true) fail(failure("ECONNRESET", "HTTP response body was discarded before consumption"));
      });
      const message = incoming.message;
      application(() => handlers.response(message));
      return method === "HEAD" ? "skip-body" : "body";
    },
    body(bytes) {
      if (incoming === undefined || informational) throw failure("HPE_UNEXPECTED_CONTENT", "HTTP response body lacks a final response");
      const message = incoming;
      bodyBlocked = !application(() => message.body(bytes)); return !bodyBlocked;
    },
    complete(trailers) {
      if (upgrading) return true;
      if (informational) { informational = false; return true; }
      if (incoming === undefined) throw failure("HPE_UNEXPECTED_CONTENT", "HTTP response completion lacks headers");
      finished = true; const message = incoming;
      application(() => message.finish(trailers));
      return ended;
    },
  });
  function schedule(): void {
    if (scheduled || retired) return;
    scheduled = true; queueMicrotask(() => { scheduled = false; pump(); });
  }
  function pump(): void {
    if (retired || socket.destroyed) return;
    try {
      const resuming = paused;
      if (paused) {
        if (bodyBlocked || finished) return;
        parser.resume(); paused = false;
      }
      if (input.length !== 0 || resuming) {
        const result = parser.feed(input);
        input = input.slice(result.consumed);
        if (result.state === "upgrade") {
          if (!upgrading || incoming === undefined) throw failure("HPE_INVALID_UPGRADE", "HTTP upgrade lacks a response");
          retired = true; detach(); parser.close();
          incoming.message.complete = true;
          const head = input; input = new Uint8Array();
          handlers.upgrade(incoming.message, head); return;
        }
        paused = result.state === "paused";
        if (finished && input.length !== 0) throw failure("HPE_UNEXPECTED_CONTENT", "Unexpected bytes after final HTTP response");
        if (paused) return;
      }
      if (ended) {
        parser.finish();
        if (!finished) throw failure("ECONNRESET", "Socket ended before an HTTP response");
      } else socket.resume();
    } catch (error) {
      if (applicationFailed || retired) { retire(streamError(error)); throw error; }
      fail(streamError(error));
    }
  }
  function data(value: unknown): void {
    socket.pause();
    if (!(value instanceof Uint8Array) || value.length > 65536 || input.length !== 0) {
      fail(failure("HPE_INVALID_CHUNK", "Invalid HTTP socket chunk")); return;
    }
    input = new Uint8Array(value); schedule();
  }
  function end(): void { ended = true; schedule(); }
  function error(value: unknown): void { fail(streamError(value)); }
  function close(): void {
    closed = true;
    if (!finished) fail(failure("ECONNRESET", "Socket closed before the HTTP response completed"));
    else { detach(); queueMicrotask(() => parser.close()); }
  }
  function detach(): void {
    socket.pause(); socket.removeListener("data", data); socket.removeListener("end", end);
    socket.removeListener("error", error); socket.removeListener("close", close);
  }
  function release(): void {
    if (retired) return;
    retired = true; detach(); queueMicrotask(() => parser.close());
    handlers.complete(reusable && !ended && !closed && !socket.destroyed && input.length === 0);
  }
  function application<Result>(callback: () => Result): Result {
    try { return callback(); }
    catch (error) { applicationFailed = true; throw error; }
  }
  function retire(error: Error): boolean {
    if (retired) return false;
    retired = true; detach(); queueMicrotask(() => parser.close());
    // IncomingMessage abort also destroys its socket with this same error.
    // The request owner has already received it through handlers.error.
    socket.once("error", () => {});
    incoming?.abort(error); socket.destroy(); return true;
  }
  function fail(error: Error): void {
    if (retire(error)) handlers.error(error);
  }
  socket.on("data", data); socket.on("end", end); socket.on("error", error); socket.once("close", close);
  socket.resume();
  return { abort(error: Error): void { fail(error); } };
}
function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
