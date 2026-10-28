import { decodeRequest, decodeWebSocketRequest, encodeHead, encodeUpgradeHead, parseHead, rewriteResponseHeaders, HOP_HEADERS, MAX_HEADER_BYTES, RESPONSE_STRIP_HEADERS, type PreviewRequest, type PreviewWebSocketRequest } from "./preview-http-codec.js";
import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import type {
  PreviewRuntimeCompletion,
  PreviewRuntimeErrorCode,
  PreviewRuntimeOperation,
  PreviewTarget,
} from "./preview-runtime-channel.js";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const OPEN_TIMEOUT_MS = 5_000;

export interface PreviewRuntimePort {
  request(operation: PreviewRuntimeOperation, signal?: AbortSignal): Promise<PreviewRuntimeCompletion>;
}

/** A session's forwarding identity and cookie custody. The guest always sees a
 * localhost client (preview-http-codec); without an origin no URL is mapped and
 * cookies pass through untouched. */
export interface PreviewSessionOptions {
  readonly origin?: URL;
  readonly jar?: PreviewCookieJar;
}
import type { PreviewCookieJar } from "./preview-cookies.js";

export function servePreviewSession(session: MessagePort, guestPort: number, runtime: PreviewRuntimePort, options: PreviewSessionOptions = {}): () => void {
  const controllers = new Set<AbortController>();
  session.onmessage = (event: MessageEvent<unknown>) => {
    let request: PreviewRequest | PreviewWebSocketRequest;
    try {
      request = isMessageKind(event.data, "websocket") ? decodeWebSocketRequest(event.data) : decodeRequest(event.data);
    } catch {
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const operation = "protocols" in request
      ? proxyWebSocket(request, guestPort, runtime, controller.signal, options)
      : proxy(request, guestPort, runtime, controller.signal, options);
    void operation.finally(() => controllers.delete(controller));
  };
  session.start();
  return () => {
    for (const controller of controllers) controller.abort();
    controllers.clear();
    session.close();
  };
}

async function proxy(request: PreviewRequest, guestPort: number, runtime: PreviewRuntimePort, sessionSignal: AbortSignal, options: PreviewSessionOptions): Promise<void> {
  // The preview worker cancels a request at any point, also while the guest has not answered
  // (it must answer its fetch event in time); the guest connection then closes.
  const cancelled = new AbortController();
  const signal = AbortSignal.any([sessionSignal, cancelled.signal]);
  const inbox = new PortInbox(request.port, signal, () => { cancelled.abort(); });
  let target: PreviewTarget | undefined;
  let phase: PreviewFailurePhase = "open";
  try {
    target = await open(runtime, guestPort, signal);
    phase = "request-head";
    const browserCookie = request.headers.find(([name]) => name === "cookie")?.[1];
    const cookie = options.jar === undefined ? browserCookie : options.jar.cookieHeader(request.path, request.client, browserCookie);
    await writeAll(runtime, target, encodeHead(request, guestPort, {
      ...(options.origin === undefined ? {} : { origin: options.origin }), ...(cookie === undefined ? {} : { cookie }),
    }), signal);
    let requestBytes = 0;
    let sequence = 1;
    for (;;) {
      const message = await inbox.next();
      if (message.kind === "cancel") throw new VMError("ABORTED", "preview request cancelled");
      if (message.sequence !== sequence++) throw new VMError("PROTOCOL_ERROR", "preview body sequence is invalid");
      if (message.kind === "end") {
        phase = "request-end";
        if (request.hasBody) await writeAll(runtime, target, new TextEncoder().encode("0\r\n\r\n"), signal);
        break;
      }
      if (message.kind !== "body") throw new VMError("PROTOCOL_ERROR", "unexpected preview body message");
      phase = "request-body";
      requestBytes += message.bytes.byteLength;
      if (requestBytes > MAX_REQUEST_BYTES) throw new VMError("QUOTA_EXCEEDED", "preview request body is too large");
      await writeAll(runtime, target, request.hasBody ? chunk(message.bytes) : message.bytes, signal);
      request.port.postMessage({ kind: "body-ack", sequence: message.sequence });
    }
    await streamResponse(runtime, target, request, inbox, signal, { guestPort, ...options }, (next) => {
      phase = next;
    });
  } catch (error) {
    request.port.postMessage({
      kind: "error",
      code: phase,
      reason: error instanceof PreviewRuntimeFailure
        ? error.code
        : error instanceof VMError && error.code === "ABORTED"
          ? "abort"
          : "channel",
    });
  } finally {
    inbox.close();
    if (target !== undefined) await runtime.request({ kind: "close", ...target }).catch(() => undefined);
    request.port.close();
  }
}

async function proxyWebSocket(request: PreviewWebSocketRequest, guestPort: number, runtime: PreviewRuntimePort, signal: AbortSignal, options: PreviewSessionOptions): Promise<void> {
  const done = new AbortController();
  const operationSignal = AbortSignal.any([signal, done.signal]);
  const inbox = new WebSocketInbox(request.port, operationSignal);
  let target: PreviewTarget | undefined;
  let opened = false;
  try {
    target = await open(runtime, guestPort, operationSignal);
    const keyBytes = crypto.getRandomValues(new Uint8Array(16));
    const key = btoa(String.fromCharCode(...keyBytes));
    await writeAll(runtime, target, encodeUpgradeHead(request, guestPort, key, options), operationSignal);
    const guest = new GuestBytes(runtime, target, operationSignal);
    const response = parseHead(await guest.until(new Uint8Array([13, 10, 13, 10]), MAX_HEADER_BYTES));
    const selected = response.headers.find(([name]) => name === "sec-websocket-protocol")?.[1] ?? "";
    const accept = response.headers.find(([name]) => name === "sec-websocket-accept")?.[1];
    const connection = response.headers.find(([name]) => name === "connection")?.[1].toLowerCase().split(",").map((value) => value.trim());
    if (response.status !== 101 || response.headers.find(([name]) => name === "upgrade")?.[1].toLowerCase() !== "websocket" || connection?.includes("upgrade") !== true || accept !== await websocketAccept(key) || (selected !== "" && !request.protocols.includes(selected))) {
      throw new VMError("PROTOCOL_ERROR", "invalid preview WebSocket upgrade");
    }
    opened = true;
    request.port.postMessage({ kind: "open", protocol: selected });
    const openedTarget = target;
    let writes = Promise.resolve();
    const write = (bytes: Uint8Array) => {
      writes = writes.then(() => writeAll(runtime, openedTarget, bytes, operationSignal));
      return writes;
    };
    await Promise.race([
      receiveWebSocketFrames(guest, request.port, write),
      sendWebSocketFrames(inbox, request.port, write, operationSignal),
    ]);
  } catch {
    request.port.postMessage(opened
      ? { kind: "close", code: 1006, reason: "", clean: false }
      : { kind: "error" });
  } finally {
    done.abort();
    inbox.close();
    if (target !== undefined) await runtime.request({ kind: "close", ...target }).catch(() => undefined);
    request.port.close();
  }
}

async function receiveWebSocketFrames(
  guest: GuestBytes,
  port: MessagePort,
  write: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  let fragmented: { opcode: number; chunks: Uint8Array[]; bytes: number } | undefined;
  for (;;) {
    const head = await guest.exact(2);
    const first = head[0] ?? 0;
    const second = head[1] ?? 0;
    const final = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    if ((first & 0x70) !== 0 || (second & 0x80) !== 0) throw new VMError("PROTOCOL_ERROR", "invalid preview WebSocket frame");
    let length = second & 0x7f;
    if (length === 126) {
      const extended = await guest.exact(2);
      length = new DataView(extended.buffer, extended.byteOffset, 2).getUint16(0);
      if (length < 126) throw new VMError("PROTOCOL_ERROR", "noncanonical preview WebSocket frame length");
    } else if (length === 127) {
      const extended = await guest.exact(8);
      const value = new DataView(extended.buffer, extended.byteOffset, 8).getBigUint64(0);
      if (value <= 0xffffn || value > 16n * 1024n * 1024n) throw new VMError("QUOTA_EXCEEDED", "preview WebSocket message length is invalid");
      length = Number(value);
    }
    if (length > 16 * 1024 * 1024 || (opcode >= 8 && (!final || length > 125))) throw new VMError("PROTOCOL_ERROR", "invalid preview WebSocket frame length");
    const payload = await guest.exact(length);
    if (opcode === 8) {
      const close = decodeWebSocketClose(payload);
      await write(encodeWebSocketFrame(8, payload));
      port.postMessage({ kind: "close", ...close, clean: true });
      return;
    }
    if (opcode === 9) {
      await write(encodeWebSocketFrame(10, payload));
      continue;
    }
    if (opcode === 10) continue;
    if (opcode === 0) {
      if (fragmented === undefined) throw new VMError("PROTOCOL_ERROR", "unexpected WebSocket continuation");
      fragmented.chunks.push(payload);
      fragmented.bytes += payload.byteLength;
      if (fragmented.bytes > 16 * 1024 * 1024) throw new VMError("QUOTA_EXCEEDED", "preview WebSocket message is too large");
      if (!final) continue;
      const bytes = concatBytes(fragmented.chunks, fragmented.bytes);
      const type = fragmented.opcode === 1 ? "text" : "binary";
      if (type === "text") new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      port.postMessage({ kind: "message", type, bytes }, [bytes.buffer]);
      fragmented = undefined;
      continue;
    }
    if (opcode !== 1 && opcode !== 2 || fragmented !== undefined) throw new VMError("PROTOCOL_ERROR", "invalid preview WebSocket opcode");
    if (!final) {
      fragmented = { opcode, chunks: [payload], bytes: payload.byteLength };
      continue;
    }
    if (opcode === 1) new TextDecoder("utf-8", { fatal: true }).decode(payload);
    port.postMessage({ kind: "message", type: opcode === 1 ? "text" : "binary", bytes: payload }, [payload.buffer]);
  }
}

async function sendWebSocketFrames(
  inbox: WebSocketInbox,
  port: MessagePort,
  write: (bytes: Uint8Array) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    const message = await inbox.next();
    if (message.kind === "close") {
      const reason = new TextEncoder().encode(message.reason);
      const payload = new Uint8Array(2 + reason.byteLength);
      new DataView(payload.buffer).setUint16(0, message.code);
      payload.set(reason, 2);
      await write(encodeWebSocketFrame(8, payload));
      await delayUntilAbort(signal);
      continue;
    }
    await write(encodeWebSocketFrame(message.type === "text" ? 1 : 2, message.bytes));
    port.postMessage({ kind: "ack", sequence: message.sequence });
  }
}

function delayUntilAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(new VMError("ABORTED", "preview WebSocket closed"));
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new VMError("ABORTED", "preview WebSocket closed")), { once: true }));
}

function encodeWebSocketFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const extra = payload.byteLength < 126 ? 0 : payload.byteLength <= 0xffff ? 2 : 8;
  const frame = new Uint8Array(2 + extra + 4 + payload.byteLength);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | (extra === 0 ? payload.byteLength : extra === 2 ? 126 : 127);
  const view = new DataView(frame.buffer);
  if (extra === 2) view.setUint16(2, payload.byteLength);
  if (extra === 8) view.setBigUint64(2, BigInt(payload.byteLength));
  const maskOffset = 2 + extra;
  const mask = crypto.getRandomValues(frame.subarray(maskOffset, maskOffset + 4));
  for (let index = 0; index < payload.byteLength; index++) frame[maskOffset + 4 + index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  return frame;
}

async function websocketAccept(key: string): Promise<string> {
  const source = new TextEncoder().encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-1", source))));
}

function decodeWebSocketClose(payload: Uint8Array): { readonly code: number; readonly reason: string } {
  if (payload.byteLength === 0) return { code: 1005, reason: "" };
  if (payload.byteLength === 1) throw new VMError("PROTOCOL_ERROR", "invalid preview WebSocket close frame");
  const code = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0);
  const reason = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
  if (!((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999))) throw new VMError("PROTOCOL_ERROR", "invalid preview WebSocket close code");
  return { code, reason };
}

