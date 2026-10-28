import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyEngineRelease, decodeEngineAssetUrls, decodeEngineDownload, decodeEngineLicense, decodeEngineRelease, defaultEngineCacheDir, pinEngineRelease, readEngineLicense, resolveEngineDirectory } from "./engine-source.js";
import { syntheticEngineRelease, writeSyntheticRelease } from "./engine-release.test-support.js";

const release = syntheticEngineRelease();
const localOnly = pinEngineRelease(release.releaseJson, release.licenseIdentity, null);
const assetUrls = Object.fromEntries(["release.json", "LICENSE", ...release.modules.keys()].map((name, index) => [name, `https://api.github.com/repos/spacia-ai/oxidevm-sdk/releases/assets/${String(index + 100)}`]));
const downloadable = pinEngineRelease(release.releaseJson, release.licenseIdentity, decodeEngineDownload({ kind: "github-release-assets", release: `engine-${release.id}`, assets: assetUrls }, release.id));
const unavailable = /--engine-dir.*OXIDEVM_ENGINE_DIR/su;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oxidevm-engine-source-"));
  vi.stubEnv("OXIDEVM_ENGINE_DIR", undefined);
  vi.stubEnv("OXIDEVM_DOWNLOAD_TOKEN", undefined);
  vi.stubEnv("GH_TOKEN", undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

function thrown(run: () => unknown): unknown {
  try { run(); } catch (error: unknown) { return error; }
  throw new Error("expected the call to throw");
}
function moduleBytes(name: string): Uint8Array {
  const bytes = release.modules.get(name);
  if (bytes === undefined) throw new Error(`synthetic release lacks ${name}`);
  return bytes;
}
function flipLastByte(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes); copy.set([(copy.at(-1) ?? 0) ^ 1], copy.length - 1); return copy;
}
/** The release's six files by name, as the release channel serves them. */
function releaseBodies(): ReadonlyMap<string, Uint8Array> {
  return new Map<string, Uint8Array>([["release.json", release.releaseJson], ["LICENSE", new TextEncoder().encode(release.license)], ...release.modules]);
}
const byUrl = new Map(Object.entries(assetUrls).map(([name, url]) => [url, name]));
/** Serves the release's six files at their asset URLs and records each request's authorization. */
function serveRelease(replace: ReadonlyMap<string, Uint8Array | number> = new Map()): { readonly requests: { readonly url: string; readonly authorization: string | null }[] } {
  const bodies = releaseBodies();
  const requests: { readonly url: string; readonly authorization: string | null }[] = [];
  vi.stubGlobal("fetch", (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    const name = byUrl.get(url);
    const replacement = name === undefined ? 404 : replace.get(name);
    if (typeof replacement === "number") return Promise.resolve(new Response("missing", { status: replacement }));
    const body = replacement ?? (name === undefined ? undefined : bodies.get(name));
    return Promise.resolve(body === undefined ? new Response("missing", { status: 404 }) : new Response(new Uint8Array(body)));
  });
  return { requests };
}

