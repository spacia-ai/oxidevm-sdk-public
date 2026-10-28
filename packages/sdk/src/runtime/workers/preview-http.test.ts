import { describe, expect, it, vi } from "vitest";

import type {
  PreviewRuntimeCompletion,
  PreviewRuntimeOperation,
} from "./preview-runtime-channel.js";
import { servePreviewSession, type PreviewRuntimePort } from "./preview-http.js";
import { PreviewCookieJar } from "./preview-cookies.js";
import { VMError } from "../errors.js";

class ScriptedRuntime implements PreviewRuntimePort {
  readonly written: Uint8Array[] = [];
  readonly #reads: Uint8Array[];
  #openFailures: number;

  constructor(response: string, openFailures = 0) {
    const bytes = new TextEncoder().encode(response);
    this.#reads = [bytes.slice(0, 17), bytes.slice(17)];
    this.#openFailures = openFailures;
  }

  request(operation: PreviewRuntimeOperation): Promise<PreviewRuntimeCompletion> {
    switch (operation.kind) {
      case "open":
        if (this.#openFailures-- > 0) return Promise.resolve({ kind: "error", code: "listener" });
        return Promise.resolve({ kind: "opened", generation: 1n, process: 1, connection: 2 });
      case "write":
        this.written.push(operation.bytes);
        return Promise.resolve({ kind: "written", bytes: operation.bytes.byteLength });
      case "read": {
        const bytes = this.#reads.shift();
        return Promise.resolve(bytes === undefined ? { kind: "eof" } : { kind: "read", bytes });
      }
      case "close": return Promise.resolve({ kind: "closed" });
      case "wait": return Promise.resolve({ kind: "ready" });
    }
  }
}

describe("preview HTTP bridge", () => {
  it("streams a chunked response and acknowledges bounded request chunks", async () => {
    const runtime = new ScriptedRuntime(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/event-stream\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
      1,
    );
    const session = new MessageChannel();
    const request = new MessageChannel();
    servePreviewSession(session.port2, 3000, runtime);
    const received: unknown[] = [];
    const complete = new Promise<void>((resolve, reject) => {
      request.port1.onmessage = (event: MessageEvent<unknown>) => {
        received.push(event.data);
        if (isMessage(event.data, "body-ack")) {
          request.port1.postMessage({ kind: "end", sequence: 2 });
        } else if (isMessage(event.data, "data")) {
          request.port1.postMessage({ kind: "response-ack", sequence: event.data["sequence"] });
        } else if (isMessage(event.data, "end")) {
          resolve();
        } else if (isMessage(event.data, "error")) {
          reject(new Error("preview proxy failed"));
        }
      };
      request.port1.start();
    });
    session.port1.postMessage({
      kind: "request",
      port: request.port2,
      method: "POST",
      path: "/events",
      headers: [["content-type", "text/plain"]],
      hasBody: true,
    }, [request.port2]);
    request.port1.postMessage({ kind: "body", sequence: 1, bytes: new TextEncoder().encode("body") });
    await complete;
    const data = received.find((value) => isMessage(value, "data"));
    const responseBytes = isMessage(data, "data") && data["bytes"] instanceof Uint8Array
      ? data["bytes"]
      : undefined;
    expect(responseBytes === undefined ? undefined : new TextDecoder().decode(responseBytes)).toBe("hello");
    expect(new TextDecoder().decode(concat(runtime.written))).toContain("transfer-encoding: chunked\r\n\r\n4\r\nbody\r\n0\r\n\r\n");
  });

  it("upgrades and bridges bounded WebSocket messages", async () => {
    const runtime = new ScriptedWebSocketRuntime();
    const session = new MessageChannel();
    const socket = new MessageChannel();
    servePreviewSession(session.port2, 3000, runtime);
    const received: unknown[] = [];
    const complete = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket bridge timed out")), 2_000);
      socket.port1.onmessage = (event: MessageEvent<unknown>) => {
        received.push(event.data);
        if (isMessage(event.data, "open")) {
          socket.port1.postMessage({ kind: "send", sequence: 1, type: "text", bytes: new TextEncoder().encode("client") });
        } else if (isMessage(event.data, "ack")) {
          socket.port1.postMessage({ kind: "close", code: 1000, reason: "done" });
        } else if (isMessage(event.data, "close")) {
          clearTimeout(timeout);
          resolve();
        } else if (isMessage(event.data, "error")) {
          reject(new Error("WebSocket upgrade failed"));
        }
      };
      socket.port1.start();
    });
    session.port1.postMessage({
      kind: "websocket",
      port: socket.port2,
      path: "/hmr",
      protocols: ["fixture"],
    }, [socket.port2]);
    await complete;
    const message = received.find((value) => isMessage(value, "message"));
    expect(isMessage(message, "message") && message["bytes"] instanceof Uint8Array
      ? new TextDecoder().decode(message["bytes"])
      : undefined).toBe("server");
    expect(runtime.written.some((bytes) => ((bytes[0] ?? 0) & 0x0f) === 1 && ((bytes[1] ?? 0) & 0x80) !== 0)).toBe(true);
    const upgrade = new TextDecoder().decode(runtime.written[0]);
    expect(upgrade).toContain("host: localhost:3000\r\n");
    expect(upgrade).toContain("origin: http://localhost:3000\r\n");
  });
});

