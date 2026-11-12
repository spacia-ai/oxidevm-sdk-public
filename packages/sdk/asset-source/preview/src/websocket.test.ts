import { beforeAll, describe, expect, it, vi } from "vitest";

const HOST = "0123456789abcdef0123456789abcdef.oxvm.dev";
const posts: { readonly message: unknown }[] = [];
const natives: { readonly url: unknown; readonly protocols: unknown }[] = [];

class FakeNative {
  readonly opened = true;
  constructor(url: unknown, protocols: unknown) { natives.push({ url, protocols }); }
}

// The module replaces the global once and cannot be loaded twice, so every case shares one import.
beforeAll(async () => {
  vi.stubGlobal("navigator", { serviceWorker: { controller: { postMessage: (message: unknown) => { posts.push({ message }); } } } });
  vi.stubGlobal("location", { href: `https://${HOST}/app`, hostname: HOST, origin: `https://${HOST}` });
  vi.stubGlobal("WebSocket", FakeNative);
  await import("./websocket");
});

function open(...args: unknown[]): unknown {
  const Socket: unknown = Reflect.get(globalThis, "WebSocket");
  if (typeof Socket !== "function") throw new TypeError("WebSocket is missing");
  const socket: unknown = Reflect.construct(Socket, args);
  return socket;
}

describe("websocket.js routing", () => {
  it("replaces the global with a constructor that is not the browser's", () => {
    expect(Reflect.get(globalThis, "WebSocket")).not.toBe(FakeNative);
  });

  it("bridges the page's own host through the Service Worker with its path and protocols", () => {
    const socket = open(`wss://${HOST}/hmr?x=1`, ["a", "b"]);
    expect(socket).not.toBeInstanceOf(FakeNative);
    expect(natives).toEqual([]);
    expect(posts.at(-1)?.message).toMatchObject({ kind: "websocket", path: "/hmr?x=1", protocols: ["a", "b"] });
  });

  it("gives other hosts the browser's own socket with the URL and protocols", () => {
    const before = posts.length;
    const socket = open("wss://realtime.example.com/socket", ["v1"]);
    expect(socket).toBeInstanceOf(FakeNative);
    expect(natives.at(-1)).toEqual({ url: "wss://realtime.example.com/socket", protocols: ["v1"] });
    expect(posts).toHaveLength(before);
    open(new URL("wss://realtime.example.com/b"), "v2");
    expect(natives.at(-1)).toEqual({ url: new URL("wss://realtime.example.com/b"), protocols: "v2" });
  });

  it("rejects credentials, hashes and other schemes with a SecurityError", () => {
    for (const url of ["wss://u:p@x.example.com/", `wss://${HOST}/a#h`, "https://x.example.com/"]) {
      expect(() => open(url)).toThrow(expect.objectContaining({ name: "SecurityError" }));
    }
  });
});