describe("resolveEngineDirectory", () => {
  it("resolves a verified explicit directory without consulting the cache or the network", async () => {
    const directory = join(root, "release");
    await writeSyntheticRelease(directory, release);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(resolveEngineDirectory({ engineDir: directory, cacheDir: join(root, "cache") }, localOnly)).resolves.toBe(directory);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an explicit directory with one flipped module byte and never falls back to the cache", async () => {
    const directory = join(root, "release");
    await writeSyntheticRelease(directory, release);
    await writeSyntheticRelease(join(root, "cache", release.id), release);
    await writeFile(join(directory, "oxidevm_userspace.wasm"), flipLastByte(moduleBytes("oxidevm_userspace.wasm")));
    const failure = resolveEngineDirectory({ engineDir: directory, cacheDir: join(root, "cache") }, localOnly);
    await expect(failure).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
    await expect(failure).rejects.toThrow("oxidevm_userspace.wasm");
  });

  it("rejects another release's release.json and a directory without the engine LICENSE", async () => {
    const other = join(root, "other"); await writeSyntheticRelease(other, release);
    await writeFile(join(other, "release.json"), syntheticEngineRelease(1).releaseJson);
    const mismatched = resolveEngineDirectory({ engineDir: other }, localOnly);
    await expect(mismatched).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
    await expect(mismatched).rejects.toThrow("release.json");
    const unlicensed = join(root, "unlicensed"); await writeSyntheticRelease(unlicensed, release);
    await rm(join(unlicensed, "LICENSE"));
    const missing = resolveEngineDirectory({ engineDir: unlicensed }, localOnly);
    await expect(missing).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
    await expect(missing).rejects.toThrow("LICENSE");
  });

  it("rejects an explicit directory whose LICENSE is not the pinned engine terms", async () => {
    const directory = join(root, "release"); await writeSyntheticRelease(directory, release);
    await writeFile(join(directory, "LICENSE"), release.license.replace("tests", "TESTS"));
    const failure = resolveEngineDirectory({ engineDir: directory, cacheDir: join(root, "cache") }, localOnly);
    await expect(failure).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
    await expect(failure).rejects.toThrow("LICENSE");
  });

  it("refuses a cached copy with a stale LICENSE, and replaces it with the pinned release when it can download", async () => {
    const cached = join(root, "cache", release.id); await writeSyntheticRelease(cached, release);
    await writeFile(join(cached, "LICENSE"), "Earlier engine terms.\n");
    await expect(resolveEngineDirectory({ cacheDir: join(root, "cache") }, downloadable)).rejects.toThrow(/cached copy/u);
    vi.stubEnv("OXIDEVM_DOWNLOAD_TOKEN", "private-token"); serveRelease();
    await expect(resolveEngineDirectory({ cacheDir: join(root, "cache") }, downloadable)).resolves.toBe(cached);
    expect(await readFile(join(cached, "LICENSE"), "utf8")).toBe(release.license);
  });

  it("verifies OXIDEVM_ENGINE_DIR like an explicit directory", async () => {
    const directory = join(root, "environment"); await writeSyntheticRelease(directory, release);
    vi.stubEnv("OXIDEVM_ENGINE_DIR", directory);
    await expect(resolveEngineDirectory({ cacheDir: join(root, "cache") }, localOnly)).resolves.toBe(directory);
    await rm(join(directory, "oxidevm_core.wasm"));
    await writeSyntheticRelease(join(root, "cache", release.id), release);
    const failure = resolveEngineDirectory({ cacheDir: join(root, "cache") }, localOnly);
    await expect(failure).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
    await expect(failure).rejects.toThrow("oxidevm_core.wasm");
  });

  it("names every source when nothing supplies the release and no download token is set", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const failure = resolveEngineDirectory({ cacheDir: join(root, "cache") }, downloadable);
    await expect(failure).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
    await expect(failure).rejects.toThrow(/--engine-dir.*OXIDEVM_ENGINE_DIR.*OXIDEVM_DOWNLOAD_TOKEN/su);
    await expect(failure).rejects.toThrow(release.id);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says so when this SDK records no download location, even with a token", async () => {
    vi.stubEnv("OXIDEVM_DOWNLOAD_TOKEN", "private-token");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const failure = resolveEngineDirectory({ cacheDir: join(root, "cache") }, localOnly);
    await expect(failure).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
    await expect(failure).rejects.toThrow(unavailable);
    await expect(failure).rejects.toThrow(/no download location/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves a verified cache entry without a token", async () => {
    const cached = join(root, "cache", release.id); await writeSyntheticRelease(cached, release);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(resolveEngineDirectory({ cacheDir: join(root, "cache") }, downloadable)).resolves.toBe(cached);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("downloads the private release into the cache with the token, which only the GitHub API receives", async () => {
    vi.stubEnv("GH_TOKEN", "ci-token");
    const { requests } = serveRelease();
    const cached = await resolveEngineDirectory({ cacheDir: join(root, "cache") }, downloadable);
    expect(cached).toBe(join(root, "cache", release.id));
    expect(await readFile(join(cached, "release.json"))).toEqual(Buffer.from(release.releaseJson));
    expect(await readFile(join(cached, "LICENSE"), "utf8")).toBe(release.license);
    expect(await readFile(join(cached, "oxidevm_netstack.wasm"))).toEqual(Buffer.from(moduleBytes("oxidevm_netstack.wasm")));
    expect(requests.map(request => request.url).sort()).toEqual(Object.values(assetUrls).sort());
    expect(requests.every(request => request.authorization === "Bearer ci-token")).toBe(true);
    expect(await readdir(join(root, "cache"))).toEqual([release.id]);
  });

  it.each([
    ["wrong module bytes", "oxidevm_core_shared.wasm", flipLastByte(moduleBytes("oxidevm_core_shared.wasm"))],
    ["a missing module", "oxidevm_userspace.wasm", 404],
    ["a missing LICENSE", "LICENSE", 404],
    ["other LICENSE terms", "LICENSE", new TextEncoder().encode(release.license.replace("tests", "TESTS"))],
  ] as const)("rejects a download with %s and leaves no cache entry", async (_case, asset, replacement) => {
    vi.stubEnv("OXIDEVM_DOWNLOAD_TOKEN", "private-token");
    serveRelease(new Map([[asset, replacement]]));
    const failure = resolveEngineDirectory({ cacheDir: join(root, "cache") }, downloadable);
    await expect(failure).rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { releaseId: release.id, asset } });
    await expect(failure).rejects.toThrow(release.id);
    expect(await readdir(join(root, "cache")).catch(() => [])).toEqual([]);
  });

  it("replaces a cache entry that no longer matches its pin with a verified download", async () => {
    const cached = join(root, "cache", release.id); await writeSyntheticRelease(cached, release);
    await writeFile(join(cached, "oxidevm_core.wasm"), flipLastByte(moduleBytes("oxidevm_core.wasm")));
    await expect(resolveEngineDirectory({ cacheDir: join(root, "cache") }, downloadable)).rejects.toThrow(/cached copy/u);
    vi.stubEnv("OXIDEVM_DOWNLOAD_TOKEN", "private-token"); serveRelease();
    await expect(resolveEngineDirectory({ cacheDir: join(root, "cache") }, downloadable)).resolves.toBe(cached);
    expect(await readFile(join(cached, "oxidevm_core.wasm"))).toEqual(Buffer.from(moduleBytes("oxidevm_core.wasm")));
  });

  it.each(["a pending request", "a pending read"] as const)("reports an abort during %s of the download as ABORTED and leaves no cache entry", async moment => {
    vi.stubEnv("OXIDEVM_DOWNLOAD_TOKEN", "private-token");
    const bodies = releaseBodies(); const controller = new AbortController();
    vi.stubGlobal("fetch", (input: URL | string, init?: RequestInit) => {
      const name = byUrl.get(String(input)); const body = name === undefined ? undefined : bodies.get(name);
      if (body === undefined) return Promise.resolve(new Response("missing", { status: 404 }));
      if (name !== "oxidevm_core_shared.wasm") return Promise.resolve(new Response(new Uint8Array(body)));
      const signal = init?.signal;
      if (signal === undefined || signal === null) throw new Error("the download carries no signal");
      // The engine is fetched with the caller's signal: aborting it rejects the pending request or read.
      if (moment === "a pending request") {
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => { const reason: unknown = signal.reason; reject(reason instanceof Error ? reason : new Error("aborted")); }, { once: true });
          controller.abort();
        });
      }
      // With no high-water mark the stream pulls only for a waiting read: the second read is pending when the abort lands.
      let pulls = 0;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(stream) { signal.addEventListener("abort", () => { stream.error(signal.reason); }, { once: true }); },
        pull(stream) { pulls += 1; if (pulls === 1) stream.enqueue(body.slice(0, 4)); else controller.abort(); },
      }, { highWaterMark: 0 })));
    });
    await expect(resolveEngineDirectory({ cacheDir: join(root, "cache"), signal: controller.signal }, downloadable)).rejects.toMatchObject({ code: "ABORTED" });
    expect(await readdir(join(root, "cache")).catch(() => [])).toEqual([]);
  });

  it("honors cancellation before touching any source", async () => {
    const directory = join(root, "release"); await writeSyntheticRelease(directory, release);
    await expect(resolveEngineDirectory({ engineDir: directory, signal: AbortSignal.abort() }, localOnly)).rejects.toMatchObject({ code: "ABORTED" });
  });
});