class ScriptedWebSocketRuntime implements PreviewRuntimePort {
  readonly written: Uint8Array[] = [];
  #upgraded = false;
  #serverMessage = false;
  #serverClose = false;
  readonly #waiters = new Set<() => void>();

  async request(operation: PreviewRuntimeOperation): Promise<PreviewRuntimeCompletion> {
    if (operation.kind === "open") return { kind: "opened", generation: 1n, process: 1, connection: 2 };
    if (operation.kind === "close") return { kind: "closed" };
    if (operation.kind === "write") {
      this.written.push(operation.bytes.slice());
      for (const wake of this.#waiters) wake();
      this.#waiters.clear();
      return { kind: "written", bytes: operation.bytes.byteLength };
    }
    if (operation.kind === "wait") {
      if (this.written.some(bytes => ((bytes[0] ?? 0) & 0x0f) === 8)) return { kind: "ready" };
      await new Promise<void>(resolve => { this.#waiters.add(resolve); });
      return { kind: "ready" };
    }
    if (!this.#upgraded) {
      this.#upgraded = true;
      const request = new TextDecoder().decode(concat(this.written));
      const key = request.match(/sec-websocket-key: ([^\r]+)\r\n/i)?.[1];
      if (key === undefined) return { kind: "error", code: "read" };
      const source = new TextEncoder().encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`);
      const accept = Buffer.from(await crypto.subtle.digest("SHA-1", source)).toString("base64");
      return { kind: "read", bytes: new TextEncoder().encode(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: fixture\r\n\r\n`) };
    }
    if (!this.#serverMessage) {
      this.#serverMessage = true;
      return { kind: "read", bytes: new Uint8Array([0x81, 6, ...new TextEncoder().encode("server")]) };
    }
    const clientClosed = this.written.some((bytes) => ((bytes[0] ?? 0) & 0x0f) === 8);
    if (clientClosed && !this.#serverClose) {
      this.#serverClose = true;
      return { kind: "read", bytes: new Uint8Array([0x88, 2, 3, 232]) };
    }
    return { kind: "blocked" };
  }
}

function isMessage(value: unknown, kind: string): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "kind" in value && value["kind"] === kind;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** A guest server that accepted the request and has not answered yet (a slow first compile). */
class SilentRuntime implements PreviewRuntimePort {
  readonly closed: unknown[] = [];

