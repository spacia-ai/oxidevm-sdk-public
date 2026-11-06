import { afterEach, expect, it, vi } from "vitest";
import type { BootProgress } from "./contracts.js";
import { loadEngineAssets } from "./engine-assets.js";
import { retainEngineCompliance } from "./engine-assets-compliance.js";
import { engineLoad } from "./engine-load.js";
import { sha256Hex } from "./runtime/workers/snapshot-content.js";

/** A public build's engine release: its modules and the pinned compliance manifest naming four legal files. */
const release = await vi.hoisted(async () => {
  const { sha256Hex: digest } = await import("./runtime/workers/snapshot-content.js");
  const engine = "e".repeat(64), encoder = new TextEncoder();
  const modules = new Map([
    ["oxidevm_core.wasm", Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1)],
    ["oxidevm_core_shared.wasm", Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 2)],
    ["oxidevm_netstack.wasm", Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 3)],
    ["oxidevm_userspace.wasm", Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 4, 4, 4, 4)],
  ]);
  const legal = new Map([
    ["RUNTIME-LICENSE.txt", encoder.encode("runtime terms")], ["THIRD_PARTY_NOTICES.txt", encoder.encode("notices of every dependency")],
    ["sbom.cdx.json", encoder.encode("{\"bomFormat\":\"CycloneDX\"}")], ["license-policy.json", encoder.encode("{\"allowed\":[]}")],
  ]);
  const artifacts = [], files = [];
  for (const [name, bytes] of modules) artifacts.push({ name, mode: name === "oxidevm_userspace.wasm" ? "userspace" : "system", bytes: bytes.length, sha256: await digest(bytes) });
  for (const [name, bytes] of legal) files.push({ name, bytes: bytes.length, sha256: await digest(bytes) });
  const manifest = encoder.encode(JSON.stringify({ schemaVersion: 1, engineRelease: engine, files })), sha256 = await digest(manifest);
  return {
    engine, artifacts, legal: [...legal.keys()], bodies: new Map([...modules, ...legal, ["compliance.json", manifest]]),
    pin: { url: `https://cdn.oxidevm.dev/engine/${engine}/compliance/${sha256}/compliance.json`, bytes: manifest.length, sha256 },
  };
});
vi.mock("./engine.generated.js", () => ({
  engineReleaseId: release.engine, engineDownload: null, engineCompliance: release.pin,
  engineRelease: { schemaVersion: 3, engineSource: { commit: "c".repeat(40), dirty: false, nativeInputsSHA256: "d".repeat(64) }, identities: { coreApi: 16, jitAbi: 59, userspaceApi: 29, netstackApi: 2 }, artifacts: release.artifacts },
}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const base = "https://cdn.test/engine/";

interface Requested {
  readonly name: string;
  readonly signal: AbortSignal | null;
  /** Answers the request: by default with the file's pinned bytes. */
  respond(response?: Response): void;
}

/** Stands in for the network: every request waits until the test answers it. `request(name)` waits for that request. */
function network() {
  const requests: Requested[] = [], waiting = new Map<string, (request: Requested) => void>();
  vi.stubGlobal("fetch", (input: URL | string, init?: RequestInit) => {
    const name = new URL(String(input)).pathname.split("/").at(-1) ?? "", signal = init?.signal ?? null;
    const answer = Promise.withResolvers<Response>();
    signal?.addEventListener("abort", () => { answer.reject(new DOMException("The operation was aborted.", "AbortError")); }, { once: true });
    const request = { name, signal, respond: (response = new Response(release.bodies.get(name))) => { answer.resolve(response); } };
    requests.push(request); waiting.get(name)?.(request);
    return answer.promise;
  });
  return {
    names: () => requests.map(request => request.name),
    request: (name: string): Promise<Requested> => {
      const found = requests.find(request => request.name === name);
      if (found !== undefined) return Promise.resolve(found);
      const { promise, resolve } = Promise.withResolvers<Requested>(); waiting.set(name, resolve); return promise;
    },
  };
}
/** Lets every request the load can issue now reach the network. */
const issued = () => new Promise<void>(resolve => { setImmediate(resolve); });
const missing = (status: number) => new Response("missing", { status });

it("requests the compliance manifest first and the engine Wasm while the manifest is still pending", async () => {
  const served = network();
  const loading = loadEngineAssets("userspace", base);
  const manifest = await served.request("compliance.json");
  await issued();
  expect(served.names()).toEqual(["compliance.json", "oxidevm_userspace.wasm"]);
  const created = vi.spyOn(URL, "createObjectURL");
  (await served.request("oxidevm_userspace.wasm")).respond(); manifest.respond();
  const files = await Promise.all(release.legal.map(name => served.request(name)));
  for (const file of files.slice(1)) file.respond();
  await issued();
  expect(created).not.toHaveBeenCalled();
  files[0]?.respond();
  const assets = await loading;
  expect([...assets.urls.keys()]).toEqual(["oxidevm_userspace.wasm"]);
  expect(created).toHaveBeenCalledOnce();
  assets.dispose();
});

it("requests the manifest's four legal files at once", async () => {
  const served = network();
  const loading = loadEngineAssets("userspace", base);
  (await served.request("compliance.json")).respond();
  await served.request(release.legal[0] ?? "");
  await issued();
  expect(served.names()).toEqual(expect.arrayContaining(release.legal));
  for (const name of [...release.legal, "oxidevm_userspace.wasm"]) (await served.request(name)).respond();
  (await loading).dispose();
});

it("reports the first legal file failure in manifest order, whichever fails first, and creates no Blob URL", async () => {
  const served = network(), created = vi.spyOn(URL, "createObjectURL");
  const loading = loadEngineAssets("userspace", base);
  (await served.request("compliance.json")).respond(); (await served.request("oxidevm_userspace.wasm")).respond();
  const [terms, notices, sbom, policy] = await Promise.all(release.legal.map(name => served.request(name)));
  sbom?.respond(new Response("tampered")); policy?.respond(missing(404)); notices?.respond();
  await issued();
  terms?.respond(missing(503));
  await expect(loading).rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { status: 503 } });
  expect(created).not.toHaveBeenCalled();
});