describe("engine release staging", () => {
  it("stages every file of the release with mode 0644, whatever the source's modes", async () => {
    const source = join(root, "release"); await writeSyntheticRelease(source, release);
    for (const name of await readdir(source)) await chmod(join(source, name), 0o600);
    const target = join(root, "staged");
    await expect(copyEngineRelease(source, target, localOnly)).resolves.toBe(6);
    const modes = await Promise.all((await readdir(target)).map(async name => [name, (await stat(join(target, name))).mode & 0o777] as const));
    expect(modes).toHaveLength(6);
    expect(modes.filter(([, mode]) => mode !== 0o644)).toEqual([]);
  });

  it("keeps the engine cache under ~/.cache unless XDG_CACHE_HOME is an absolute path", () => {
    for (const value of [undefined, "", "relative/cache"]) {
      vi.stubEnv("XDG_CACHE_HOME", value);
      expect(defaultEngineCacheDir()).toBe(join(homedir(), ".cache", "oxidevm", "engine"));
    }
    vi.stubEnv("XDG_CACHE_HOME", "/var/cache/someone");
    expect(defaultEngineCacheDir()).toBe("/var/cache/someone/oxidevm/engine");
  });
});

describe("engine release metadata", () => {
  it("decodes the canonical schema-3 release.json the engine writes, with its Userspace API identity", () => {
    expect(decodeEngineRelease(release.releaseJson)).toEqual(release.manifest);
    expect(decodeEngineRelease(release.releaseJson).identities.userspaceApi).toBe(release.manifest.identities.userspaceApi);
    expect(localOnly).toMatchObject({ id: release.id, manifestBytes: release.releaseJson.length, license: release.licenseIdentity, download: null });
  });

  it("pins the LICENSE by size and SHA-256 and reads it from a release directory", async () => {
    const directory = join(root, "release"); await writeSyntheticRelease(directory, release);
    expect(await readEngineLicense(directory)).toEqual(release.licenseIdentity);
    for (const value of [null, { bytes: 0, sha256: release.licenseIdentity.sha256 }, { bytes: 2 * 1024 ** 2, sha256: release.licenseIdentity.sha256 }, { ...release.licenseIdentity, sha256: "x".repeat(64) }, { ...release.licenseIdentity, text: "terms" }]) {
      expect(thrown(() => decodeEngineLicense(value))).toMatchObject({ code: "CORE_LOAD_FAILED" });
    }
    await writeFile(join(directory, "LICENSE"), "");
    await expect(readEngineLicense(directory)).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
  });

  it.each([
    ["compact JSON", JSON.stringify(release.manifest)],
    ["schema 1", `${JSON.stringify({ ...release.manifest, schemaVersion: 1 }, null, 2)}\n`],
    ["schema 2", `${JSON.stringify({ ...release.manifest, schemaVersion: 2 }, null, 2)}\n`],
    ["an extra field", `${JSON.stringify({ ...release.manifest, sdkVersion: "1" }, null, 2)}\n`],
    ["a missing module", `${JSON.stringify({ ...release.manifest, artifacts: release.manifest.artifacts.slice(1) }, null, 2)}\n`],
    ["reordered modules", `${JSON.stringify({ ...release.manifest, artifacts: [...release.manifest.artifacts].reverse() }, null, 2)}\n`],
    ["a module in the wrong mode", `${JSON.stringify({ ...release.manifest, artifacts: release.manifest.artifacts.map(artifact => ({ ...artifact, mode: "system" })) }, null, 2)}\n`],
    ["an uppercase digest", `${JSON.stringify({ ...release.manifest, artifacts: release.manifest.artifacts.map(artifact => ({ ...artifact, sha256: artifact.sha256.toUpperCase() })) }, null, 2)}\n`],
    ["an empty module", `${JSON.stringify({ ...release.manifest, artifacts: release.manifest.artifacts.map(artifact => ({ ...artifact, bytes: 0 })) }, null, 2)}\n`],
  ])("rejects a release.json with %s", (_case, text) => {
    expect(thrown(() => decodeEngineRelease(new TextEncoder().encode(text)))).toMatchObject({ code: "CORE_LOAD_FAILED" });
  });

  it("accepts exactly the six release assets at GitHub release-asset URLs", () => {
    expect(decodeEngineAssetUrls(assetUrls)).toEqual(assetUrls);
    const withoutLicense = Object.fromEntries(Object.entries(assetUrls).filter(([name]) => name !== "LICENSE"));
    for (const value of [withoutLicense, { ...assetUrls, "extra.wasm": assetUrls["LICENSE"] }, { ...assetUrls, LICENSE: "http://api.github.com/repos/a/b/releases/assets/1" },
      { ...assetUrls, LICENSE: "https://example.com/repos/a/b/releases/assets/1" }, { ...assetUrls, LICENSE: "https://api.github.com/repos/a/b/releases/assets/1?download=1" }]) {
      expect(thrown(() => decodeEngineAssetUrls(value))).toMatchObject({ code: "CORE_LOAD_FAILED" });
    }
    expect(decodeEngineDownload(null, release.id)).toBeNull();
    expect(decodeEngineDownload({ kind: "cdn", release: `engine-${release.id}`, baseUrl: `https://cdn.oxidevm.dev/engine/${release.id}/` }, release.id)).toEqual({ kind: "cdn", release: `engine-${release.id}`, baseUrl: `https://cdn.oxidevm.dev/engine/${release.id}/` });
    for (const baseUrl of [`http://cdn.oxidevm.dev/engine/${release.id}/`, `https://cdn.oxidevm.dev/engine/${release.id}`, `https://cdn.oxidevm.dev/engine/${"0".repeat(64)}/`, `https://cdn.oxidevm.dev/engine/${release.id}/?x=1`]) {
      expect(() => decodeEngineDownload({ kind: "cdn", release: `engine-${release.id}`, baseUrl }, release.id)).toThrow(/CDN base URL/u);
    }
    expect(() => decodeEngineDownload({ kind: "github-release-assets", release: "engine-other", assets: assetUrls }, release.id)).toThrow(/engine-/u);
  });

  it("refuses an oversized release.json before parsing it", () => {
    expect(thrown(() => decodeEngineRelease(new Uint8Array(70 * 1024)))).toMatchObject({ code: "CORE_LOAD_FAILED" });
  });
});
