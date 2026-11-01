import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchBytes, fetchJSON, fetchToFile, request, type Fetch } from "./fetch.js";
import { fakeNetwork, testPolicy } from "./fetch.test-support.js";
import { sha } from "./release.test-support.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "oxidevm-fetch-")); directories.push(directory); return directory; }
const options = (fetchImpl: Fetch, headers: Record<string, string> = {}) => ({ headers, redirect: testPolicy, timeoutMs: 5000, fetchImpl });
const url = (value: string) => new URL(value);
const failed = async (work: Promise<unknown>): Promise<unknown> => { try { await work; } catch (error: unknown) { return error; } return undefined; };

describe("requests with checked redirects", () => {
  it("sends the caller's headers on the first request only and resolves relative redirects", async () => {
    const { fetchImpl, calls } = fakeNetwork({
      "https://api.test/asset": { status: 302, headers: { location: "https://storage.test/blob/1" } },
      "https://storage.test/blob/1": { status: 307, headers: { location: "/blob/2" } },
      "https://storage.test/blob/2": { body: "payload" },
    });
    const response = await request(url("https://api.test/asset"), options(fetchImpl, { Authorization: "Bearer secret", Accept: "application/octet-stream" }));
    expect(await response.text()).toBe("payload");
    expect(calls.map(call => call.url)).toEqual(["https://api.test/asset", "https://storage.test/blob/1", "https://storage.test/blob/2"]);
    expect(calls[0]?.headers).toMatchObject({ authorization: "Bearer secret", accept: "application/octet-stream" });
    expect(calls[1]?.headers).toEqual({});
    expect(calls[2]?.headers).toEqual({});
  });

  it("never requests an address the policy forbids, whether first or after a redirect", async () => {
    const { fetchImpl, calls } = fakeNetwork({ "https://api.test/a": { status: 302, headers: { location: "https://evil.example/steal" } }, "https://api.test/b": { status: 302, headers: { location: "http://storage.test/plain" } } });
    await expect(request(url("https://evil.example/x"), options(fetchImpl))).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "wasm-module-download" } });
    await expect(request(url("https://api.test/a"), options(fetchImpl))).rejects.toThrow(/evil.example is not an allowed/u);
    await expect(request(url("https://api.test/b"), options(fetchImpl))).rejects.toThrow(/not an allowed/u);
    expect(calls.map(call => call.url)).toEqual(["https://api.test/a", "https://api.test/b"]);
  });

  it("gives up after too many redirects, on a redirect without a location and on an unreachable host", async () => {
    const loop = { status: 302, headers: { location: "https://loop.test/again" } };
    const looping = fakeNetwork({ "https://loop.test/again": loop });
    await expect(request(url("https://loop.test/again"), options(looping.fetchImpl))).rejects.toThrow(/more than 3 redirects/u);
    expect(looping.calls).toHaveLength(4);
    await expect(request(url("https://api.test/x"), options(fakeNetwork({ "https://api.test/x": { status: 302 } }).fetchImpl))).rejects.toThrow(/no location/u);
    const unreachable: Fetch = () => Promise.reject(new TypeError("fetch failed"));
    await expect(request(url("https://api.test/x"), options(unreachable))).rejects.toThrow(/could not be reached/u);
  });

  it("reports a request that exceeds its deadline as a failure to reach the host in time", async () => {
    const hanging: Fetch = (_url, init) => new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener("abort", () => { reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error("aborted")); }); });
    await expect(request(url("https://api.test/slow"), { ...options(hanging), timeoutMs: 20 })).rejects.toThrow(/in time/u);
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(request(url("https://api.test/x"), { ...options(fakeNetwork({}).fetchImpl), signal: controller.signal })).rejects.toMatchObject({ code: "ABORTED" });
  });
});