it("reports a legal file failure before an engine module failure and cancels the downloads still running", async () => {
  const served = network(), created = vi.spyOn(URL, "createObjectURL");
  const loading = loadEngineAssets("system", base);
  const [core, shared, netstack] = await Promise.all(["oxidevm_core.wasm", "oxidevm_core_shared.wasm", "oxidevm_netstack.wasm"].map(name => served.request(name)));
  core?.respond(missing(404));
  (await served.request("compliance.json")).respond();
  const files = await Promise.all(release.legal.map(name => served.request(name)));
  files[1]?.respond(missing(410));
  for (const file of [files[0], files[2], files[3]]) file?.respond();
  const failure: unknown = await loading.then(() => undefined, (error: unknown) => error);
  expect(failure).toMatchObject({ code: "CORE_LOAD_FAILED", detail: { status: 410 } });
  expect(failure).not.toHaveProperty("detail.asset");
  expect([shared?.signal?.aborted, netstack?.signal?.aborted]).toEqual([true, true]);
  expect(created).not.toHaveBeenCalled();
});

it("reports the first engine module failure in release order once the legal files verify", async () => {
  const served = network();
  const loading = loadEngineAssets("system", base);
  (await served.request("oxidevm_netstack.wasm")).respond(missing(404));
  (await served.request("oxidevm_core.wasm")).respond();
  (await served.request("compliance.json")).respond();
  for (const name of release.legal) (await served.request(name)).respond();
  await issued();
  (await served.request("oxidevm_core_shared.wasm")).respond(new Response("tampered"));
  await expect(loading).rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { asset: "oxidevm_core_shared.wasm", engineRelease: release.engine } });
});

