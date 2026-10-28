import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPinnedBytes, loadEngineAssets } from "./engine-assets.js";
import { sha256Hex } from "./runtime/workers/snapshot-content.js";

/** Stand-in modules for a pinned release, so a test can serve the exact bytes the pin names. */
const modules = vi.hoisted(() => new Map([
  ["oxidevm_core.wasm", Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1)],
  ["oxidevm_core_shared.wasm", Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 2)],
  ["oxidevm_netstack.wasm", Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 3)],
  ["oxidevm_userspace.wasm", Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 4)],
]));
vi.mock("./engine.generated.js", async () => {
  const { sha256Hex: digest } = await import("./runtime/workers/snapshot-content.js");
  const artifacts = [];
  for (const [name, bytes] of modules) artifacts.push({ name, mode: name === "oxidevm_userspace.wasm" ? "userspace" : "system", bytes: bytes.length, sha256: await digest(bytes) });
  return {
    engineReleaseId: "e".repeat(64), engineDownload: null, engineCompliance: null,
    engineRelease: { schemaVersion: 3, engineSource: { commit: "c".repeat(40), dirty: false, nativeInputsSHA256: "d".repeat(64) }, identities: { coreApi: 16, jitAbi: 59, userspaceApi: 29, netstackApi: 2 }, artifacts },
  };
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function cached(initial?: Uint8Array) {
  const bodies = new Map<string, Response>();
  const cache = {
    match: (url: URL) => Promise.resolve(bodies.get(url.href)?.clone()),
    put: (url: URL, response: Response) => { bodies.set(url.href, response.clone()); return Promise.resolve(); },
    delete: (url: URL) => Promise.resolve(bodies.delete(url.href)),
  };
  vi.stubGlobal("caches", { open: () => Promise.resolve(cache) });
  return { cache, bodies, seed: (url: URL) => { if (initial !== undefined) bodies.set(url.href, new Response(initial.slice())); } };
}

it("loads a verified cached asset without any network download or download progress", async () => {
  cached();
  const bytes = Uint8Array.of(1, 2, 3), url = new URL("https://assets.test/pinned.wasm"), digest = await sha256Hex(bytes);
  const network = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes));
  vi.stubGlobal("fetch", network);
  await fetchPinnedBytes(url, digest, "engine", undefined, undefined, bytes.length);
  network.mockRejectedValue(new TypeError("offline"));
  const progress = vi.fn();
  expect(await fetchPinnedBytes(url, digest, "engine", undefined, progress, bytes.length)).toEqual(bytes);
  expect(network).toHaveBeenCalledTimes(1);
  expect(progress).not.toHaveBeenCalled();
});

it("caches pinned compiler bytes without reporting them as initial shell downloads", async () => {
  cached();
  const bytes = Uint8Array.of(1, 2, 3), url = new URL("https://assets.test/esbuild.wasm"), digest = await sha256Hex(bytes);
  const network = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes)), progress = vi.fn();
  vi.stubGlobal("fetch", network);
  expect(await fetchPinnedBytes(url, digest, "compiler", undefined, progress, bytes.length)).toEqual(bytes);
  expect(await fetchPinnedBytes(url, digest, "compiler", undefined, progress, bytes.length)).toEqual(bytes);
  expect(network).toHaveBeenCalledOnce(); expect(progress).not.toHaveBeenCalled();
  network.mockResolvedValue(new Response(Uint8Array.of(9)));
  await expect(fetchPinnedBytes(url, "f".repeat(64), "compiler", undefined, undefined, bytes.length)).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
});

it.each([Uint8Array.of(9, 9, 9), Uint8Array.of(1)])("repairs an invalid cached asset before executing its replacement", async broken => {
  const bytes = Uint8Array.of(1, 2, 3), url = new URL("https://assets.test/pinned.wasm"), digest = await sha256Hex(bytes);
  const storage = cached(broken), key = new URL(url); key.searchParams.set("oxidevm-sha256", digest); storage.seed(key);
  const deletion = vi.spyOn(storage.cache, "delete");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes)));
  expect(await fetchPinnedBytes(url, digest, "engine", undefined, undefined, bytes.length)).toEqual(bytes);
  expect(deletion).toHaveBeenCalledOnce();
  expect(new Uint8Array(await (await storage.cache.match(key))?.arrayBuffer() ?? new ArrayBuffer(0))).toEqual(bytes);
});

