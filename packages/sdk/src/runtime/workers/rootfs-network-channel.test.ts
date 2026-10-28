import { afterEach, describe, expect, it, vi } from "vitest";

import { RootfsNetworkClient, serveRootfsNetwork } from "./rootfs-network-channel.js";
import { record } from "../decode.js";
import { decodeBytes } from "../protocol/decoders.js";

afterEach(() => vi.unstubAllGlobals());

it("retains the network owner's transferred response buffer", async () => {
  const bytes = new TextEncoder().encode("immutable rootfs");
  const response=new Response(bytes);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response)));
  const channel = new MessageChannel();
  const received = Promise.withResolvers<Uint8Array>();
  channel.port1.addEventListener("message", (event: MessageEvent<unknown>) => {
    received.resolve(decodeBytes(record(event.data, "test response")["bytes"]));
  });
  serveRootfsNetwork(channel.port2);
  const client = new RootfsNetworkClient(channel.port1);
  try {
    const result = await client.fetchBlob(new URL("https://profiles.example/blob"), bytes.byteLength, await digest(bytes));
    expect(result).toEqual(bytes);
    expect(result.buffer).toBe((await received.promise).buffer);
    expect(response.body?.locked).toBe(false);
  } finally { client.close(); channel.port2.close(); }
});

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function connected(): RootfsNetworkClient {
  const channel = new MessageChannel();
  serveRootfsNetwork(channel.port2);
  return new RootfsNetworkClient(channel.port1);
}