type PreviewFailurePhase = "open" | "request-head" | "request-body" | "request-end" | "response-read" | "response-parse" | "response-body";

class PreviewRuntimeFailure extends Error {
  readonly code: PreviewRuntimeErrorCode;

  constructor(code: PreviewRuntimeErrorCode) {
    super("preview runtime operation failed");
    this.code = code;
  }
}

async function open(
  runtime: PreviewRuntimePort,
  port: number,
  signal: AbortSignal,
): Promise<PreviewTarget> {
  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  let failed: PreviewRuntimeErrorCode = "channel";
  do {
    // The runtime owner resolves the listener task; the proxy never guesses it.
    const opened = await runtime.request({ kind: "open", port, process: null }, signal);
    if (opened.kind === "opened") return { generation: opened.generation, process: opened.process, connection: opened.connection };
    if (opened.kind === "error") failed = opened.code;
    await delay(signal);
  } while (Date.now() < deadline);
  // Why the last attempt failed: `listener` when nothing listens on the port yet.
  throw new PreviewRuntimeFailure(failed);
}

async function streamResponse(
  runtime: PreviewRuntimePort,
  target: PreviewTarget,
  request: PreviewRequest,
  inbox: PortInbox,
  signal: AbortSignal,
  session: PreviewSessionOptions & { readonly guestPort: number },
  setPhase: (phase: PreviewFailurePhase) => void,
): Promise<void> {
  const { method, port } = request;
  const guest = new GuestBytes(runtime, target, signal);
  let response: ReturnType<typeof parseHead>;
  do {
    setPhase("response-read");
    const bytes = await guest.until(new Uint8Array([13, 10, 13, 10]), MAX_HEADER_BYTES);
    setPhase("response-parse");
    response = parseHead(bytes);
  } while (response.status >= 100 && response.status < 200 && response.status !== 101);
  setPhase("response-body");
  const setCookies = response.headers.filter(([name]) => name === "set-cookie").map(([, value]) => value);
  port.postMessage({
    kind: "response",
    status: response.status,
    statusText: response.statusText,
    headers: rewriteResponseHeaders(response.headers.filter(([name]) => !HOP_HEADERS.has(name) && !RESPONSE_STRIP_HEADERS.has(name)), session.guestPort, session.origin),
    cookies: session.jar?.receive(setCookies, request.path) ?? [],
  });
  if (method === "HEAD" || response.status === 204 || response.status === 304) {
    port.postMessage({ kind: "end" });
    return;
  }
  const transfer = response.headers.find(([name]) => name === "transfer-encoding")?.[1].toLowerCase();
  const contentLength = response.headers.find(([name]) => name === "content-length")?.[1];
  let sequence = 1;
  let total = 0;
  const send = async (bytes: Uint8Array): Promise<void> => {
    total += bytes.byteLength;
    if (total > MAX_RESPONSE_BYTES) throw new VMError("QUOTA_EXCEEDED", "preview response is too large");
    port.postMessage({ kind: "data", sequence, bytes }, [bytes.buffer]);
    const acknowledgement = await inbox.next();
    if (acknowledgement.kind !== "response-ack" || acknowledgement.sequence !== sequence++) {
      throw new VMError("PROTOCOL_ERROR", "preview response acknowledgement is invalid");
    }
  };
  if (transfer === "chunked") {
    for (;;) {
      const line = new TextDecoder().decode(await guest.line());
      const sizeText = line.split(";", 1)[0];
      if (sizeText === undefined || !/^[0-9a-fA-F]+$/.test(sizeText)) throw new VMError("PROTOCOL_ERROR", "invalid chunked response");
      const size = Number.parseInt(sizeText, 16);
      if (!Number.isSafeInteger(size) || size > MAX_RESPONSE_BYTES) throw new VMError("QUOTA_EXCEEDED", "preview response chunk is too large");
      if (size === 0) {
        await guest.until(new Uint8Array([13, 10]), MAX_HEADER_BYTES);
        break;
      }
      let remaining = size;
      while (remaining > 0) {
        const bytes = await guest.exact(Math.min(remaining, CHUNK_BYTES));
        remaining -= bytes.byteLength;
        await send(bytes);
      }
      if (!equal(await guest.exact(2), new Uint8Array([13, 10]))) throw new VMError("PROTOCOL_ERROR", "invalid chunk terminator");
    }
  } else if (contentLength !== undefined) {
    if (!/^[0-9]+$/.test(contentLength)) throw new VMError("PROTOCOL_ERROR", "invalid response length");
    let remaining = Number(contentLength);
    if (!Number.isSafeInteger(remaining) || remaining > MAX_RESPONSE_BYTES) throw new VMError("QUOTA_EXCEEDED", "preview response is too large");
    while (remaining > 0) {
      const bytes = await guest.exact(Math.min(remaining, CHUNK_BYTES));
      remaining -= bytes.byteLength;
      await send(bytes);
    }
  } else {
    for await (const bytes of guest) await send(bytes);
  }
  port.postMessage({ kind: "end" });
}

