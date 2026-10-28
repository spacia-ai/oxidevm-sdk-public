import { Buffer } from "buffer";
import { Readable } from "readable-stream";
import type { AsyncContext } from "./async-context.js";
import type { HttpRequestHead, HttpResponseHead } from "./http-parser.js";
import type { NodeSocket } from "./node-socket.js";
import { bindAsyncEvents, isEventListener } from "./node-streams.js";

type Fields = readonly (readonly [string, string])[];
const singleHeaders = new Set(["age", "authorization", "content-length", "content-type", "etag", "expires", "from", "host", "if-modified-since", "if-unmodified-since", "last-modified", "location", "max-forwards", "proxy-authorization", "referer", "retry-after", "server", "user-agent"]);

export class IncomingMessage extends Readable {
  readonly socket: NodeSocket;
  readonly method: string | null;
  readonly statusCode: number | null;
  readonly statusMessage: string | null;
  readonly url: string;
  readonly httpVersion: string;
  readonly httpVersionMajor: number;
  readonly httpVersionMinor: number;
  readonly headers: Record<string, string | string[]>;
  readonly headersDistinct: Record<string, string[]>;
  readonly rawHeaders: string[];
  trailers: Record<string, string | string[]> = {};
  trailersDistinct: Record<string, string[]> = {};
  rawTrailers: string[] = [];
  complete = false;
  aborted = false;
  #consuming = false;

  constructor(socket: NodeSocket, head: HttpRequestHead | HttpResponseHead, resume: () => void, context: AsyncContext) {
    super({ highWaterMark: 65536, autoDestroy: true, read: () => {
      this.#consuming = true; this._readableState.readingMore = false; resume();
    },
      destroy: (error, done) => {
        if (!this.complete && !this.aborted) {
          this.aborted = true; this.emit("aborted");
          if (!socket.destroyed) socket.destroy(error ?? undefined);
        }
        // Node's IncomingMessage reports an abort error only to registered
        // error listeners; ordinary disconnected clients cannot crash a server.
        done(this.listenerCount("error") === 0 ? undefined : error);
      },
    });
    // Incoming bytes are pushed by the parser. Suppress the pinned stream's
    // speculative reads until the application actually starts consuming them.
    this._readableState.readingMore = true;
    Object.setPrototypeOf(this.trailers, null); Object.setPrototypeOf(this.trailersDistinct, null);
    this.socket = socket;
    this.method = "method" in head ? head.method : null;
    this.url = "url" in head ? head.url : "";
    this.statusCode = "statusCode" in head ? head.statusCode : null;
    this.statusMessage = "statusMessage" in head ? head.statusMessage : null;
    this.httpVersionMajor = head.major; this.httpVersionMinor = head.minor;
    this.httpVersion = `${head.major}.${head.minor}`;
    this.headersDistinct = distinct(head.headers);
    this.headers = joined(this.headersDistinct);
    this.rawHeaders = head.headers.flat();
    bindAsyncEvents(this, context);
  }
  get connection(): NodeSocket { return this.socket; }
  setTimeout(duration: unknown, callback?: unknown): this {
    if (callback !== undefined) {
      if (!isEventListener(callback)) throw new TypeError("IncomingMessage timeout requires a callback");
      this.on("timeout", callback);
    }
    this.socket.setTimeout(duration); return this;
  }
  discardUnconsumed(): void {
    if (!this.#consuming && !this._readableState.resumeScheduled) {
      this.removeAllListeners("data"); this.resume();
    }
  }
}

/** Parser callbacks retain no body queue. The pinned Readable is the one owner
 * of body buffering; a false push tells the connection owner to pause parsing. */
export function createIncomingMessage(socket: NodeSocket, head: HttpRequestHead | HttpResponseHead, resume: () => void, context: AsyncContext) {
  const message = new IncomingMessage(socket, head, resume, context);
  return {
    message,
    body(bytes: Uint8Array): boolean {
      if (message.complete || message.destroyed) throw new Error("HTTP message body received after retirement");
      return message.push(Buffer.from(bytes));
    },
    finish(trailers: Fields): void {
      if (message.complete || message.destroyed) throw new Error("HTTP message completion received after retirement");
      message.trailersDistinct = distinct(trailers); message.trailers = joined(message.trailersDistinct);
      message.rawTrailers = trailers.flat(); message.complete = true;
      message.push(null); message.read(0);
    },
    abort(error?: Error): void {
      if (!message.complete && !message.destroyed) message.destroy(error);
    },
  };
}

function distinct(fields: Fields): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  Object.setPrototypeOf(result, null);
  for (const [name, value] of fields) (result[name.toLowerCase()] ??= []).push(value);
  return result;
}
function joined(fields: Record<string, string[]>): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  Object.setPrototypeOf(result, null);
  for (const [name, values] of Object.entries(fields)) {
    if (name === "set-cookie") result[name] = [...values];
    else if (singleHeaders.has(name)) {
      const first = values[0];
      if (first !== undefined) result[name] = first;
    } else result[name] = values.join(name === "cookie" ? "; " : ", ");
  }
  return result;
}
