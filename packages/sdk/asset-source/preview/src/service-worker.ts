/// <reference lib="webworker" />
// The preview worker of one preview origin. A session origin (<session>.<preview host>) serves
// its one session; the shared address (ADR 0015) serves the session that attached last. Keeper
// documents attach the network transport; every same-origin request outside /__oxidevm/ is
// proxied to the guest listener through the transport of its page's session.
import { HtmlInjector, pageScripts } from "./worker/html-injector";
import {
  cookieRefusalHeader, disconnectedPage, isParentOrigin, movedPage, pageContentSecurityPolicy, startingPage, unavailableResponse,
  upstreamFailure, upstreamLateResponse, unsupportedRequestBodyResponse,
} from "./worker/policy";
import { SessionRegistry, workerScope, type SessionStore } from "./worker/sessions";
import { HEAD_WAIT_MS, RequestInbox, SessionTransport, type KeeperDirectory } from "./worker/transport";
import { previewRequestBody } from "./worker/request-body";

const scopeValue: unknown = globalThis;
if (!(scopeValue instanceof ServiceWorkerGlobalScope)) throw new TypeError("preview Service Worker requires worker scope");
const scope = scopeValue;
const SESSION = /^[a-f0-9]{32}$/;
const BOOTSTRAP_PREFIX = "/__oxidevm/";
const SESSION_CACHE = "oxidevm-preview-session";

const registry = new SessionRegistry(workerScope(scope.location.hostname), (session) => new SessionTransport(session, keeperDirectory()), sessionStore());

scope.addEventListener("install", (event) => event.waitUntil(scope.skipWaiting()));
scope.addEventListener("activate", (event) => event.waitUntil(scope.clients.claim()));

scope.addEventListener("message", (event) => {
  const message: unknown = event.data;
  if (!isRecord(message) || typeof message["kind"] !== "string") return;
  const session = message["session"];
  if (message["kind"] === "attach" && exactKeys(message, ["kind", "session", "port", "acknowledgement", "parentOrigin"]) && isSession(session)) {
    const port: unknown = message["port"];
    const acknowledgement: unknown = message["acknowledgement"];
    const parent: unknown = message["parentOrigin"];
    const keeper = event.source;
    if (!(port instanceof MessagePort) || !(acknowledgement instanceof MessagePort) || !isParentOrigin(parent) || !(keeper instanceof Client)) return;
    event.waitUntil(registry.attach(session, port, keeper.id, parent).then((result) => {
      acknowledgement.postMessage({ kind: result, session });
      acknowledgement.close();
    }));
    return;
  }
  if (message["kind"] === "ping" && exactKeys(message, ["kind", "session", "acknowledgement"]) && isSession(session) && message["acknowledgement"] instanceof MessagePort) {
    const acknowledgement = message["acknowledgement"];
    event.waitUntil(registry.status(session).then((status) => {
      acknowledgement.postMessage({ kind: "pong", session, ...status });
      acknowledgement.close();
    }));
    return;
  }
  if (message["kind"] === "retire" && exactKeys(message, ["kind", "session"]) && isSession(session)) {
    event.waitUntil(registry.retire(session));
    return;
  }
  if (message["kind"] === "websocket" && exactKeys(message, ["kind", "port", "path", "protocols"]) && message["port"] instanceof MessagePort) {
    // A page's WebSocket bridge: forwarded to a live transport of the sending page's session.
    const port = message["port"];
    const path = message["path"];
    const protocols = message["protocols"];
    const page = event.source;
    if (!(page instanceof Client) || typeof path !== "string" || !Array.isArray(protocols)) { port.close(); return; }
    event.waitUntil(registry.route(page.id).then(async (route) => {
      const target = route.kind === "session" ? await route.transport.acquire() : null;
      if (target === null) port.close();
      else target.postMessage({ kind: "websocket", port, path, protocols }, [port]);
    }));
  }
});

scope.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== scope.location.origin) return;
  if (url.pathname.startsWith(BOOTSTRAP_PREFIX)) return;
  event.respondWith(serve(event, url));
});