  request(operation: PreviewRuntimeOperation, signal?: AbortSignal): Promise<PreviewRuntimeCompletion> {
    switch (operation.kind) {
      case "open": return Promise.resolve({ kind: "opened", generation: 1n, process: 1, connection: 2 });
      case "write": return Promise.resolve({ kind: "written", bytes: operation.bytes.byteLength });
      case "read": return Promise.resolve({ kind: "blocked" });
      case "wait": return new Promise((_resolve, reject) => {
        if (signal?.aborted === true) { reject(new VMError("ABORTED", "cancelled")); return; }
        signal?.addEventListener("abort", () => { reject(new VMError("ABORTED", "cancelled")); }, { once: true });
      });
      case "close":
        this.closed.push({ process: operation.process, connection: operation.connection });
        return Promise.resolve({ kind: "closed" });
    }
  }
}

/** A guest where nothing listens on the port. */
class RefusingRuntime implements PreviewRuntimePort {
  opens = 0;

  request(operation: PreviewRuntimeOperation): Promise<PreviewRuntimeCompletion> {
    if (operation.kind === "open") this.opens += 1;
    return Promise.resolve({ kind: "error", code: "listener" });
  }
}

describe("preview open window", () => {
  it("says nothing listened, not that the channel failed, when no listener answers within 5 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const runtime = new RefusingRuntime();
    const session = new MessageChannel();
    const request = new MessageChannel();
    const close = servePreviewSession(session.port2, 3000, runtime);
    try {
      const failed = new Promise<unknown>((resolve) => {
        request.port1.onmessage = (event: MessageEvent<unknown>) => {
          if (isMessage(event.data, "error")) resolve(event.data);
        };
        request.port1.start();
      });
      session.port1.postMessage({ kind: "request", port: request.port2, method: "GET", path: "/", headers: [], hasBody: false }, [request.port2]);
      await vi.waitFor(() => { expect(runtime.opens).toBeGreaterThan(1); });
      vi.setSystemTime(Date.now() + 5_001);
      await expect(failed).resolves.toEqual({ kind: "error", code: "open", reason: "listener" });
    } finally { vi.useRealTimers(); close(); request.port1.close(); session.port1.close(); }
  });
});

describe("preview request cancellation", () => {
  it("keeps abort listeners bounded while a server compiles its first response", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const add = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    const entered = Promise.withResolvers<AbortSignal>();
    let reads = 0;
    const runtime: PreviewRuntimePort = {
      request(operation, signal) {
        if (operation.kind === "open") return Promise.resolve({ kind: "opened", generation: 1n, process: 1, connection: 2 });
        if (operation.kind === "close") return Promise.resolve({ kind: "closed" });
        if (operation.kind === "write") return Promise.resolve({ kind: "written", bytes: operation.bytes.byteLength });
        if (signal === undefined) throw new Error("Preview reads require cancellation");
        if (operation.kind === "read") { reads++; return Promise.resolve({ kind: "blocked" }); }
        entered.resolve(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => { reject(new VMError("ABORTED", "cancelled")); }, { once: true });
        });
      },
    };
    const session = new MessageChannel(), request = new MessageChannel();
    const close = servePreviewSession(session.port2, 3000, runtime);
    try {
      session.port1.postMessage({ kind: "request", port: request.port2, method: "GET", path: "/", headers: [], hasBody: false }, [request.port2]);
      request.port1.postMessage({ kind: "end", sequence: 1 });
      const signal = await entered.promise;
      await vi.advanceTimersByTimeAsync(100);
      expect(reads).toBe(1);
      const added = add.mock.contexts.filter(context => context === signal).length;
      const removed = remove.mock.contexts.filter(context => context === signal).length;
      expect(added - removed).toBeLessThanOrEqual(2);
    } finally {
      close(); request.port1.close(); session.port1.close();
      vi.useRealTimers(); vi.restoreAllMocks();
    }
  });

  it("ends a request still waiting for its response head and closes the guest connection", async () => {
    const runtime = new SilentRuntime();
    const session = new MessageChannel();
    const request = new MessageChannel();
    const close = servePreviewSession(session.port2, 3000, runtime);
    try {
      const failed = new Promise<unknown>((resolve) => {
        request.port1.onmessage = (event: MessageEvent<unknown>) => {
          if (isMessage(event.data, "error")) resolve(event.data);
        };
        request.port1.start();
      });
      session.port1.postMessage({ kind: "request", port: request.port2, method: "GET", path: "/", headers: [], hasBody: false }, [request.port2]);
      request.port1.postMessage({ kind: "end", sequence: 1 });
      // The preview worker gave up waiting (it must answer its fetch event in time).
      request.port1.postMessage({ kind: "cancel" });
      await expect(failed).resolves.toEqual({ kind: "error", code: "response-read", reason: "abort" });
      await vi.waitFor(() => { expect(runtime.closed).toEqual([{ process: 1, connection: 2 }]); });
    } finally { close(); request.port1.close(); session.port1.close(); }
  });
});

