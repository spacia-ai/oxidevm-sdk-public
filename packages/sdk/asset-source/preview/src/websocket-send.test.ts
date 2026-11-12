import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

const HOST = "0123456789abcdef0123456789abcdef.oxvm.dev";
const LIMIT = 16 * 1024 * 1024;
const bridges: MessagePort[] = [];

// The module replaces the global once and cannot be loaded twice, so every case shares one import.
beforeAll(async () => {
  vi.stubGlobal("navigator", {
    serviceWorker: {
      controller: {
        postMessage(message: unknown): void {
          const port: unknown = typeof message === "object" && message !== null ? Reflect.get(message, "port") : undefined;
          if (port instanceof MessagePort) bridges.push(port);
        },
      },
    },
  });
  vi.stubGlobal("location", { href: `https://${HOST}/app`, hostname: HOST, origin: `https://${HOST}` });
  await import("./websocket");
});

/** Opens a page socket and plays the Service Worker's end of its bridge: it accepts the socket
 * and hands back what the page sends, in arrival order. */
async function openSocket(): Promise<{ readonly socket: WebSocket; readonly sent: (count: number) => Promise<unknown[]> }> {
  const socket = new WebSocket(`wss://${HOST}/websockify`);
  const port = bridges.pop();
  if (port === undefined) throw new TypeError("the socket did not reach the Service Worker");
  onTestFinished(() => { port.close(); });
  const received: unknown[] = [];
  let arrived = (): void => undefined;
  port.onmessage = (event: MessageEvent<unknown>) => {
    received.push(event.data);
    arrived();
  };
  port.start();
  const opened = new Promise<void>((resolve) => { socket.addEventListener("open", () => { resolve(); }, { once: true }); });
  port.postMessage({ kind: "open", protocol: "" });
  await opened;
  const sent = async (count: number): Promise<unknown[]> => {
    while (received.length < count) await new Promise<void>((resolve) => { arrived = resolve; });
    return received.splice(0, count);
  };
  return { socket, sent };
}

function byteLength(message: unknown): number | undefined {
  const bytes: unknown = typeof message === "object" && message !== null ? Reflect.get(message, "bytes") : undefined;
  return bytes instanceof Uint8Array ? bytes.byteLength : undefined;
}

describe("websocket.js send", () => {
  it("sends a view's bytes as they were at send(), though the caller then reuses its buffer", async () => {
    // noVNC 1.6's Websock.flush() sends a view of its send queue and writes the next message over
    // the same bytes: SetPixelFormat, SetEncodings (shortened here) and FramebufferUpdateRequest.
    const messages = [
      [0x00, 0x00, 0x00, 0x00, 0x20, 0x18, 0x00, 0x01, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0x08, 0x10, 0x00, 0x00, 0x00],
      [0x02, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x32, 0x00, 0x00, 0x00, 0x07],
      [0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x00, 0x03, 0x20],
    ];
    const { socket, sent } = await openSocket();
    const queue = new Uint8Array(40);
    for (const message of messages) {
      queue.set(message);
      socket.send(new Uint8Array(queue.buffer, 0, message.length));
    }
    queue.fill(0xee);
    expect(await sent(3)).toEqual(messages.map((message, index) => ({ kind: "send", sequence: index + 1, type: "binary", bytes: Uint8Array.from(message) })));
  });

  it("sends an ArrayBuffer's bytes as they were at send() and a string as UTF-8 text", async () => {
    const { socket, sent } = await openSocket();
    const buffer = Uint8Array.of(1, 2, 3).buffer;
    socket.send(buffer);
    new Uint8Array(buffer).fill(0xee);
    socket.send("hé");
    expect(await sent(2)).toEqual([
      { kind: "send", sequence: 1, type: "binary", bytes: Uint8Array.of(1, 2, 3) },
      { kind: "send", sequence: 2, type: "text", bytes: new TextEncoder().encode("hé") },
    ]);
  });

  it("keeps send order behind a Blob, which is read when its turn comes", async () => {
    const { socket, sent } = await openSocket();
    const view = Uint8Array.of(4, 5, 6);
    socket.send(new Blob([Uint8Array.of(1, 2, 3)]));
    socket.send(view);
    view.fill(0xee);
    expect(await sent(2)).toEqual([
      { kind: "send", sequence: 1, type: "binary", bytes: Uint8Array.of(1, 2, 3) },
      { kind: "send", sequence: 2, type: "binary", bytes: Uint8Array.of(4, 5, 6) },
    ]);
  });

  it("sends 16 MiB and fails the socket on a larger message, after the messages before it", async () => {
    const { socket, sent } = await openSocket();
    const events: string[] = [];
    socket.addEventListener("error", () => { events.push("error"); });
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", (event) => {
        events.push("close");
        resolve(event);
      }, { once: true });
    });
    socket.send(new Uint8Array(LIMIT));
    socket.send(new Uint8Array(LIMIT + 1));
    const [largest] = await sent(1);
    expect(largest).toMatchObject({ kind: "send", sequence: 1, type: "binary" });
    expect(byteLength(largest)).toBe(LIMIT);
    const event = await closed;
    expect(events).toEqual(["error", "close"]);
    expect([event.code, event.wasClean, socket.readyState]).toEqual([1006, false, WebSocket.CLOSED]);
  });
});