/** Serves every file at once, the Userspace module in two chunks. */
function serveAll(): void {
  const wasm = release.bodies.get("oxidevm_userspace.wasm") ?? new Uint8Array();
  vi.stubGlobal("fetch", (input: URL | string) => {
    const name = new URL(String(input)).pathname.split("/").at(-1) ?? "";
    return Promise.resolve(name !== "oxidevm_userspace.wasm" ? new Response(release.bodies.get(name))
      : new Response(new ReadableStream({ start: stream => { stream.enqueue(wasm.slice(0, 5)); stream.enqueue(wasm.slice(5)); stream.close(); } })));
  });
}
/** A Cache Storage stand-in; returns its responses by URL. */
function cacheStorage(): Map<string, Response> {
  const stored = new Map<string, Response>();
  vi.stubGlobal("caches", { open: () => Promise.resolve({ match: (url: URL) => Promise.resolve(stored.get(url.href)?.clone()), put: (url: URL, response: Response) => { stored.set(url.href, response.clone()); return Promise.resolve(); }, delete: (url: URL) => Promise.resolve(stored.delete(url.href)) }) });
  return stored;
}
/** Expects `events` to be one engine download of every Userspace load file's pinned size that ends complete and never goes backwards. */
function expectOneDownload(events: readonly BootProgress[]): void {
  const total = [...release.bodies.entries()].filter(([name]) => name === "oxidevm_userspace.wasm" || !name.endsWith(".wasm")).reduce((sum, [, bytes]) => sum + bytes.length, 0);
  const downloads = events.map(event => event.phase === "download" ? { asset: event.asset, completed: event.completedBytes, total: event.totalBytes } : { asset: event.phase, completed: -1, total: null });
  expect(new Set(downloads.map(download => `${download.asset} of ${String(download.total)}`))).toEqual(new Set([`engine of ${String(total)}`]));
  expect(downloads.map(download => download.completed)).toEqual(downloads.map(download => download.completed).toSorted((a, b) => a - b));
  expect(downloads.at(-1)?.completed).toBe(total);
}

it("reports one engine download against every pinned size, never backwards or past its total", async () => {
  serveAll();
  const events: BootProgress[] = [];
  (await loadEngineAssets("userspace", base, undefined, event => { events.push(event); })).dispose();
  expectOneDownload(events);
});

it("reports no engine download for a load the cache serves", async () => {
  cacheStorage(); serveAll();
  (await loadEngineAssets("userspace", base)).dispose();
  vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
  const events: BootProgress[] = [];
  (await loadEngineAssets("userspace", base, undefined, event => { events.push(event); })).dispose();
  expect(events).toEqual([]);
});

it("counts the files the cache verifies toward a load that downloads the rest", async () => {
  const stored = cacheStorage(); serveAll();
  (await loadEngineAssets("userspace", base)).dispose();
  for (const url of stored.keys()) if (url.includes("/THIRD_PARTY_NOTICES.txt?")) stored.delete(url);
  const events: BootProgress[] = [];
  (await loadEngineAssets("userspace", base, undefined, event => { events.push(event); })).dispose();
  expect(events.length).toBeGreaterThan(0);
  expectOneDownload(events);
});

it("browser startup retains and verifies all pinned engine legal materials before execution", async () => {
  const engine = "a".repeat(64), names = ["RUNTIME-LICENSE.txt", "THIRD_PARTY_NOTICES.txt", "sbom.cdx.json", "license-policy.json"];
  const encoder = new TextEncoder(), files = await Promise.all(names.map(async name => ({ name, bytes: name.length, sha256: await sha256Hex(encoder.encode(name)) })));
  const manifest = encoder.encode(JSON.stringify({ schemaVersion: 1, engineRelease: engine, files })), sha256 = await sha256Hex(manifest);
  const pin = { url: `https://cdn.oxidevm.dev/engine/${engine}/compliance/${sha256}/compliance.json`, bytes: manifest.length, sha256 };
  const fetcher = vi.fn((url: URL | RequestInfo) => { const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url; return Promise.resolve(new Response(href.endsWith("compliance.json") ? manifest : names.find(name => href.endsWith(name)) ?? "missing")); });
  vi.stubGlobal("fetch", fetcher);
  await expect(retainEngineCompliance("https://local.test/oxidevm/runtime/", pin, engine, engineLoad())).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(5);
  fetcher.mockImplementation(() => Promise.resolve(new Response("tampered terms")));
  await expect(retainEngineCompliance("https://local.test/oxidevm/runtime/", pin, engine, engineLoad())).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
  await expect(retainEngineCompliance("https://local.test/oxidevm/runtime/", null, engine, engineLoad())).resolves.toBeUndefined();
});
