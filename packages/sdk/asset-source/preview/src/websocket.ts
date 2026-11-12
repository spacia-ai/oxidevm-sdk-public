import { reportServerDelivery } from "./navigation-timing";
import { websocketRoute } from "./websocket-route";

// The page's WebSocket bridge: sockets travel to the guest listener through
// this origin's Service Worker, which holds the session transport. No owner
// window is involved, so direct tabs and embedded previews behave alike.
const controllerValue = navigator.serviceWorker.controller;
if (controllerValue === null) throw new TypeError("preview WebSocket requires the session Service Worker");
const controller: ServiceWorker = controllerValue;
// This worker served the page, so its timing entry reads as the server response it is
// (navigation-timing.ts). Every page loads this script before its own.
reportServerDelivery({ resource: globalThis.PerformanceResourceTiming, navigation: globalThis.PerformanceNavigationTiming });

const NativeWebSocket = globalThis.WebSocket;

class PortWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readyState = PortWebSocket.CONNECTING;
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  binaryType: BinaryType = "blob";
  onopen: ((this: WebSocket, event: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, event: MessageEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, event: Event) => unknown) | null = null;
  onclose: ((this: WebSocket, event: CloseEvent) => unknown) | null = null;
  readonly #port = new MessageChannel();
  readonly #pending = new Map<number, number>();
  #next = 1;
  #sendQueue = Promise.resolve();

  constructor(url: string | URL, protocols: string | string[] = []) {
    super();
    const target = new URL(url, location.href);
    if (websocketRoute(target, location) !== "bridge") throw new DOMException("Unsafe preview WebSocket URL", "SecurityError");
    const requested = typeof protocols === "string" ? [protocols] : [...protocols];
    if (requested.length > 16 || new Set(requested).size !== requested.length || requested.some((value) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(value))) throw new DOMException("Invalid WebSocket protocol", "SyntaxError");
    this.url = target.href;
    this.#port.port1.onmessage = (event: MessageEvent<unknown>) => {
      try {
        this.#receive(event.data);
      } catch {
        this.#fail();
      }
    };
    this.#port.port1.start();
    controller.postMessage({ kind: "websocket", port: this.#port.port2, path: `${target.pathname}${target.search}`, protocols: requested }, [this.#port.port2]);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== PortWebSocket.OPEN) throw new DOMException("WebSocket is not open", "InvalidStateError");
    const text = typeof data === "string";
    // The message is the bytes as they are now, as with the browser's own WebSocket: a caller may
    // reuse its buffer once send() returns (noVNC does). Only a Blob, which cannot change, is read
    // when its turn in the queue comes.
    const message = data instanceof Blob ? data : messageBytes(data);
    this.#sendQueue = this.#sendQueue.then(async () => {
      const bytes = message instanceof Blob ? new Uint8Array(await message.arrayBuffer()) : message;
      if (bytes.byteLength > 16 * 1024 * 1024) throw new DOMException("WebSocket message is too large", "QuotaExceededError");
      const sequence = this.#next++;
      this.#pending.set(sequence, bytes.byteLength);
      this.bufferedAmount += bytes.byteLength;
      this.#port.port1.postMessage({ kind: "send", sequence, type: text ? "text" : "binary", bytes }, [bytes.buffer]);
    }).catch(() => this.#fail());
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === PortWebSocket.CLOSED || this.readyState === PortWebSocket.CLOSING) return;
    if ((code !== 1000 && (code < 3000 || code > 4999)) || new TextEncoder().encode(reason).byteLength > 123) throw new DOMException("Invalid WebSocket close", "InvalidAccessError");
    this.readyState = PortWebSocket.CLOSING;
    this.#sendQueue = this.#sendQueue
      .then(() => this.#port.port1.postMessage({ kind: "close", code, reason }))
      .catch(() => this.#fail());
  }

  #receive(value: unknown): void {
    if (!isRecord(value) || typeof value["kind"] !== "string") return this.#fail();
    if (value["kind"] === "open" && exactKeys(value, ["kind", "protocol"]) && typeof value["protocol"] === "string" && (value["protocol"] === "" || /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(value["protocol"]))) {
      this.protocol = value["protocol"];
      this.readyState = PortWebSocket.OPEN;
      return this.#emit("open", new Event("open"));
    }
    if (value["kind"] === "ack" && exactKeys(value, ["kind", "sequence"]) && isInteger(value["sequence"])) {
      const length = this.#pending.get(value["sequence"]);
      if (length === undefined) return this.#fail();
      this.#pending.delete(value["sequence"]);
      this.bufferedAmount -= length;
      return;
    }
    if (value["kind"] === "message" && exactKeys(value, ["kind", "type", "bytes"]) && (value["type"] === "text" || value["type"] === "binary") && value["bytes"] instanceof Uint8Array && value["bytes"].byteLength <= 16 * 1024 * 1024) {
      const bytes = value["bytes"];
      const data: string | ArrayBuffer | Blob = value["type"] === "text"
        ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        : this.binaryType === "arraybuffer"
          ? bytes.slice().buffer
          : new Blob([bytes.slice().buffer]);
      return this.#emit("message", new MessageEvent("message", { data, origin: location.origin }));
    }
    if (value["kind"] === "close" && exactKeys(value, ["kind", "code", "reason", "clean"]) && isInteger(value["code"]) && value["code"] >= 1000 && value["code"] <= 4999 && typeof value["reason"] === "string" && new TextEncoder().encode(value["reason"]).byteLength <= 123 && typeof value["clean"] === "boolean") {
      this.readyState = PortWebSocket.CLOSED;
      this.#port.port1.close();
      return this.#emit("close", new CloseEvent("close", { code: value["code"], reason: value["reason"], wasClean: value["clean"] }));
    }
    this.#fail();
  }

  #fail(): void {
    if (this.readyState === PortWebSocket.CLOSED) return;
    this.#emit("error", new Event("error"));
    this.readyState = PortWebSocket.CLOSED;
    this.#port.port1.close();
    this.#emit("close", new CloseEvent("close", { code: 1006, wasClean: false }));
  }

  #emit(type: "open" | "message" | "error" | "close", event: Event): void {
    const handler = this[`on${type}`];
    if (handler !== null) Reflect.apply(handler, this, [event]);
    this.dispatchEvent(event);
  }
}

/** A private copy of a text or binary message's bytes. */
function messageBytes(data: string | ArrayBufferLike | ArrayBufferView): Uint8Array<ArrayBuffer> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  return ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(data).slice();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

// Sockets to other hosts go to the browser's own WebSocket, so the page CSP is the only decision
// point: an allowed site connects and a blocked one fails. Validation errors stay the bridge's.
function nativeProtocols(value: unknown): string | string[] | undefined {
  if (typeof value === "string") return value;
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : undefined;
}

const RoutedWebSocket = new Proxy(PortWebSocket, {
  construct(target, args: unknown[], newTarget): object {
    const [url, protocols] = args;
    if (typeof url === "string" || url instanceof URL) {
      if (websocketRoute(url, location) === "native") {
        return new NativeWebSocket(url, nativeProtocols(protocols));
      }
    }
    const instance: unknown = Reflect.construct(target, args, newTarget);
    if (typeof instance !== "object" || instance === null) throw new TypeError("WebSocket construction failed");
    return instance;
  },
});

Object.defineProperty(globalThis, "WebSocket", { configurable: false, writable: false, value: RoutedWebSocket });
