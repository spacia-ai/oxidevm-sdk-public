import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlobCache } from "./cache.js";
import { downloadTimeoutMs, githubRedirects, githubToken, resolveGithubRelease } from "./github.js";
import { formatSums } from "./sums.js";
import { githubStub } from "./github.test-support.js";
import { buildReleaseFiles, sha } from "./release.test-support.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function cache(): Promise<BlobCache> { const directory = await mkdtemp(join(tmpdir(), "oxidevm-github-")); directories.push(directory); return new BlobCache(directory); }
const target = { owner: "acme", repo: "tool-module", tag: "v1.0.0" };
const release = buildReleaseFiles({ artifacts: { "tool.wasm": Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0), "NOTICE": new TextEncoder().encode("notice") } });

describe("resolving a GitHub release", () => {
  it("verifies every file into the cache and reports the commit and what GitHub says about the release", async () => {
    const store = await cache(), stub = githubStub(release, { immutable: true, commit: "d".repeat(40) });
    const found = await resolveGithubRelease(target, { cache: store, fetchImpl: stub.fetchImpl });
    expect(found.release.id).toBe(sha(release.sumsBytes));
    expect(found.commit).toBe("d".repeat(40));
    expect(found.immutable).toBe("yes");
    expect(found.attested).toBe("yes");
    expect([...found.paths.keys()].sort()).toEqual(["NOTICE", "adapter.mjs", "tool.wasm"]);
    for (const [name, path] of found.paths) expect(path).toBe(store.blobPath(sha(release.files.get(name) ?? new Uint8Array())));
    expect(await store.readBytes(sha(release.manifestBytes), 4096)).toEqual(release.manifestBytes);
    expect(await store.readBytes(sha(release.sumsBytes), 4096)).toEqual(release.sumsBytes);
  });

  it("sends the token to api.github.com only, never to the storage host a download redirects to", async () => {
    const stub = githubStub(release);
    await resolveGithubRelease(target, { cache: await cache(), token: "ghp_secret", fetchImpl: stub.fetchImpl });
    for (const call of stub.calls) {
      const host = new URL(call.url).host;
      if (host === "api.github.com") expect(call.headers["authorization"], call.url).toBe("Bearer ghp_secret");
      else expect(call.headers, call.url).toEqual({});
    }
    expect(stub.calls.some(call => new URL(call.url).host === "objects.githubusercontent.com")).toBe(true);
    const anonymous = githubStub(release);
    await resolveGithubRelease(target, { cache: await cache(), fetchImpl: anonymous.fetchImpl });
    expect(anonymous.calls.every(call => call.headers["authorization"] === undefined)).toBe(true);
  });

  it("records the signals GitHub does not report as unknown, and never as no", async () => {
    const cases: readonly (readonly [string, Parameters<typeof githubStub>[1], "yes" | "no" | "unknown", "yes" | "no" | "unknown"])[] = [
      ["reported mutable, empty attestations", { immutable: false, attestations: "empty" }, "no", "no"],
      ["nothing reported, attestations 404", { attestations: 404 }, "unknown", "no"],
      ["attestations forbidden", { attestations: 500 }, "unknown", "unknown"],
    ];
    for (const [label, stubOptions, immutable, attested] of cases) {
      const found = await resolveGithubRelease(target, { cache: await cache(), fetchImpl: githubStub(release, stubOptions).fetchImpl });
      expect([found.immutable, found.attested], label).toEqual([immutable, attested]);
    }
  });

  it("refuses a draft, an incomplete upload and a commit it cannot read", async () => {
    const cases: readonly (readonly [string, Parameters<typeof githubStub>[1], RegExp])[] = [
      ["draft", { draft: true }, /is a draft/u],
      ["asset still uploading", { state: "starter" }, /is not uploaded/u],
      ["missing SHA256SUMS", { without: ["SHA256SUMS"] }, /has no asset SHA256SUMS/u],
      ["missing artifact", { without: ["tool.wasm"] }, /has no asset tool.wasm/u],
      ["bad commit", { commit: "not-a-sha" }, /does not name a commit/u],
    ];
    for (const [label, stubOptions, message] of cases) {
      await expect(resolveGithubRelease(target, { cache: await cache(), fetchImpl: githubStub(release, stubOptions).fetchImpl }), label).rejects.toThrow(message);
    }
  });

  it("refuses bytes that differ from SHA256SUMS or from GitHub's own digest, and caches nothing it refused", async () => {
    const forged = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 1);
    const store = await cache();
    await expect(resolveGithubRelease(target, { cache: store, fetchImpl: githubStub(release, { tamper: { "tool.wasm": forged } }).fetchImpl })).rejects.toMatchObject({ detail: { reason: "wasm-module-integrity" } });
    await expect(resolveGithubRelease(target, { cache: await cache(), fetchImpl: githubStub(release, { digest: { "tool.wasm": `sha256:${"9".repeat(64)}` } }).fetchImpl })).rejects.toThrow(/differs from GitHub's own digest/u);
    await expect(resolveGithubRelease(target, { cache: await cache(), fetchImpl: githubStub(release, { size: { "tool.wasm": 3 } }).fetchImpl })).rejects.toThrow();
    expect(await store.find(sha(forged), forged.byteLength)).toBeUndefined();
    const left = await readdir(join(store.root, "tmp")).catch(() => []);
    expect(left).toEqual([]);
  });

  it("refuses downloads GitHub redirects outside its own hosts", async () => {
    const stub = githubStub(release, { storage: "https://evil.example/blob" });
    await expect(resolveGithubRelease(target, { cache: await cache(), fetchImpl: stub.fetchImpl })).rejects.toThrow(/evil.example is not an allowed/u);
    expect(stub.calls.some(call => call.url.startsWith("https://evil.example"))).toBe(false);
  });

  it("removes what a killed earlier run left in the cache's scratch directory before it downloads", async () => {
    const store = await cache(), leftover = join(store.root, "tmp", "killed-download");
    await mkdir(join(store.root, "tmp"), { recursive: true });
    await writeFile(leftover, "partial");
    const longAgo = new Date(Date.now() - 3 * 86_400_000);
    await utimes(leftover, longAgo, longAgo);
    await resolveGithubRelease(target, { cache: store, fetchImpl: githubStub(release).fetchImpl });
    await expect(stat(leftover)).rejects.toThrow();
  });

  it("downloads nothing a second time once the cache holds it", async () => {
    const store = await cache();
    await resolveGithubRelease(target, { cache: store, fetchImpl: githubStub(release).fetchImpl });
    const again = githubStub(release);
    await resolveGithubRelease(target, { cache: store, fetchImpl: again.fetchImpl });
    expect(again.calls.filter(call => call.url.includes("/releases/assets/"))).toHaveLength(2);
  });
});