describe("preview session cookies", () => {
  it("hands Set-Cookie to the session jar, strips it from the head, and sends jar cookies with the next request", async () => {
    const origin = new URL("https://abc.oxidevm-preview.test:4573");
    const jar = new PreviewCookieJar(origin.hostname, () => 1000);
    const first = new ScriptedRuntime("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nSet-Cookie: secret=1; HttpOnly; Secure; SameSite=None; Path=/\r\nStrict-Transport-Security: max-age=1\r\nLocation: http://localhost:3000/next\r\nX-Kept: yes\r\n\r\nok");
    const head = await exchange(first, { origin, jar }, [["cookie", "secret=forged; visible=2"]]);
    expect(head).toMatchObject({ kind: "response", status: 200, cookies: [{ name: "secret", value: null, path: "/", sameSite: "none", expires: null }] });
    // Framing headers are hop-by-hop for the worker, which re-frames the body.
    // The guest's absolute localhost URLs point back at the session origin.
    expect(head["headers"]).toEqual([["location", "https://abc.oxidevm-preview.test:4573/next"], ["x-kept", "yes"]]);
    const firstHead = new TextDecoder().decode(first.written[0]);
    expect(firstHead).toContain("host: localhost:3000\r\n");
    // Nothing is shadowed before the jar owns a name; the response's HttpOnly cookie changes that.
    expect(firstHead).toContain("cookie: secret=forged; visible=2\r\n");
    const second = new ScriptedRuntime("HTTP/1.1 204 No Content\r\n\r\n");
    const next = await exchange(second, { origin, jar }, [["cookie", "secret=forged; visible=2"]]);
    expect(next).toMatchObject({ kind: "response", status: 204, cookies: [] });
    expect(new TextDecoder().decode(second.written[0])).toContain("cookie: secret=1; visible=2\r\n");
  });
});

async function exchange(runtime: ScriptedRuntime, options: { origin: URL; jar: PreviewCookieJar }, headers: [string, string][]): Promise<Record<string, unknown>> {
  const session = new MessageChannel();
  const request = new MessageChannel();
  const close = servePreviewSession(session.port2, 3000, runtime, options);
  try {
    const head = new Promise<Record<string, unknown>>((resolve, reject) => {
      request.port1.onmessage = (event: MessageEvent<unknown>) => {
        if (isMessage(event.data, "response")) resolve(event.data);
        else if (isMessage(event.data, "data")) request.port1.postMessage({ kind: "response-ack", sequence: event.data["sequence"] });
        else if (isMessage(event.data, "error")) reject(new Error("preview proxy failed"));
      };
      request.port1.start();
    });
    session.port1.postMessage({ kind: "request", port: request.port2, method: "GET", path: "/api", headers, hasBody: false,
      client: { frame: "nested", ancestor: "https://oxidevm-ide.test:4473", navigate: false } }, [request.port2]);
    request.port1.postMessage({ kind: "end", sequence: 1 });
    return await head;
  } finally { close(); request.port1.close(); session.port1.close(); }
}
