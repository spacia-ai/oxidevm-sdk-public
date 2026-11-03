import type { ModuleReach } from "../reach.js";
import { urlHost } from "./addresses.js";
import { deadline } from "./deadline.js";
import { NetError } from "./errors.js";
import { BufferedStream, encodeRequestHead, field, readResponseHead } from "./http1.js";
import type { NetSockets } from "./ports.js";
import { sha1 } from "./sha1.js";
import { dial, type ByteStream, type TlsLayer } from "./streams.js";
import { concat } from "./tls.js";

/**
 * The `WebSocket` of a module with a network reach (engine ADR 0029, N-3): the WHATWG interface over an RFC 6455 client
 * on the module process's own VM sockets, `wss:` through the engine's TLS. No extensions are offered. Frames from the
 * server are hostile input: messages are bounded to 16 MiB (close 1009), control frames to 125 bytes, text must be UTF-8
 * (close 1007), and a masked or malformed frame fails the connection (close 1002).
 */
export interface WebSocketContext {
  readonly sockets: NetSockets;
  readonly reach: ModuleReach;
  readonly tls: TlsLayer;
  readonly signal: AbortSignal;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", MAX_MESSAGE = 16 * 1024 * 1024, HANDSHAKE_MS = 30_000, CLOSE_WAIT_MS = 30_000;
const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;
const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }

/** One frame as the client sends it: FIN set, masked with a fresh key. */
export function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const length = payload.length, extra = length < 126 ? 0 : length < 65536 ? 2 : 8, frame = new Uint8Array(2 + extra + 4 + length), view = new DataView(frame.buffer);
  frame[0] = 0x80 | opcode; frame[1] = 0x80 | (extra === 0 ? length : extra === 2 ? 126 : 127);
  if (extra === 2) view.setUint16(2, length); else if (extra === 8) view.setBigUint64(2, BigInt(length));
  const mask = crypto.getRandomValues(new Uint8Array(4));
  frame.set(mask, 2 + extra);
  for (let index = 0; index < length; index++) frame[2 + extra + 4 + index] = (payload[index] ?? 0) ^ (mask[index & 3] ?? 0);
  return frame;
}

class Failure extends Error { constructor(readonly code: number, message: string) { super(message); } }

async function exactly(reader: BufferedStream, count: number, signal: AbortSignal): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let remaining = count; remaining > 0;) {
    const bytes = await reader.read(remaining, signal);
    if (bytes.length === 0) throw new Failure(1006, "The connection ended inside a frame");
    parts.push(bytes); remaining -= bytes.length;
  }
  return concat(parts);
}

interface Frame { readonly fin: boolean; readonly opcode: number; readonly payload: Uint8Array }

async function readFrame(reader: BufferedStream, signal: AbortSignal): Promise<Frame | null> {
  const head = await reader.read(2, signal);
  if (head.length === 0) return null;
  const bytes = head.length === 2 ? head : concat([head, await exactly(reader, 1, signal)]);
  const first = bytes[0] ?? 0, second = bytes[1] ?? 0, opcode = first & 0x0f;
  if ((first & 0x70) !== 0) throw new Failure(1002, "A frame sets a reserved bit");
  if ((second & 0x80) !== 0) throw new Failure(1002, "A server frame is masked");
  let length = second & 0x7f;
  if (length === 126) length = new DataView((await exactly(reader, 2, signal)).buffer).getUint16(0);
  else if (length === 127) { const big = new DataView((await exactly(reader, 8, signal)).buffer).getBigUint64(0); if (big > BigInt(MAX_MESSAGE)) throw new Failure(1009, "A frame exceeds 16 MiB"); length = Number(big); }
  if (opcode >= 8 && (length > 125 || (first & 0x80) === 0)) throw new Failure(1002, "Invalid control frame");
  if (length > MAX_MESSAGE) throw new Failure(1009, "A frame exceeds 16 MiB");
  return { fin: (first & 0x80) !== 0, opcode, payload: length === 0 ? new Uint8Array() : await exactly(reader, length, signal) };
}


type Handler = ((event: Event) => void) | null;

/** A module's `WebSocket`: the WHATWG interface. */
export interface ModuleWebSocketApi extends EventTarget {
  readonly url: string;
  readonly readyState: number;
  readonly protocol: string;
  readonly extensions: string;
  readonly bufferedAmount: number;
  binaryType: BinaryType;
  onopen: Handler; onmessage: Handler; onerror: Handler; onclose: Handler;
  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
}

/** The `WebSocket` constructor a module receives, with the ready-state constants. */
export interface ModuleWebSocketClass {
  new (url: string | URL, protocols?: string | readonly string[]): ModuleWebSocketApi;
  readonly CONNECTING: 0; readonly OPEN: 1; readonly CLOSING: 2; readonly CLOSED: 3;
}