describe("the download policy", () => {
  it("allows GitHub's API and download hosts over HTTPS and nothing else", () => {
    for (const allowed of ["https://api.github.com/x", "https://github.com/o/r/releases/download/v1/a", "https://objects.githubusercontent.com/x", "https://release-assets.githubusercontent.com/x"]) expect(githubRedirects.allows(new URL(allowed)), allowed).toBe(true);
    for (const denied of ["http://api.github.com/x", "https://api.github.com:8443/x", "https://user:pw@api.github.com/x", "https://evil.example/x", "https://githubusercontent.com.evil.example/x", "https://127.0.0.1/x", "https://[::1]/x", "https://notgithub.com/x", "ftp://github.com/x"]) expect(githubRedirects.allows(new URL(denied)), denied).toBe(false);
  });

  it("takes the token from the environment first and never from an empty value", async () => {
    expect(await githubToken({ GITHUB_TOKEN: "one", GH_TOKEN: "two" })).toBe("one");
    expect(await githubToken({ GITHUB_TOKEN: "", GH_TOKEN: "two" })).toBe("two");
  });

  it("does not run the GitHub CLI in an environment without a home directory", async () => {
    // A bare environment is what tests and sandboxes pass; running gh there would litter the working directory.
    expect(await githubToken({})).toBeUndefined();
    expect(await githubToken({ XDG_CACHE_HOME: "/tmp/x" })).toBeUndefined();
  });
});

describe("what is decided before any file is downloaded", () => {
  /** The requests that fetch a release's own files (not SHA256SUMS and module.json), by asset id. */
  const fileDownloads = (stub: ReturnType<typeof githubStub>): number => [...stub.ids].filter(([name]) => name !== "SHA256SUMS" && name !== "module.json")
    .flatMap(([, id]) => stub.calls.filter(call => call.url === `${stub.base}/releases/assets/${String(id)}`)).length;

  it("downloads no file of a release whose SHA256SUMS and module.json disagree", async () => {
    const entries = [...release.files].filter(([name]) => name !== "SHA256SUMS").map(([name, bytes]) => ({ name, sha256: name === "tool.wasm" ? "9".repeat(64) : sha(bytes) }));
    const stub = githubStub(release, { tamper: { SHA256SUMS: formatSums(entries) } });
    await expect(resolveGithubRelease(target, { cache: await cache(), fetchImpl: stub.fetchImpl })).rejects.toMatchObject({ detail: { reason: "wasm-manifest-invalid" } });
    expect(fileDownloads(stub)).toBe(0);
  });

  it("downloads no file whose size GitHub lists differently from the size module.json pins", async () => {
    const stub = githubStub(release, { size: { "tool.wasm": 3 } });
    await expect(resolveGithubRelease(target, { cache: await cache(), fetchImpl: stub.fetchImpl })).rejects.toThrow(/tool\.wasm has 3 bytes where module\.json pins 8/u);
    expect(fileDownloads(stub)).toBe(0);
  });

  it("downloads no file when the release's files add up to more than the budget", async () => {
    const stub = githubStub(release);
    await expect(resolveGithubRelease(target, { cache: await cache(), fetchImpl: stub.fetchImpl, maxReleaseBytes: 10 })).rejects.toThrow(/more than the 10 bytes/u);
    expect(fileDownloads(stub)).toBe(0);
  });

  it("downloads no file of a release other than the one that was locked", async () => {
    const stub = githubStub(release);
    await expect(resolveGithubRelease(target, { cache: await cache(), fetchImpl: stub.fetchImpl, expectedRelease: "0".repeat(64) })).rejects.toMatchObject({ detail: { reason: "wasm-lock-mismatch" } });
    expect(fileDownloads(stub)).toBe(0);
  });

  it("still downloads every file of an honest release, and a locked release with the right id", async () => {
    const stub = githubStub(release);
    const found = await resolveGithubRelease(target, { cache: await cache(), fetchImpl: stub.fetchImpl, expectedRelease: sha(release.sumsBytes) });
    expect(found.release.id).toBe(sha(release.sumsBytes));
    expect(fileDownloads(stub)).toBe(3);
  });

  it("allows a download time that grows with the file: thirty seconds plus a second per megabyte", () => {
    expect(downloadTimeoutMs(0)).toBe(30_000);
    expect(downloadTimeoutMs(1_000_000)).toBe(31_000);
    expect(downloadTimeoutMs(100 * 1_000_000)).toBe(130_000);
    expect(downloadTimeoutMs(512 * 1024 ** 2)).toBeGreaterThan(500_000);
  });
});