/** Serves every pinned module at its name, except `replace`d ones (a status or other bytes). */
function serve(replace: ReadonlyMap<string, Uint8Array | number> = new Map()): void {
  vi.stubGlobal("fetch", (input: URL | string) => {
    const name = new URL(String(input)).pathname.split("/").at(-1) ?? "";
    const replacement = replace.get(name);
    if (typeof replacement === "number") return Promise.resolve(new Response("missing", { status: replacement }));
    const body = replacement ?? modules.get(name);
    return Promise.resolve(body === undefined ? new Response("missing", { status: 404 }) : new Response(new Uint8Array(body)));
  });
}

it("rejects a mismatched engine before a worker can execute it", async () => {
  vi.stubGlobal("fetch", () => Promise.resolve(new Response(new Uint8Array([0, 97, 115, 109]))));
  await expect(loadEngineAssets("userspace", "https://assets.test/", undefined)).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
});
it("honors a pre-aborted asset request without starting a download", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(loadEngineAssets("system", "https://assets.test/", AbortSignal.abort())).rejects.toMatchObject({ code: "ABORTED" });
  expect(fetch).not.toHaveBeenCalled();
});
it("revalidates digest-qualified cached bytes offline and never hides a server or cache-integrity error", async () => {
  const stored = new Map<string, Response>();
  vi.stubGlobal("caches", { open: () => Promise.resolve({ match: (url: URL) => Promise.resolve(stored.get(String(url))?.clone()), put: (url: URL, response: Response) => { stored.set(String(url), response.clone()); return Promise.resolve(); }, delete: (url: URL) => Promise.resolve(stored.delete(String(url))) }) });
  const bytes = new TextEncoder().encode("pinned"); const digest = await sha256Hex(bytes); const url = new URL("https://assets.test/core.wasm");
  vi.stubGlobal("fetch", () => Promise.resolve(new Response(bytes)));
  expect(await fetchPinnedBytes(url, digest, "engine")).toEqual(bytes);
  vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
  expect(await fetchPinnedBytes(url, digest, "engine")).toEqual(bytes);
  for (const key of stored.keys()) stored.set(key, new Response("tampered"));
  await expect(fetchPinnedBytes(url, digest, "engine")).rejects.toThrow(/SHA-256/u);
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("missing", { status: 404 })));
  await expect(fetchPinnedBytes(url, digest, "engine")).rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { status: 404 } });
});

describe("modules served from the runtime base URL", () => {
  it("returns a Blob URL for each module of the mode once every pinned module verifies", async () => {
    serve();
    const created = vi.spyOn(URL, "createObjectURL"); const revoked = vi.spyOn(URL, "revokeObjectURL");
    const assets = await loadEngineAssets("system", "https://assets.test/oxidevm/runtime/");
    expect([...assets.urls.keys()]).toEqual(["oxidevm_core.wasm", "oxidevm_core_shared.wasm", "oxidevm_netstack.wasm"]);
    expect(created).toHaveBeenCalledTimes(3);
    assets.dispose();
    expect(revoked).toHaveBeenCalledTimes(3);
  });

  const shared = modules.get("oxidevm_core_shared.wasm") ?? new Uint8Array();
  it.each([
    ["wrong bytes", Uint8Array.from(shared, (byte, index) => index === shared.length - 1 ? byte ^ 1 : byte)],
    ["a wrong length", Uint8Array.of(...shared, 0)],
    ["HTTP 404", 404],
  ] as const)("rejects a module served with %s and creates no Blob URL", async (_case, replacement) => {
    serve(new Map([["oxidevm_core_shared.wasm", replacement]]));
    const created = vi.spyOn(URL, "createObjectURL");
    const failure = loadEngineAssets("system", "https://assets.test/oxidevm/runtime/");
    await expect(failure).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
    expect(created).not.toHaveBeenCalled();
    await expect(failure).rejects.toMatchObject({ detail: { asset: "oxidevm_core_shared.wasm", engineRelease: "e".repeat(64) } });
  });
});
