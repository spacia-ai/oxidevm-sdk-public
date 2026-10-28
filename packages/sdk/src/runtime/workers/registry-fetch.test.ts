import { afterEach, expect, it, vi } from "vitest";
import { openRegistryResponse } from "./registry-fetch.js";

afterEach(() => vi.unstubAllGlobals());

function response(parts: readonly number[][], headers: Record<string, string> = {}) {
  let index = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream({
    type: "bytes",
    pull(controller) {
      const part = parts[index++];
      if (part === undefined) {
        controller.close();
        controller.byobRequest?.respond(0);
      } else controller.enqueue(new Uint8Array(part));
    },
    cancel,
  });
  return { value: new Response(stream, { headers }), cancel };
}

const url = "https://registry.npmjs.org/@scope%2Fpackage";
const policy = { origin: "https://registry.npmjs.org", maximumBytes: 1024 };

it("preserves pnpm's abbreviated metadata selection without changing full requests", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(response([], { "content-type": "application/json" }).value));
  vi.stubGlobal("fetch", fetcher);
  for (const representation of ["install", "full"] as const) {
    const opened = await openRegistryResponse(url, policy, new AbortController().signal, representation);
    try {
      expect(fetcher).toHaveBeenLastCalledWith(url, expect.objectContaining({
        headers: { accept: representation === "install" ? "application/vnd.npm.install-v1+json" : "application/json" },
      }));
    } finally { await opened.close(); }
  }
});

it("requests complete metadata so pnpm can enforce release-age policy", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([], { "content-type": "application/json" }).value);
  vi.stubGlobal("fetch", fetcher);
  const opened = await openRegistryResponse(url, policy, new AbortController().signal);
  try {
    expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ headers: { accept: "application/json" } }));
  } finally { await opened.close(); }
});

it("rewrites only admitted metadata tarballs and removes the original HTTP length", async () => {
  const tarball = "https://registry.npmjs.org/@scope/package/-/package-1.0.0.tgz";
  // A tarball URL outside a dist object stays as it is; kept fields carry them
  // here because the rewriter blanks the fields pnpm never installs from.
  const metadata = JSON.stringify({ time: { "1.0.0": tarball }, versions: { "1.0.0": {
    dist: { tarball, integrity: "sha512-preserved" }, directories: { tarball },
  }, "2.0.0": { dist: { tarball: "https://external.test/package.tgz" } } } });
  const bytes = new TextEncoder().encode(metadata);
  const source = response(Array.from(bytes, byte => [byte]), { "content-type": "application/json", "content-length": String(bytes.length) });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(source.value));
  const rewrite = { ...policy, gatewayOrigin: "http://127.0.0.1:8080" };
  const opened = await openRegistryResponse(url, rewrite, new AbortController().signal);
  try {
    const output: number[] = [];
    for (;;) {
      const part = await opened.read(new Uint8Array(17)); output.push(...part.bytes);
      if (part.done) break;
    }
    expect(new TextDecoder().decode(new Uint8Array(output))).toBe(metadata.replace(
      '"dist":{"tarball":"https://registry.npmjs.org/', '"dist":{"tarball":"http://127.0.0.1:8080/'));
    expect(opened.headers.some(([name]) => name === "content-length")).toBe(false);
  } finally { await opened.close(); }
});

it("fills granted metadata frames without exposing the parser's smaller input chunks", async () => {
  // Bulk lives in a kept field: the rewriter blanks descriptive root fields.
  const metadata = JSON.stringify({ time: { "1.0.0": "2026-01-01T00:00:00Z", note: "x".repeat(192 * 1024) },
    versions: { "1.0.0": { dist: { tarball: "https://registry.npmjs.org/example/-/example-1.0.0.tgz", integrity: "sha512-preserved" } } } });
  const bytes = new TextEncoder().encode(metadata);
  const source = response([Array.from(bytes)], { "content-type": "application/json" });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(source.value));
  const opened = await openRegistryResponse(url, { ...policy, maximumBytes: bytes.length,
    gatewayOrigin: "http://127.0.0.1:8080" }, new AbortController().signal);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  try {
    for (;;) {
      const part = await opened.read(new Uint8Array(65_536));
      parts.push(part.bytes);
      if (part.done) break;
      expect(part.bytes.length).toBe(65_536);
    }
    expect(parts).toHaveLength(4);
    expect(await new Blob(parts).text()).toBe(metadata.replace('"tarball":"https://registry.npmjs.org/', '"tarball":"http://127.0.0.1:8080/'));
  } finally { await opened.close(); }
});

it("uses credential-free HTTPS and caller-sized byte reads instead of buffering a tarball", async () => {
  const source = response([[1, 2, 3], [4, 5]], { "content-length": "5", "content-type": "application/octet-stream" });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(source.value);
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  const opened = await openRegistryResponse(url, policy, controller.signal);
  expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: "omit", redirect: "error", signal: controller.signal }));
  expect(opened.status).toBe(200);
  const actual: number[] = [];
  for (;;) {
    const result = await opened.read(new Uint8Array(2));
    actual.push(...result.bytes);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(2);
    if (result.done) break;
  }
  expect(actual).toEqual([1, 2, 3, 4, 5]);
  await opened.close();
  await expect(opened.read(new Uint8Array(2))).rejects.toMatchObject({ code: "ABORTED" });
});