describe("bounded reads", () => {
  it("returns small bodies and parses JSON", async () => {
    const { fetchImpl } = fakeNetwork({ "https://api.test/json": { body: '{"a":[1,2]}' }, "https://api.test/text": { body: "hello" } });
    expect(await fetchJSON(url("https://api.test/json"), 1024, options(fetchImpl))).toEqual({ a: [1, 2] });
    expect(new TextDecoder().decode(await fetchBytes(url("https://api.test/text"), 1024, options(fetchImpl)))).toBe("hello");
  });

  it("refuses a body over the limit, an error status and text that is not JSON", async () => {
    const { fetchImpl } = fakeNetwork({ "https://api.test/big": { body: "x".repeat(100) }, "https://api.test/missing": { status: 404 }, "https://api.test/html": { body: "<html>" } });
    await expect(fetchBytes(url("https://api.test/big"), 99, options(fetchImpl))).rejects.toThrow(/larger than 99 bytes/u);
    expect(await failed(fetchBytes(url("https://api.test/missing"), 99, options(fetchImpl)))).toMatchObject({ detail: { status: 404 } });
    await expect(fetchJSON(url("https://api.test/html"), 99, options(fetchImpl))).rejects.toThrow(/not JSON/u);
  });
});

describe("downloads to a file", () => {
  it("streams to disk while hashing and returns the size and digest", async () => {
    const directory = await temporary();
    const bytes = new TextEncoder().encode("module bytes".repeat(1000));
    const { fetchImpl } = fakeNetwork({ "https://dl.test/file": { body: bytes } });
    const result = await fetchToFile(url("https://dl.test/file"), { path: join(directory, "out", "file"), maxBytes: 1_000_000, expectedBytes: bytes.length, expectedSha256: sha(bytes) }, options(fetchImpl));
    expect(result).toEqual({ bytes: bytes.length, sha256: sha(bytes) });
    expect(new Uint8Array(await readFile(join(directory, "out", "file")))).toEqual(bytes);
  });

  it("removes the partial file and says so when the size or digest is not the pinned one", async () => {
    const directory = await temporary();
    const bytes = new TextEncoder().encode("0123456789");
    const { fetchImpl } = fakeNetwork({ "https://dl.test/file": { body: bytes } });
    for (const [label, target] of [
      ["wrong digest", { expectedSha256: "0".repeat(64) }], ["short", { expectedBytes: 11 }], ["too long for the pin", { expectedBytes: 9 }],
    ] as const) {
      const path = join(directory, label);
      const error = await failed(fetchToFile(url("https://dl.test/file"), { path, maxBytes: 1000, ...target }, options(fetchImpl)));
      expect(error, label).toMatchObject({ detail: { reason: expect.stringMatching(/wasm-module-(integrity|download)/u) as unknown } });
      await expect(stat(path), label).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("cuts off a body that exceeds its limit, declared or not, and leaves nothing behind", async () => {
    const directory = await temporary();
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(1024)); } });
    const { fetchImpl } = fakeNetwork({ "https://dl.test/endless": { body: endless }, "https://dl.test/declared": { headers: { "content-length": "5000" }, body: new Uint8Array(10) } });
    await expect(fetchToFile(url("https://dl.test/endless"), { path: join(directory, "a"), maxBytes: 4096 }, options(fetchImpl))).rejects.toThrow(/exceeds the 4096 bytes/u);
    expect(pulls).toBeLessThan(10);
    await expect(fetchToFile(url("https://dl.test/declared"), { path: join(directory, "b"), maxBytes: 4096 }, options(fetchImpl))).rejects.toThrow(/declares 5000 bytes/u);
    await expect(stat(join(directory, "a"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(directory, "b"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites an existing file", async () => {
    const directory = await temporary();
    await writeFile(join(directory, "taken"), "keep");
    const { fetchImpl } = fakeNetwork({ "https://dl.test/file": { body: "new" } });
    await expect(fetchToFile(url("https://dl.test/file"), { path: join(directory, "taken"), maxBytes: 100 }, options(fetchImpl))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(directory, "taken"), "utf8")).toBe("keep");
  });
});