class GuestBytes implements AsyncIterable<Uint8Array> {
  readonly #runtime: PreviewRuntimePort;
  readonly #target: PreviewTarget;
  readonly #signal: AbortSignal;
  #buffer = new Uint8Array();

  constructor(runtime: PreviewRuntimePort, target: PreviewTarget, signal: AbortSignal) {
    this.#runtime = runtime;
    this.#target = target;
    this.#signal = signal;
  }

  async exact(length: number): Promise<Uint8Array> {
    while (this.#buffer.byteLength < length) {
      const next = await this.#read();
      if (next === null) throw new VMError("PROTOCOL_ERROR", "preview response ended early");
      this.#append(next);
    }
    return this.#take(length);
  }

  async until(marker: Uint8Array, maximum: number): Promise<Uint8Array> {
    for (;;) {
      const offset = indexOf(this.#buffer, marker);
      if (offset >= 0) return this.#take(offset + marker.byteLength);
      if (this.#buffer.byteLength >= maximum) throw new VMError("QUOTA_EXCEEDED", "preview response headers are too large");
      const next = await this.#read();
      if (next === null) throw new VMError("PROTOCOL_ERROR", "preview response ended before headers");
      this.#append(next);
    }
  }

  line(): Promise<Uint8Array> {
    return this.until(new Uint8Array([13, 10]), MAX_HEADER_BYTES).then((line) => line.slice(0, -2));
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.#buffer.byteLength !== 0) yield this.#take(this.#buffer.byteLength);
    for (;;) {
      const next = await this.#read();
      if (next === null) return;
      yield next;
    }
  }

  async #read(): Promise<Uint8Array | null> {
    for (;;) {
      const result = await this.#runtime.request({ kind: "read", ...this.#target, maxBytes: CHUNK_BYTES }, this.#signal);
      if (result.kind === "read") return result.bytes;
      if (result.kind === "eof") return null;
      if (result.kind === "error") throw new PreviewRuntimeFailure(result.code);
      if (result.kind !== "blocked") throw new VMError("RELAY_ERROR", "preview socket read failed");
      await waitReady(this.#runtime, this.#target, "read", this.#signal);
    }
  }

  #append(bytes: Uint8Array): void {
    const combined = new Uint8Array(this.#buffer.byteLength + bytes.byteLength);
    combined.set(this.#buffer);
    combined.set(bytes, this.#buffer.byteLength);
    this.#buffer = combined;
  }

  #take(length: number): Uint8Array {
    const result = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.slice(length);
    return result;
  }
}

class PortInbox {
  readonly #port: MessagePort;
  readonly #messages: unknown[] = [];
  readonly #waiters: Array<(value: unknown) => void> = [];

  constructor(port: MessagePort, signal: AbortSignal, cancelled: () => void) {
    this.#port = port;
    port.onmessage = (event: MessageEvent<unknown>) => {
      if (isMessageKind(event.data, "cancel")) cancelled();
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#messages.push(event.data);
      else waiter(event.data);
    };
    signal.addEventListener("abort", () => this.#push({ kind: "cancel" }), { once: true });
    port.start();
  }

  async next(): Promise<ReturnType<typeof decodePortMessage>> {
    const value = this.#messages.shift() ?? await new Promise<unknown>((resolve) => this.#waiters.push(resolve));
    return decodePortMessage(value);
  }

  close(): void {
    this.#port.onmessage = null;
  }

  #push(value: unknown): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#messages.push(value);
    else waiter(value);
  }
}

class WebSocketInbox {
  readonly #port: MessagePort;
  readonly #messages: unknown[] = [];
  readonly #waiters: Array<(value: unknown) => void> = [];

  constructor(port: MessagePort, signal: AbortSignal) {
    this.#port = port;
    port.onmessage = (event: MessageEvent<unknown>) => {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#messages.push(event.data);
      else waiter(event.data);
    };
    signal.addEventListener("abort", () => this.#push({ kind: "abort" }), { once: true });
    port.start();
  }

  async next(): Promise<
    | { readonly kind: "send"; readonly sequence: number; readonly type: "text" | "binary"; readonly bytes: Uint8Array }
    | { readonly kind: "close"; readonly code: number; readonly reason: string }
  > {
    const value = this.#messages.shift() ?? await new Promise<unknown>((resolve) => this.#waiters.push(resolve));
    const message = record(value, "preview WebSocket message");
    const kind = string(message["kind"], "preview WebSocket message kind");
    if (kind === "abort") throw new VMError("ABORTED", "preview WebSocket aborted");
    if (kind === "close") {
      exactKeys(message, ["kind", "code", "reason"]);
      const code = integer(message["code"], "preview WebSocket close code", 1000, 4999);
      const reason = string(message["reason"], "preview WebSocket close reason");
      if ((code !== 1000 && (code < 3000 || code > 4999)) || new TextEncoder().encode(reason).byteLength > 123) throw new TypeError("invalid preview WebSocket close");
      return { kind, code, reason };
    }
    exactKeys(message, ["kind", "sequence", "type", "bytes"]);
    const bytes = message["bytes"];
    if (kind !== "send" || (message["type"] !== "text" && message["type"] !== "binary") || !(bytes instanceof Uint8Array) || bytes.byteLength > MAX_REQUEST_BYTES) throw new TypeError("invalid preview WebSocket send");
    if (message["type"] === "text") new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      kind,
      sequence: integer(message["sequence"], "preview WebSocket sequence", 1),
      type: message["type"],
      bytes,
    };
  }

  close(): void {
    this.#port.onmessage = null;
  }

  #push(value: unknown): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#messages.push(value);
    else waiter(value);
  }
}

function isMessageKind(value: unknown, kind: string): boolean {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === kind;
}

function decodePortMessage(value: unknown):
  | { readonly kind: "body"; readonly sequence: number; readonly bytes: Uint8Array }
  | { readonly kind: "end"; readonly sequence: number }
  | { readonly kind: "response-ack"; readonly sequence: number }
  | { readonly kind: "cancel" } {
  const message = record(value, "preview stream message");
  const kind = string(message["kind"], "preview stream message kind");
  if (kind === "cancel") {
    exactKeys(message, ["kind"]);
    return { kind };
  }
  exactKeys(message, kind === "body" ? ["kind", "sequence", "bytes"] : ["kind", "sequence"]);
  const sequence = integer(message["sequence"], "preview stream sequence", 1);
  if (kind === "body") {
    const bytes = message["bytes"];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > CHUNK_BYTES) throw new TypeError("invalid preview body chunk");
    return { kind, sequence, bytes };
  }
  if (kind === "end" || kind === "response-ack") return { kind, sequence };
  throw new TypeError("unknown preview stream message");
}

async function writeAll(runtime: PreviewRuntimePort, target: PreviewTarget, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await runtime.request({ kind: "write", ...target, bytes: bytes.slice(offset, offset + CHUNK_BYTES) }, signal);
    if (result.kind === "written") {
      if (result.bytes === 0) throw new VMError("PROTOCOL_ERROR", "preview socket made no write progress");
      offset += result.bytes;
    } else if (result.kind === "blocked") {
      await waitReady(runtime, target, "write", signal);
    } else if (result.kind === "error") {
      throw new PreviewRuntimeFailure(result.code);
    } else {
      throw new PreviewRuntimeFailure(result.kind === "opened" ? "listener" : result.kind === "closed" ? "close" : "read");
    }
  }
}

function chunk(bytes: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(`${bytes.byteLength.toString(16)}\r\n`);
  const result = new Uint8Array(head.byteLength + bytes.byteLength + 2);
  result.set(head);
  result.set(bytes, head.byteLength);
  result.set([13, 10], result.byteLength - 2);
  return result;
}

function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new VMError("ABORTED", "preview operation aborted")); return; }
    const abort = (): void => {
      clearTimeout(timer);
      reject(new VMError("ABORTED", "preview operation aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 25);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitReady(runtime: PreviewRuntimePort, target: PreviewTarget, interest: "read" | "write", signal: AbortSignal): Promise<void> {
  const result = await runtime.request({ kind: "wait", ...target, interest }, signal);
  if (result.kind === "error") throw new PreviewRuntimeFailure(result.code);
  if (result.kind !== "ready") throw new VMError("PROTOCOL_ERROR", "Invalid preview readiness completion");
}

function indexOf(bytes: Uint8Array, marker: Uint8Array): number {
  outer: for (let offset = 0; offset <= bytes.byteLength - marker.byteLength; offset++) {
    for (let index = 0; index < marker.byteLength; index++) {
      if (bytes[offset + index] !== marker[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function concatBytes(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