async function serve(event: FetchEvent, url: URL): Promise<Response> {
  const request = event.request;
  const navigate = request.mode === "navigate";
  const route = await registry.route(navigate || event.clientId === "" ? null : event.clientId);
  switch (route.kind) {
    case "retired": return unavailable("retired");
    case "moved": return navigate ? movedPage(await registry.parent()) : unavailable("moved");
    case "none": return withoutTransport(request);
    case "session": {
      // A navigation opens a page in the current session; its requests stay with that session.
      if (navigate && event.resultingClientId !== "") registry.bind(event.resultingClientId, route.session);
      const port = await route.transport.acquire();
      if ((await registry.status(route.session)).retired) return unavailable("retired");
      if (port === null) return withoutTransport(request);
      return proxy(request, `${url.pathname}${url.search}`, port, route.transport);
    }
  }
}

async function unavailable(reason: "retired" | "moved" | "session"): Promise<Response> {
  return unavailableResponse(reason, await registry.parent());
}

/** No keeper holds a transport: a page learns the Playground is gone, anything else gets 503. */
async function withoutTransport(request: Request): Promise<Response> {
  return request.mode === "navigate" ? disconnectedPage(await registry.parent()) : unavailable("session");
}

/** A session's keeper documents: window clients at /__oxidevm/?session=<session>. */
function keeperDirectory(): KeeperDirectory {
  return {
    keepers: async (wanted) => (await scope.clients.matchAll({ type: "window", includeUncontrolled: true })).filter((client) => {
      const url = new URL(client.url);
      return url.pathname === BOOTSTRAP_PREFIX && url.searchParams.get("session") === wanted;
    }),
    isOpen: async (id) => (await scope.clients.get(id)) !== undefined,
  };
}

/** The registry's records in Cache Storage under /__oxidevm/: the current session and its
 * parent, and one retired marker per session ("retired" on a session origin). */
function sessionStore(): SessionStore {
  const url = (name: string): string => `${scope.location.origin}${BOOTSTRAP_PREFIX}${name}`;
  const cache = (): Promise<Cache> => scope.caches.open(SESSION_CACHE);
  return {
    readCurrent: async () => {
      try {
        const stored = await (await cache()).match(url("current"));
        if (stored === undefined) return null;
        const value: unknown = JSON.parse(await stored.text());
        return value;
      } catch { return null; }
    },
    writeCurrent: async (current) => {
      try { await (await cache()).put(url("current"), new Response(JSON.stringify(current))); } catch { /* Memory keeps it for this worker's life. */ }
    },
    isRetired: async (key) => {
      try { return (await (await cache()).match(url(key))) !== undefined; } catch { return false; }
    },
    markRetired: async (key) => {
      try { await (await cache()).put(url(key), new Response("retired")); } catch { /* Memory keeps it for this worker's life. */ }
    },
  };
}

