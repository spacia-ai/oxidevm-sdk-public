import type { AsyncContext } from "./async-context.js";
import { isEventListener } from "./node-streams.js";
import type { ProcessScheduler } from "./process-scheduler.js";
import { HTTP2_CONSTANTS, HTTP2_DEFAULT_SETTINGS } from "./node-http2-constants.js";
import { Http2Bridge, type Http2Children } from "./node-http2-bridge.js";
import { http2Options, http2Authority } from "./node-http2-options.js";
import { Http2Session } from "./node-http2-session.js";
import { Http2Server } from "./node-http2-server.js";
import { Http2ServerRequest, Http2ServerResponse } from "./node-http2-compat.js";
import { http2Failure } from "./node-http2-wire.js";

export function createNodeHttp2(children: Http2Children, context: AsyncContext, retain: () => () => void, scheduler?: ProcessScheduler) {
  return {
    constants: Object.freeze(HTTP2_CONSTANTS), getDefaultSettings: () => ({ ...HTTP2_DEFAULT_SETTINGS }),
    Http2ServerRequest, Http2ServerResponse,
    connect(authority: unknown, options: unknown = {}, listener?: unknown): Http2Session {
      if (typeof options === "function") { listener = options; options = {}; }
      const address = http2Authority(authority), configuration = http2Options(options);
      if (listener !== undefined && !isEventListener(listener)) throw new TypeError("HTTP/2 connect requires a callback");
      const session = new Http2Session(1, context, false, retain);
      if (listener !== undefined) session.once("connect", listener);
      try {
        session.bridge = new Http2Bridge(children, { role: "client", authority: address, options: configuration }, {
          event: event => { if (!("session" in event) || event.session !== session.key) throw http2Failure("ERR_HTTP2_BRIDGE_PROTOCOL", "Invalid client session identity"); session.receive(event); },
          data: (key, stream, bytes) => { if (key !== session.key) throw http2Failure("ERR_HTTP2_BRIDGE_PROTOCOL", "Invalid HTTP/2 body identity"); session.data(stream, bytes); },
          retired: error => session.retire(error),
        }, scheduler);
      } catch (error) { session.unref(); throw error; }
      return session;
    },
    createServer(options: unknown = {}, listener?: unknown): Http2Server {
      if (typeof options === "function") { listener = options; options = {}; }
      return new Http2Server({ children, context, retain, ...(scheduler === undefined ? {} : { scheduler }) }, false, http2Options(options), listener);
    },
    createSecureServer(options: unknown = {}, listener?: unknown): Http2Server {
      if (typeof options === "function") { listener = options; options = {}; }
      return new Http2Server({ children, context, retain, ...(scheduler === undefined ? {} : { scheduler }) }, true, http2Options(options), listener);
    },
  };
}
