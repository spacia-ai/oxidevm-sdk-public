import type { AsyncContext } from "./async-context.js";
import { HttpParser, HttpParseError } from "./http-parser.js";
import { createIncomingMessage } from "./node-http-incoming.js";
import type { createHttpResponses } from "./node-http-response.js";
import type { NodeSocket } from "./node-socket.js";

type Incoming = ReturnType<typeof createIncomingMessage>;
type ResponseConstructor = ReturnType<typeof createHttpResponses>["ServerResponse"];
type Response = InstanceType<ResponseConstructor>;
type Handlers = {
  readonly Response: ResponseConstructor;
  request(request: Incoming["message"], response: Response): void;
  upgrade(request: Incoming["message"], socket: NodeSocket, head: Uint8Array): boolean;
  clientError(error: Error): boolean | undefined;
  timeout?(): boolean;
  idle?(): boolean;
  active?(): void;
  closed(): void;
};

/** The socket and Readable own buffering. This owner retains only the current
 * bounded socket chunk and at most eight overlapping response lifetimes. */
export function createHttpConnection(socket: NodeSocket, module: WebAssembly.Module, context: AsyncContext, handlers: Handlers) {
  let input = new Uint8Array();
  let current: Incoming | undefined;
  let upgrade: Incoming | undefined;
  let previous = Promise.resolve();
  const responses = new Set<Response>();
  let paused = false; let bodyBlocked = false; let scheduled = false;
  let ended = false; let retired = false; let handedOff = false; let closing = false; let keepAliveWaiting = false;
  const parser = new HttpParser(module, { kind: "request",
    headers(head) {
      const incoming = createIncomingMessage(socket, head, () => { bodyBlocked = false; schedule(); }, context);
      current = incoming;
      if (head.upgrade) { upgrade = current; return; }
      const response = new handlers.Response(socket, head, previous);
      responses.add(response); previous = response.completion;
      response.on("error", () => socket.destroy());
      void response.completion.then(() => {
        incoming.message.discardUnconsumed();
        responses.delete(response);
        settleIdle(); schedule();
      }, () => { responses.delete(response); socket.destroy(); });
      handlers.request(current.message, response);
    },
    body(bytes) {
      if (current === undefined) throw new Error("HTTP body lacks a request");
      bodyBlocked = !current.body(bytes); return !bodyBlocked;
    },
    complete(trailers) {
      if (current === undefined) throw new Error("HTTP completion lacks a request");
      current.finish(trailers); current = undefined;
      return responses.size < 8;
    },
  });
  function schedule(): void {
    if (scheduled || retired || handedOff) return;
    scheduled = true; queueMicrotask(() => { scheduled = false; pump(); });
  }
  function pump(): void {
    if (retired || handedOff || socket.destroyed) return;
    try {
      const resuming = paused;
      if (paused) {
        if (bodyBlocked || responses.size >= 8) return;
        parser.resume(); paused = false;
      }
      if (input.length !== 0 || resuming) {
        const result = parser.feed(input);
        input = input.slice(result.consumed);
        if (result.state === "upgrade") {
          if (upgrade === undefined) throw new Error("HTTP upgrade lacks a request");
          handedOff = true; detach(); parser.close();
          socket.resume();
          if (!handlers.upgrade(upgrade.message, socket, input)) socket.destroy();
          input = new Uint8Array(); return;
        }
        paused = result.state === "paused";
        if (paused) return;
      }
      if (!ended) settleIdle();
      if (ended) {
        parser.finish();
        if (responses.size === 0) socket.end();
      } else socket.resume();
    } catch (error) {
      retired = true; detach();
      if (error instanceof HttpParseError) {
        if (handlers.clientError(error) !== true) socket.destroy();
      } else { socket.destroy(); throw error; }
    }
  }
  function data(value: unknown): void {
    if (!(value instanceof Uint8Array) || value.length > 65536 || input.length !== 0) throw new Error("Invalid HTTP socket chunk");
    socket.pause();
    if (keepAliveWaiting) { keepAliveWaiting = false; handlers.active?.(); }
    input = new Uint8Array(value); schedule();
  }
  function end(): void { ended = true; schedule(); }
  function detach(): void { socket.removeListener("data", data); socket.removeListener("end", end); }
  socket.on("data", data); socket.on("end", end);
  socket.on("timeout", () => {
    if (handedOff || socket.destroyed) return;
    const requestHandled = !retired && current !== undefined && !current.message.complete && current.message.emit("timeout", socket);
    const responseHandled = responses.values().next().value?.emit("timeout", socket) ?? false;
    const serverHandled = handlers.timeout?.() ?? false;
    if (!requestHandled && !responseHandled && !serverHandled) socket.destroy();
  });
  socket.on("error", (error: unknown) => {
    if (!handedOff && error instanceof Error) handlers.clientError(error);
  });
  socket.once("close", () => {
    retired = true; detach();
    // Stream close can originate inside a parser callback. Free its Wasm state
    // only after that callback and llhttp_execute have returned.
    queueMicrotask(() => {
      parser.close(); current?.abort();
      for (const response of responses) response.destroy();
      responses.clear(); handlers.closed();
    });
  });
  function settleIdle(): void {
    if (!idle() || ended || retired || socket.destroyed) return;
    if (closing) socket.destroy();
    else if (!keepAliveWaiting) keepAliveWaiting = handlers.idle?.() ?? false;
  }
  function idle(): boolean { return !handedOff && !parser.inMessage && current === undefined && input.length === 0 && responses.size === 0; }
  return {
    get idle(): boolean { return idle(); },
    closeWhenIdle(): void { closing = true; if (idle()) socket.destroy(); },
    closeIdle(): void { if (this.idle) socket.destroy(); },
  };
}