/** Creates the `WebSocket` class bound to one module process's network. */
export function createWebSocket(context: WebSocketContext): ModuleWebSocketClass {
  class ModuleWebSocket extends EventTarget {
    static readonly CONNECTING = 0 as const; static readonly OPEN = 1 as const; static readonly CLOSING = 2 as const; static readonly CLOSED = 3 as const;
    readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
    readonly url: string;
    #state = 0; #protocol = ""; #binaryType: BinaryType = "blob"; #buffered = 0;
    #stream: ByteStream | undefined; #sending: Promise<void> = Promise.resolve();
    readonly #lifetime = new AbortController();
    #closeSent = false; #closed = false;
    readonly #handlers = new Map<string, Handler>();

    constructor(url: string | URL, protocols: string | readonly string[] = []) {
      super();
      let parsed: URL;
      try { parsed = new URL(String(url)); } catch { throw new DOMException(`Invalid WebSocket URL ${String(url)}`, "SyntaxError"); }
      if (parsed.protocol === "http:") parsed.protocol = "ws:"; else if (parsed.protocol === "https:") parsed.protocol = "wss:";
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:" || parsed.hash !== "") throw new DOMException("A WebSocket URL must be ws: or wss: without a fragment", "SyntaxError");
      const offered = typeof protocols === "string" ? [protocols] : [...protocols];
      if (new Set(offered).size !== offered.length || offered.some(item => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(item))) throw new DOMException("Invalid WebSocket subprotocol list", "SyntaxError");
      this.url = parsed.href;
      context.signal.addEventListener("abort", () => { this.#fail(1006, "The module ended"); }, { once: true });
      void this.#open(parsed, offered);
    }

    get readyState(): number { return this.#state; }
    get protocol(): string { return this.#protocol; }
    get extensions(): string { return ""; }
    get bufferedAmount(): number { return this.#buffered; }
    get binaryType(): BinaryType { return this.#binaryType; }
    set binaryType(value: BinaryType) { this.#binaryType = value === "arraybuffer" ? "arraybuffer" : "blob"; }
    get onopen(): Handler { return this.#handlers.get("open") ?? null; } set onopen(handler: Handler) { this.#handler("open", handler); }
    get onmessage(): Handler { return this.#handlers.get("message") ?? null; } set onmessage(handler: Handler) { this.#handler("message", handler); }
    get onerror(): Handler { return this.#handlers.get("error") ?? null; } set onerror(handler: Handler) { this.#handler("error", handler); }
    get onclose(): Handler { return this.#handlers.get("close") ?? null; } set onclose(handler: Handler) { this.#handler("close", handler); }
    #handler(type: string, handler: Handler): void {
      const previous = this.#handlers.get(type);
      if (previous !== undefined && previous !== null) this.removeEventListener(type, previous);
      this.#handlers.set(type, handler);
      if (handler !== null) this.addEventListener(type, handler);
    }

    async #open(url: URL, offered: readonly string[]): Promise<void> {
      const timer = deadline(HANDSHAKE_MS, this.#lifetime.signal, "The WebSocket handshake");
      try {
        const secure = url.protocol === "wss:", port = url.port === "" ? (secure ? 443 : 80) : Number(url.port);
        const stream = this.#stream = await dial(context.sockets, context.reach, context.tls, { host: urlHost(url), port, tls: secure, alpn: ["http/1.1"], signal: timer.signal });
        const key = base64(crypto.getRandomValues(new Uint8Array(16)));
        const fields: [string, string][] = [["host", url.host], ["upgrade", "websocket"], ["connection", "Upgrade"], ["sec-websocket-key", key], ["sec-websocket-version", "13"]];
        if (offered.length > 0) fields.push(["sec-websocket-protocol", offered.join(", ")]);
        await stream.write(encodeRequestHead({ method: "GET", target: `${url.pathname}${url.search}`, fields }), timer.signal);
        const reader = new BufferedStream(stream), head = await readResponseHead(reader, timer.signal);
        if (head === null || head.status !== 101) throw new NetError("ERR_WS_HANDSHAKE", `The server answered ${head === null ? "nothing" : String(head.status)} instead of 101`);
        const accept = base64(sha1(encoder.encode(`${key}${GUID}`))), chosen = field(head, "sec-websocket-protocol") ?? "";
        if (field(head, "upgrade")?.toLowerCase() !== "websocket" || !(field(head, "connection") ?? "").toLowerCase().split(",").some(token => token.trim() === "upgrade")
          || field(head, "sec-websocket-accept") !== accept || field(head, "sec-websocket-extensions") !== undefined || chosen !== "" && !offered.includes(chosen)) throw new NetError("ERR_WS_HANDSHAKE", "The server's WebSocket handshake is invalid");
        timer.clear();
        if (this.#state !== 0) return;
        this.#protocol = chosen; this.#state = 1;
        this.dispatchEvent(new Event("open"));
        await this.#receive(reader);
      } catch (error: unknown) {
        this.#fail(error instanceof Failure ? error.code : 1006, error instanceof Error ? error.message : "WebSocket failed");
      } finally { timer.clear(); }
    }

    async #receive(reader: BufferedStream): Promise<void> {
      const fragments: Uint8Array[] = [];
      let kind = 0, size = 0;
      for (;;) {
        const frame = await readFrame(reader, this.#lifetime.signal);
        if (frame === null) { this.#fail(1006, "The server closed the connection without a close frame"); return; }
        if (frame.opcode === OP.ping) { this.#enqueue(OP.pong, frame.payload); continue; }
        if (frame.opcode === OP.pong) continue;
        if (frame.opcode === OP.close) { this.#peerClosed(frame.payload); return; }
        if (frame.opcode === OP.continuation ? kind === 0 : frame.opcode !== OP.text && frame.opcode !== OP.binary || kind !== 0) throw new Failure(1002, "Unexpected frame opcode");
        if (frame.opcode !== OP.continuation) kind = frame.opcode;
        size += frame.payload.length;
        if (size > MAX_MESSAGE) throw new Failure(1009, "A message exceeds 16 MiB");
        fragments.push(frame.payload);
        if (!frame.fin) continue;
        const bytes = concat(fragments.splice(0));
        let data: string | ArrayBuffer | Blob;
        if (kind === OP.text) { try { data = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Failure(1007, "A text message is not UTF-8"); } }
        else data = this.#binaryType === "arraybuffer" ? bytes.slice().buffer : new Blob([bytes.slice()]);
        kind = 0; size = 0;
        if (this.#state === 1) this.dispatchEvent(new MessageEvent("message", { data, origin: new URL(this.url).origin }));
      }
    }

    #peerClosed(payload: Uint8Array): void {
      if (payload.length === 1) throw new Failure(1002, "A close frame with one byte");
      const code = payload.length >= 2 ? new DataView(payload.buffer, payload.byteOffset).getUint16(0) : 1005;
      let reason = "";
      try { reason = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2)); } catch { throw new Failure(1007, "A close reason is not UTF-8"); }
      if (!this.#closeSent) this.#enqueue(OP.close, payload.subarray(0, 2));
      this.#state = 2;
      void this.#sending.finally(() => { this.#finish(true, code, reason); });
    }

    #enqueue(opcode: number, payload: Uint8Array): void {
      if (opcode === OP.close) this.#closeSent = true;
      const frame = encodeFrame(opcode, payload), stream = this.#stream, counted = opcode === OP.text || opcode === OP.binary ? payload.length : 0;
      this.#buffered += counted;
      this.#sending = this.#sending.then(async () => {
        if (stream === undefined || this.#closed) return;
        await stream.write(frame, this.#lifetime.signal);
        this.#buffered -= counted;
      }).catch(() => { this.#fail(1006, "Sending failed"); });
    }

    send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
      if (this.#state === 0) throw new DOMException("The WebSocket is still connecting", "InvalidStateError");
      if (this.#state !== 1) return;
      if (typeof data === "string") { this.#enqueue(OP.text, encoder.encode(data)); return; }
      if (data instanceof Blob) {
        this.#buffered += data.size;
        const ready = data.arrayBuffer();
        this.#sending = this.#sending.then(async () => { const bytes = new Uint8Array(await ready); this.#buffered -= data.size; this.#enqueue(OP.binary, bytes); });
        return;
      }
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      this.#enqueue(OP.binary, bytes.slice());
    }

    close(code?: number, reason = ""): void {
      if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException("A close code must be 1000 or 3000-4999", "InvalidAccessError");
      const reasonBytes = encoder.encode(reason);
      if (reasonBytes.length > 123) throw new DOMException("A close reason must be at most 123 bytes", "SyntaxError");
      if (this.#state >= 2) return;
      if (this.#state === 0) { this.#fail(1006, "Closed before the connection opened"); return; }
      this.#state = 2;
      const payload = code === undefined ? new Uint8Array() : new Uint8Array([code >> 8, code & 0xff, ...reasonBytes]);
      this.#enqueue(OP.close, payload);
      // The server answers with its own close frame; one that never does is cut off.
      const timer = setTimeout(() => { this.#finish(false, 1006, ""); }, CLOSE_WAIT_MS);
      this.#lifetime.signal.addEventListener("abort", () => { clearTimeout(timer); }, { once: true });
    }

    #fail(code: number, message: string): void {
      if (this.#closed) return;
      if (this.#state === 1 && code !== 1006 && !this.#closeSent) this.#enqueue(OP.close, new Uint8Array([code >> 8, code & 0xff]));
      this.dispatchEvent(Object.assign(new Event("error"), { message }));
      void this.#sending.finally(() => { this.#finish(false, 1006, ""); });
    }

    #finish(wasClean: boolean, code: number, reason: string): void {
      if (this.#closed) return;
      this.#closed = true; this.#state = 3; this.#lifetime.abort();
      void this.#stream?.close();
      this.dispatchEvent(new CloseEvent("close", { wasClean, code, reason }));
    }
  }
  return ModuleWebSocket;
}