async function proxy(request: Request, path: string, port: MessagePort, transport: SessionTransport): Promise<Response> {
  let requestBody: ReadableStream<Uint8Array> | null;
  try { requestBody = previewRequestBody(request); }
  catch { return unsupportedRequestBodyResponse(await registry.parent()); }
  const channel = new MessageChannel();
  const signal = request.mode === "navigate" ? new AbortController().signal : request.signal;
  const inbox = new RequestInbox(channel.port1, signal);
  const headers = [...request.headers].filter(([name]) => name.toLowerCase() !== "host");
  const client = await requestContext(request);
  port.postMessage({ kind: "request", port: channel.port2, method: request.method, path, headers, hasBody: requestBody !== null, client }, [channel.port2]);
  const responseHead = inbox.responseHead(sendBody(requestBody, channel.port1, inbox));
  // A guest server may take long to answer (a first Next.js compile). The wait ends when the
  // keeper holding the transport closes, or after HEAD_WAIT_MS, before the browser would stop
  // this worker: the request is cancelled and a page says the app is still starting.
  const watched = await transport.whileAlive(responseHead, HEAD_WAIT_MS);
  if (watched.kind === "lost") {
    inbox.close();
    return withoutTransport(request);
  }
  if (watched.kind === "late") {
    channel.port1.postMessage({ kind: "cancel" });
    inbox.close();
    const parent = await registry.parent();
    return request.mode === "navigate" ? startingPage(parent) : upstreamLateResponse(parent);
  }
  const head = watched.value;
  if (!isHead(head)) {
    inbox.close();
    return upstreamFailure(errorPhase(head), request.mode === "navigate", await registry.parent());
  }
  const html = head.headers.some(([name, value]) => name.toLowerCase() === "content-type" && value.toLowerCase().startsWith("text/html"));
  const cookies = head.cookies;
  const refused = cookies.length === 0 ? 0 : await applyBrowserCookies(cookies);
  const parent = await registry.parent();
  const injector = html ? new HtmlInjector(pageScripts(parent)) : undefined;
  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const message = await inbox.next();
      if (isData(message)) {
        const bytes = injector === undefined ? message.bytes : injector.push(message.bytes);
        if (bytes.byteLength !== 0) controller.enqueue(bytes);
        channel.port1.postMessage({ kind: "response-ack", sequence: message.sequence });
      } else if (isEmptyMessage(message, "end")) {
        const tail = injector?.finish();
        if (tail !== undefined && tail.byteLength !== 0) controller.enqueue(tail);
        controller.close();
        inbox.close();
      } else {
        controller.error(new TypeError("preview response failed"));
        inbox.close();
      }
    },
    cancel: () => {
      channel.port1.postMessage({ kind: "cancel" });
      inbox.close();
    },
  });
  const responseHeaders = new Headers(head.headers.filter(([name]) => !STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())));
  if (html) responseHeaders.delete("content-length");
  responseHeaders.set("Content-Security-Policy", pageContentSecurityPolicy(parent));
  for (const [name, value] of Object.entries(cookieRefusalHeader(refused))) responseHeaders.set(name, value);
  responseHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
  responseHeaders.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  responseHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
  responseHeaders.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  responseHeaders.set("Referrer-Policy", "no-referrer");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(request.method === "HEAD" ? null : body, { status: head.status, statusText: head.statusText, headers: responseHeaders });
}

const STRIPPED_RESPONSE_HEADERS = new Set(["set-cookie", "set-cookie2", "clear-site-data", "strict-transport-security", "x-frame-options", "alt-svc", "report-to", "content-security-policy", "content-security-policy-report-only", "cross-origin-embedder-policy", "cross-origin-opener-policy", "cross-origin-resource-policy", "permissions-policy", "referrer-policy", "connection", "keep-alive", "transfer-encoding"]);

/** Where the request comes from, for SameSite evaluation in the network jar:
 * a top-level document, an embedded frame (with its embedder's origin), or a
 * worker. Decoded from the client, never from the request. */
async function requestContext(request: Request): Promise<{ readonly frame: "top" | "nested" | "none"; readonly ancestor: string | null; readonly navigate: boolean }> {
  const navigate = request.mode === "navigate";
  const clients = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
  const url = request.referrer !== "" && URL.canParse(request.referrer) ? new URL(request.referrer) : undefined;
  const client = clients.find((candidate) => url !== undefined && candidate.url === url.href) ?? clients[0];
  if (client === undefined) return { frame: "none", ancestor: null, navigate };
  const frame = client.frameType === "nested" ? "nested" : client.frameType === "top-level" || client.frameType === "auxiliary" ? "top" : "none";
  const ancestors: unknown = Reflect.get(client, "ancestorOrigins");
  const ancestor = Array.isArray(ancestors) && typeof ancestors[0] === "string" ? ancestors[0] : null;
  return { frame, ancestor, navigate };
}

/** Non-HttpOnly cookies live only in the browser's store: the network jar
 * decides which Set-Cookie results reach the page and hands them over here.
 * Returns how many the browser refused (all of them without a cookie store). */
async function applyBrowserCookies(cookies: readonly BrowserCookie[]): Promise<number> {
  const store: unknown = Reflect.get(scope, "cookieStore");
  if (!isRecord(store) || typeof store["set"] !== "function" || typeof store["delete"] !== "function") return cookies.length;
  let refused = 0;
  for (const cookie of cookies) {
    try {
      if (cookie.value === null) await Reflect.apply(store["delete"], store, [{ name: cookie.name, path: cookie.path }]);
      else await Reflect.apply(store["set"], store, [{ name: cookie.name, value: cookie.value, path: cookie.path, sameSite: cookie.sameSite, ...(cookie.expires === null ? {} : { expires: cookie.expires }) }]);
    } catch {
      // A refused cookie stays out of the browser; the jar already recorded the decision.
      refused += 1;
    }
  }
  return refused;
}