it("rejects destination substitution before making a network request", async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  for (const destination of ["http://registry.npmjs.org/react", "https://evil.test/react", "https://user:secret@registry.npmjs.org/react", "https://registry.npmjs.org/react#token"]) {
    await expect(openRegistryResponse(destination, policy, new AbortController().signal)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it("detects truncated and excess content and never accepts an oversized body", async () => {
  for (const [length, parts, maximum] of [[3, [[1]], 10], [1, [[1, 2]], 10], [undefined, [[1, 2]], 1]] as const) {
    const source = response(parts.map(part => [...part]), length === undefined ? {} : { "content-length": String(length) });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(source.value));
    const opened = await openRegistryResponse(url, { ...policy, maximumBytes: maximum }, new AbortController().signal);
    await expect((async () => {
      while (!(await opened.read(new Uint8Array(2))).done) { /* Drain to the verified EOF. */ }
    })()).rejects.toMatchObject({ code: length === undefined ? "QUOTA_EXCEEDED" : "PROTOCOL_ERROR" });
    await opened.close();
  }
});

it("cancels rejected headers and reports unavailable direct transport as a relay error", async () => {
  const large = response([], { "content-length": "1025" });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(large.value));
  await expect(openRegistryResponse(url, policy, new AbortController().signal)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  expect(large.cancel).toHaveBeenCalledOnce();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch")));
  await expect(openRegistryResponse(url, policy, new AbortController().signal)).rejects.toMatchObject({ code: "RELAY_ERROR" });
});

it("does not compare decoded bytes with a compressed Content-Length or forward cookies", async () => {
  const source = response([[1, 2]], { "content-length": "99", "content-encoding": "gzip", "set-cookie": "secret=value" });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(source.value));
  const opened = await openRegistryResponse(url, policy, new AbortController().signal);
  expect(opened.headers.some(([key]) => ["content-length", "content-encoding", "set-cookie"].includes(key))).toBe(false);
  expect((await opened.read(new Uint8Array(2))).bytes).toEqual(new Uint8Array([1, 2]));
  expect((await opened.read(new Uint8Array(2))).done).toBe(true);
  await opened.close();
});

it("preserves header rejection when retiring the rejected response also fails", async () => {
  const body = new ReadableStream({ type: "bytes", cancel() { throw new Error("upstream already lost"); } });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { "content-length": "1025" } })));
  await expect(openRegistryResponse(url, policy, new AbortController().signal)).rejects.toMatchObject({
    code: "QUOTA_EXCEEDED",
    detail: { cleanupFailed: true },
  });
});

it("does not trust a CORS-visible length when Content-Encoding may be hidden", async () => {
  const source = response([[1, 2]], { "content-length": "99" });
  Object.defineProperty(source.value, "type", { value: "cors" });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(source.value));
  const opened = await openRegistryResponse(url, policy, new AbortController().signal);
  expect(opened.headers.some(([name]) => name === "content-length")).toBe(false);
  expect((await opened.read(new Uint8Array(2))).bytes).toEqual(new Uint8Array([1, 2]));
  expect((await opened.read(new Uint8Array(2))).done).toBe(true);
  await opened.close();
});

it("rejects concurrent reads and cancels a blocked reader on close", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ type: "bytes", cancel });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
  const opened = await openRegistryResponse(url, policy, new AbortController().signal);
  const read = opened.read(new Uint8Array(2));
  const rejected = expect(read).rejects.toMatchObject({ code: "ABORTED" });
  await expect(opened.read(new Uint8Array(2))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await opened.close();
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
});

it("does not detach an unaccounted backing allocation through a small view", async () => {
  const source = response([[1]]);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(source.value));
  const opened = await openRegistryResponse(url, policy, new AbortController().signal);
  for (const view of [new Uint8Array(65_537), new Uint8Array(0), new Uint8Array(new ArrayBuffer(131_072), 0, 2)]) {
    await expect(opened.read(view)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  }
  await opened.close();
});