describe("rootfs network channel", () => {
  it("attributes consumed response bytes and retry attempts to one bounded acquisition", async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValue(new Response(bytes)));
    const progress: { downloadedBytes: number; requestCount: number }[] = [], client = connected();
    try {
      expect(await client.fetchBlob(new URL("https://profiles.example/blob"), 3, await digest(bytes), undefined, "high", value => progress.push(value))).toEqual(bytes);
      expect(progress.at(-1)).toMatchObject({ downloadedBytes: 3, requestCount: 2 });
      expect(progress[0]).toMatchObject({ downloadedBytes: 0, requestCount: 1 });
    } finally { client.close(); }
  });
  it("treats only a missing transport as optional, retries transient failures, and preserves corruption failures", async () => {
    const client = connected();
    try {
      const get = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
      vi.stubGlobal("fetch", get);
      expect(await client.fetchTransport(new URL("https://profiles.example/transport.json"))).toBeUndefined();
      expect(get).toHaveBeenCalledOnce();
      get.mockReset().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValue(new Response("index"));
      expect(await client.fetchTransport(new URL("https://profiles.example/transport.json"))).toEqual(new TextEncoder().encode("index"));
      expect(get).toHaveBeenCalledTimes(2);
      get.mockReset().mockResolvedValue(new Response(null, { status: 403 }));
      await expect(client.fetchTransport(new URL("https://profiles.example/transport.json"))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    } finally { client.close(); }
  });
  it("gives background acquisition a lower browser fetch priority",async()=>{
    const bytes=Uint8Array.of(1),fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes));vi.stubGlobal("fetch",fetcher);
    const client=connected();
    try {await client.fetchBlob(new URL("https://profiles.example/blob"),1,await digest(bytes),undefined,"low");expect(fetcher.mock.calls[0]?.[1]).toMatchObject({priority:"low"});}
    finally {client.close();}
  });
  it.each([408, 429, 500, 503])("retries a transient %i for an immutable blob before returning verified bytes", async status => {
    const bytes = new TextEncoder().encode("retry-safe immutable rootfs");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("unavailable", { status })).mockResolvedValue(new Response(bytes));
    vi.stubGlobal("fetch", fetcher);
    const client = connected();
    try {
      expect(await client.fetchBlob(new URL("https://profiles.example/blob"), bytes.length, await digest(bytes))).toEqual(bytes);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: "force-cache", credentials: "omit" });
      expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ cache: "reload", credentials: "omit" });
    } finally { client.close(); }
  });

  it("retries a disconnected immutable response, but caps unsuccessful acquisition at three attempts", async () => {
    const bytes = new TextEncoder().encode("complete immutable bytes");
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("network unavailable")).mockResolvedValue(new Response(bytes));
    vi.stubGlobal("fetch", fetcher);
    const client = connected();
    try {
      expect(await client.fetchBlob(new URL("https://profiles.example/blob"), bytes.length, await digest(bytes))).toEqual(bytes);
      expect(fetcher).toHaveBeenCalledTimes(2);
      const offline = vi.fn(() => Promise.reject(new TypeError("offline")));
      vi.stubGlobal("fetch", offline);
      await expect(client.fetchBlob(new URL("https://profiles.example/blob"), bytes.length, await digest(bytes))).rejects.toThrow();
      expect(offline).toHaveBeenCalledTimes(3);
    } finally { client.close(); }
  });

  it("does not retry a missing file or a response with invalid immutable content", async () => {
    const bytes = new TextEncoder().encode("rootfs");
    const fetcher = vi.fn(() => Promise.resolve(new Response("missing", { status: 404 })));
    vi.stubGlobal("fetch", fetcher);
    const client = connected();
    try {
      await expect(client.fetchBlob(new URL("https://profiles.example/blob"), bytes.length, await digest(bytes))).rejects.toThrow(/404/u);
      expect(fetcher).toHaveBeenCalledOnce();
      const corrupt = vi.fn(() => Promise.resolve(new Response(bytes)));
      vi.stubGlobal("fetch", corrupt);
      await expect(client.fetchBlob(new URL("https://profiles.example/blob"), bytes.length, "0".repeat(64))).rejects.toThrow(/SHA-256/u);
      expect(corrupt).toHaveBeenCalledOnce();
    } finally { client.close(); }
  });

  it("cancels a blob during retry backoff without issuing the next request", async () => {
    const failed = Promise.withResolvers<undefined>();
    const fetcher = vi.fn(() => { failed.resolve(undefined); return Promise.resolve(new Response(null, { status: 503 })); });
    vi.stubGlobal("fetch", fetcher);
    const client = connected();
    try {
      const pending = client.fetchBlob(new URL("https://profiles.example/blob"), 1, "0".repeat(64));
      const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
      await failed.promise;
      client.cancelAll();
      await rejected;
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { client.close(); }
  });

  it("cancels only an optional manifest lookup and admits later requests", async () => {
    const started = Promise.withResolvers<undefined>();
    let aborted = 0;
    vi.stubGlobal("fetch", vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted++; reject(new DOMException("aborted", "AbortError")); }, { once: true });
      started.resolve(undefined);
    })));
    const client = connected(), controller = new AbortController();
    const pending = client.fetchManifest(new URL("https://profiles.example/manifest.json"), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await started.promise; controller.abort();
    await rejected;
    expect(aborted).toBe(1);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("later"))));
    expect(await client.fetchManifest(new URL("https://profiles.example/later.json"))).toEqual(new TextEncoder().encode("later"));
    client.close();
  });

  it("transfers tooling manifests larger than the legacy 8 MiB limit", async () => {
    const bytes = new Uint8Array(12 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(bytes))));
    const client = connected();
    try {
      const received = await client.fetchManifest(new URL("https://profiles.example/manifest.json"));
      expect(received.byteLength).toBe(bytes.byteLength);
      expect(await digest(received)).toBe(await digest(bytes));
    } finally { client.close(); }
  });

  it("cancels a manifest response above the bounded metadata limit", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(8 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    })))));
    const client = connected();
    try {
      await expect(client.fetchManifest(new URL("https://profiles.example/manifest.json"))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
      expect(cancelled).toBe(true);
    } finally { client.close(); }
  });

  it("returns only a blob with the declared length and digest", async () => {
    const bytes = new TextEncoder().encode("rootfs");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(bytes))));
    const client = connected();
    await expect(client.fetchBlob(new URL("https://profiles.example/blob"), bytes.byteLength, await digest(bytes))).resolves.toEqual(bytes);
    await expect(client.fetchBlob(new URL("https://profiles.example/blob"), bytes.byteLength, "0".repeat(64))).rejects.toThrow(/SHA-256/u);
    client.close();
  });

  it("aborts an in-flight fetch exactly once", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    const client = connected();
    const pending = client.fetchManifest(new URL("https://profiles.example/manifest.json"));
    client.cancelAll();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    client.close();
  });
});
