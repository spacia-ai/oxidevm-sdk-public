import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseModuleSource } from "../../wasm/declaration.js";
import { decodeModulesLock, encodeModulesLock } from "../../wasm/lock.js";
import { BlobCache } from "./cache.js";
import { githubStub } from "./github.test-support.js";
import { lockedModule, resolveLocked, resolveSource, type ResolveContext } from "./resolve.js";
import { buildReleaseFiles, sha, writeReleaseDirectory } from "./release.test-support.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "oxidevm-resolve-")); directories.push(directory); return directory; }
async function context(overrides: Partial<ResolveContext> = {}): Promise<ResolveContext> { return { projectDir: await temporary(), cache: new BlobCache(await temporary()), ...overrides }; }
const release = buildReleaseFiles({ artifacts: { "tool.wasm": Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0) }, host: ["process.info", "files.sync"] });
const github = parseModuleSource("github:acme/tool-module@v1.0.0");

describe("resolving a source", () => {
  it("reads a local build directory, relative to the project or absolute", async () => {
    const base = await context(), directory = join(base.projectDir, "modules-src", "tool");
    await writeReleaseDirectory(directory, release);
    for (const path of ["modules-src/tool", directory]) {
      const found = await resolveSource({ kind: "file", path }, base);
      expect(found.release.id).toBe(sha(release.sumsBytes));
      expect(found.source).toEqual({ kind: "file", path });
      expect([...found.paths.keys()].sort()).toEqual(["adapter.mjs", "tool.wasm"]);
    }
  });

  it("refuses a local source that is, or lies below, a symbolic link, because the lock would not be portable and a link can lead anywhere", async () => {
    const base = await context(), real = await temporary();
    await writeReleaseDirectory(join(real, "tool"), release);
    await symlink(join(real, "tool"), join(base.projectDir, "linked"));
    await symlink(real, join(base.projectDir, "via"));
    for (const path of ["linked", "via/tool"]) await expect(resolveSource({ kind: "file", path }, base), path).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await writeReleaseDirectory(join(base.projectDir, "plain"), release);
    expect((await resolveSource({ kind: "file", path: "plain" }, base)).release.id).toBe(sha(release.sumsBytes));
  });

  it("resolves a GitHub source and records the tag, commit and signals", async () => {
    const stub = githubStub(release, { immutable: true, commit: "e".repeat(40) });
    const found = await resolveSource(github, { ...(await context()), fetchImpl: stub.fetchImpl });
    expect(found.source).toEqual({ kind: "github", repository: "acme/tool-module", tag: "v1.0.0", commit: "e".repeat(40), immutable: "yes", attested: "yes" });
  });

  it("builds a lock entry that round-trips through the canonical lock file", async () => {
    const found = await resolveSource(github, { ...(await context()), fetchImpl: githubStub(release).fetchImpl });
    const entry = lockedModule(found);
    expect(entry).toMatchObject({ version: "1.0.0", release: sha(release.sumsBytes), manifestSha256: sha(release.manifestBytes), capabilities: ["files.sync", "process.info"] });
    expect(entry.artifacts).toEqual([{ name: "tool.wasm", sha256: sha(release.files.get("tool.wasm") ?? new Uint8Array()), bytes: 8 }]);
    const lock = decodeModulesLock({ schemaVersion: 1, modules: { tool: entry } });
    expect(decodeModulesLock(JSON.parse(new TextDecoder().decode(encodeModulesLock(lock))))).toEqual(lock);
  });
});

describe("resolving what a lock pins", () => {
  async function locked() {
    const base = await context(), stub = githubStub(release, { commit: "a".repeat(40) });
    const found = await resolveSource(github, { ...base, fetchImpl: stub.fetchImpl });
    return { base, entry: lockedModule(found) };
  }

  it("rebuilds a complete cached release without touching the network, and refuses to when the network is off and anything is missing", async () => {
    const { base, entry } = await locked();
    const offline = githubStub(release);
    const again = await resolveLocked(entry, { ...base, fetchImpl: offline.fetchImpl, offline: true });
    expect(again.release.id).toBe(entry.release);
    expect(offline.calls).toEqual([]);
    const cold = { ...base, cache: new BlobCache(await temporary()), offline: true };
    await expect(resolveLocked(entry, cold)).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND", detail: { reason: "wasm-cache-miss" }, message: expect.stringContaining("not fully in the module cache") as unknown });
    await expect(resolveSource(github, cold)).rejects.toMatchObject({ detail: { reason: "wasm-cache-miss" } });
  });

  it("fetches again on a cold cache and accepts exactly the release that was locked", async () => {
    const { base, entry } = await locked();
    const fresh = { ...base, cache: new BlobCache(await temporary()) };
    const stub = githubStub(release, { commit: "a".repeat(40) });
    const again = await resolveLocked(entry, { ...fresh, fetchImpl: stub.fetchImpl });
    expect(again.release.id).toBe(entry.release);
  });

  it("refuses a tag that has been moved to different bytes or to a different commit", async () => {
    const { base, entry } = await locked();
    const moved = buildReleaseFiles({ artifacts: { "tool.wasm": Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 7) }, host: ["process.info", "files.sync"] });
    const cold = { ...base, cache: new BlobCache(await temporary()) };
    await expect(resolveLocked(entry, { ...cold, fetchImpl: githubStub(moved, { commit: "a".repeat(40) }).fetchImpl })).rejects.toMatchObject({ detail: { reason: "wasm-lock-mismatch" } });
    await expect(resolveLocked(entry, { ...cold, cache: new BlobCache(await temporary()), fetchImpl: githubStub(release, { commit: "b".repeat(40) }).fetchImpl })).rejects.toThrow(/different commit/u);
  });

  it("refuses a moved tag before it fetches any of the moved release's files", async () => {
    const { base, entry } = await locked();
    const moved = buildReleaseFiles({ artifacts: { "tool.wasm": Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 7) }, host: ["process.info", "files.sync"] });
    const stub = githubStub(moved, { commit: "a".repeat(40) });
    await expect(resolveLocked(entry, { ...base, cache: new BlobCache(await temporary()), fetchImpl: stub.fetchImpl })).rejects.toMatchObject({ detail: { reason: "wasm-lock-mismatch" } });
    const files = [...stub.ids].filter(([name]) => name !== "SHA256SUMS" && name !== "module.json");
    expect(files.flatMap(([, id]) => stub.calls.filter(call => call.url === `${stub.base}/releases/assets/${String(id)}`))).toEqual([]);
  });

  it("re-reads a local source every time and refuses it when it changed", async () => {
    const base = await context(), directory = join(base.projectDir, "dist");
    await writeReleaseDirectory(directory, release);
    const entry = lockedModule(await resolveSource({ kind: "file", path: "dist" }, base));
    expect((await resolveLocked(entry, base)).release.id).toBe(entry.release);
    await rm(directory, { recursive: true });
    await writeReleaseDirectory(directory, buildReleaseFiles({ adapter: "export default () => ({ main: () => 9 });", host: ["process.info", "files.sync"] }));
    await expect(resolveLocked(entry, base)).rejects.toMatchObject({ detail: { reason: "wasm-lock-mismatch" } });
  });
});