it("does not issue a fetch after cancellation and retires a response arriving after abort", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  await expect(openRegistryResponse(url, policy, aborted.signal)).rejects.toMatchObject({ code: "ABORTED" });
  expect(fetcher).not.toHaveBeenCalled();
  const controller = new AbortController();
  const source = response([[1]]);
  fetcher.mockImplementation(() => { controller.abort(); return Promise.resolve(source.value); });
  await expect(openRegistryResponse(url, policy, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
  expect(source.cancel).toHaveBeenCalledOnce();
});

it("retires an aborted fetch reader without turning ordinary cancellation into cleanup failure", async () => {
  const controller = new AbortController();
  const body = new ReadableStream({
    type: "bytes",
    start(stream) {
      controller.signal.addEventListener("abort", () => stream.error(new DOMException("cancelled", "AbortError")), { once: true });
    },
  });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
  const opened = await openRegistryResponse(url, policy, controller.signal);
  const read = opened.read(new Uint8Array(2));
  const failed = expect(read).rejects.toMatchObject({ code: "ABORTED" });
  controller.abort();
  await failed;
  await expect(opened.close()).resolves.toBeUndefined();
});

it("reports interrupted response bodies through the stable relay error family", async () => {
  const body = new ReadableStream({ type: "bytes", pull(stream) { stream.error(new TypeError("upstream failed")); } });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
  const opened = await openRegistryResponse(url, policy, new AbortController().signal);
  await expect(opened.read(new Uint8Array(2))).rejects.toMatchObject({ code: "RELAY_ERROR" });
  await expect(opened.close()).rejects.toMatchObject({ code: "RELAY_ERROR" });
});

it("bounds encoded headers rather than accepting a reply that cannot fit its envelope", async () => {
  const source = response([], { "content-type": '"'.repeat(65_500) });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(source.value));
  await expect(openRegistryResponse(url, policy, new AbortController().signal)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  expect(source.cancel).toHaveBeenCalledOnce();
});


it("does not hide an upstream cleanup failure when cancellation races retirement", async () => {
  const controller = new AbortController();
  const cleanup = Promise.withResolvers<undefined>();
  const cancel = vi.fn(() => cleanup.promise);
  const body = new ReadableStream({ type: "bytes", cancel });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
  const opened = await openRegistryResponse(url, policy, controller.signal);
  const closing = opened.close();
  const failed = expect(closing).rejects.toMatchObject({ code: "RELAY_ERROR", message: "Registry response cleanup failed" });
  controller.abort();
  cleanup.reject(new Error("upstream cleanup failed"));
  await failed;
  expect(cancel).toHaveBeenCalledOnce();
  expect(opened.close()).toBe(closing);
});

it("prunes a frozen package's metadata and omits its validators, serving other packages verbatim", async () => {
  const document = JSON.stringify({ name: "next", etag: "W/\"e\"", "dist-tags": { latest: "16.2.12" },
    time: { "15.0.0": "2024-01-01T00:00:00Z", "16.2.12": "2026-01-01T00:00:00Z" },
    versions: { "15.0.0": { name: "next", version: "15.0.0", dependencies: { a: "1" }, dist: { tarball: "https://registry.npmjs.org/next/-/next-15.0.0.tgz", integrity: "sha512-o" } },
      "16.2.12": { name: "next", version: "16.2.12", dependencies: { a: "1" }, dist: { tarball: "https://registry.npmjs.org/next/-/next-16.2.12.tgz", integrity: "sha512-n" } } } });
  const bytes = [...new TextEncoder().encode(document)];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(response([bytes],
    { "content-type": "application/json", etag: "W/\"e\"", "last-modified": "Mon, 28 Sep 2026 00:00:00 GMT", "cache-control": "public" }).value));
  vi.stubGlobal("fetch", fetcher);
  const gateway = { ...policy, maximumBytes: 65_536, gatewayOrigin: "http://127.0.0.1:4873", frozenVersions: { next: ["16.2.12"] } };
  const pruned = await openRegistryResponse("https://registry.npmjs.org/next", gateway, new AbortController().signal, "full");
  try {
    expect(pruned.headers.map(([name]) => name).sort()).toEqual(["cache-control", "content-type"]);
    let text = "";
    const decoder = new TextDecoder();
    const buffer = new Uint8Array(65_536);
    for (;;) { const chunk = await pruned.read(buffer); text += decoder.decode(chunk.bytes, { stream: true }); if (chunk.done) break; }
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toEqual({ name: "next", etag: "", "dist-tags": { latest: "16.2.12" },
      time: { "15.0.0": "2024-01-01T00:00:00Z", "16.2.12": "2026-01-01T00:00:00Z" },
      versions: { "15.0.0": { name: "", version: "", dependencies: {}, dist: { tarball: "", integrity: "" } },
        "16.2.12": { name: "next", version: "16.2.12", dependencies: { a: "1" }, dist: { tarball: "http://127.0.0.1:4873/next/-/next-16.2.12.tgz", integrity: "sha512-n" } } } });
  } finally { await pruned.close(); }
  const other = await openRegistryResponse("https://registry.npmjs.org/@scope%2Fpackage", gateway, new AbortController().signal, "full");
  try { expect(other.headers.map(([name]) => name).sort()).toEqual(["cache-control", "content-type", "etag", "last-modified"]); }
  finally { await other.close(); }
});


it("uses an authorized relay only after direct CORS fails, retaining grant and integrity ownership", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("CORS")));
  const relay=vi.fn().mockResolvedValue(response([[1,2,3]],{"content-type":"application/octet-stream"}).value);
  const opened=await openRegistryResponse(url,policy,new AbortController().signal,"full",relay);
  expect(relay).toHaveBeenCalledWith(url,policy,"full",expect.any(AbortSignal));
  expect((await opened.read(new Uint8Array(8))).bytes).toEqual(new Uint8Array([1,2,3]));await opened.close();
  await expect(openRegistryResponse("https://private.example/",policy,new AbortController().signal,"full",relay)).rejects.toMatchObject({code:"PERMISSION_DENIED"});
  expect(relay).toHaveBeenCalledTimes(1);
});