interface BrowserCookie { readonly name: string; readonly value: string | null; readonly path: string; readonly sameSite: "strict" | "lax" | "none"; readonly expires: number | null }

async function sendBody(body: ReadableStream<Uint8Array> | null, port: MessagePort, inbox: RequestInbox): Promise<void> {
  let sequence = 1;
  if (body !== null) {
    for await (const source of body) {
      for (let offset = 0; offset < source.byteLength; offset += 64 * 1024) {
        const bytes = source.slice(offset, offset + 64 * 1024);
        port.postMessage({ kind: "body", sequence, bytes }, [bytes.buffer]);
        const acknowledgement = await inbox.next();
        if (!isSequence(acknowledgement, "body-ack", sequence)) throw new TypeError("preview request acknowledgement failed");
        sequence++;
      }
    }
  }
  port.postMessage({ kind: "end", sequence });
}

function isSession(value: unknown): value is string {
  return typeof value === "string" && SESSION.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isKind(value: unknown, kind: string): value is Record<string, unknown> {
  return isRecord(value) && "kind" in value && value["kind"] === kind;
}

function isSequence(value: unknown, kind: string, sequence: number): boolean {
  return isKind(value, kind) && exactKeys(value, ["kind", "sequence"]) && Number.isInteger(value["sequence"]) && value["sequence"] === sequence;
}

function isHead(value: unknown): value is { readonly status: number; readonly statusText: string; readonly headers: Array<[string, string]>; readonly cookies: BrowserCookie[] } {
  if (!isKind(value, "response") || !exactKeys(value, ["kind", "status", "statusText", "headers", "cookies"]) || typeof value["status"] !== "number" || !Number.isInteger(value["status"]) || value["status"] < 100 || value["status"] > 599 || typeof value["statusText"] !== "string" || !Array.isArray(value["headers"]) || !Array.isArray(value["cookies"])) return false;
  return value["headers"].every((header: unknown): header is [string, string] =>
    Array.isArray(header) && header.length === 2 && typeof header[0] === "string" && typeof header[1] === "string"
      && /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(header[0]) && !/[\r\n]/.test(header[1]))
    && value["cookies"].every((cookie: unknown): cookie is BrowserCookie => isRecord(cookie) && exactKeys(cookie, ["name", "value", "path", "sameSite", "expires"])
      && typeof cookie["name"] === "string" && (cookie["value"] === null || typeof cookie["value"] === "string") && typeof cookie["path"] === "string"
      && (cookie["sameSite"] === "strict" || cookie["sameSite"] === "lax" || cookie["sameSite"] === "none") && (cookie["expires"] === null || typeof cookie["expires"] === "number"));
}

function isData(value: unknown): value is { readonly sequence: number; readonly bytes: Uint8Array } {
  return isKind(value, "data") && exactKeys(value, ["kind", "sequence", "bytes"]) && typeof value["sequence"] === "number" && Number.isInteger(value["sequence"]) && value["sequence"] > 0
    && value["bytes"] instanceof Uint8Array && value["bytes"].byteLength <= 64 * 1024;
}

function isEmptyMessage(value: unknown, kind: string): boolean {
  return isKind(value, kind) && exactKeys(value, ["kind"]);
}

function errorPhase(value: unknown): string | undefined {
  if (!isKind(value, "error") || !exactKeys(value, ["kind", "code", "reason"])) return undefined;
  const code = value["code"];
  const reason = value["reason"];
  const validCode = code === "open" || code === "request-head" || code === "request-body" || code === "request-end" || code === "response-read" || code === "response-parse" || code === "response-body";
  const validReason = reason === "listener" || reason === "process" || reason === "staging" || reason === "write" || reason === "read" || reason === "close" || reason === "abort" || reason === "channel";
  return validCode && validReason ? `${code}:${reason}` : undefined;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
