import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlobCache, defaultModuleCacheDir, materialize } from "./cache.js";
import { sha } from "./release.test-support.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "oxidevm-cache-")); directories.push(directory); return directory; }

describe("the module cache location", () => {
  it("follows XDG_CACHE_HOME when it is absolute and falls back to the home directory otherwise", () => {
    expect(defaultModuleCacheDir({ XDG_CACHE_HOME: "/var/cache" }, "/home/u")).toBe("/var/cache/oxidevm/wasm");
    for (const configured of [undefined, "", "relative/cache"]) expect(defaultModuleCacheDir(configured === undefined ? {} : { XDG_CACHE_HOME: configured }, "/home/u")).toBe("/home/u/.cache/oxidevm/wasm");
  });
});

describe("the blob cache", () => {
  it("stores a file under its digest and finds it only while its bytes still match", async () => {
    const cache = new BlobCache(await temporary());
    const bytes = new TextEncoder().encode("module bytes");
    const scratch = cache.scratchPath();
    await mkdir(join(scratch, ".."), { recursive: true });
    await writeFile(scratch, bytes);
    const path = await cache.adopt(scratch, sha(bytes));
    expect(path).toBe(cache.blobPath(sha(bytes)));
    expect(await cache.find(sha(bytes), bytes.byteLength)).toBe(path);
    expect(await cache.find(sha(bytes), bytes.byteLength + 1)).toBeUndefined();
    expect(await cache.find("0".repeat(64), 3)).toBeUndefined();
    await writeFile(path, "module bytez"); // same length, one byte different: only the digest can tell
    expect(await cache.find(sha(bytes), bytes.byteLength)).toBeUndefined();
  });

  // Where a rename cannot replace a file (a read-only directory here; a Windows filesystem in the field), an existing blob can
  // stand in for the verified scratch file only if it still hashes to its name. Root ignores directory permissions.
  it.skipIf(process.getuid?.() === 0)("keeps an existing blob that a rename cannot replace only while the blob still hashes to its name", async () => {
    const cache = new BlobCache(await temporary());
    const bytes = new TextEncoder().encode("module bytes");
    const first = cache.scratchPath();
    await mkdir(dirname(first), { recursive: true });
    await writeFile(first, bytes);
    const path = await cache.adopt(first, sha(bytes));
    await chmod(dirname(path), 0o500);
    try {
      const second = cache.scratchPath();
      await writeFile(second, bytes);
      expect(await cache.adopt(second, sha(bytes))).toBe(path);
      await expect(stat(second)).rejects.toThrow();
      await writeFile(path, "module bytez"); // the same length with one byte different: only the digest can tell
      const third = cache.scratchPath();
      await writeFile(third, bytes);
      await expect(cache.adopt(third, sha(bytes))).rejects.toThrow();
      await expect(stat(third)).rejects.toThrow();
    } finally { await chmod(dirname(path), 0o700); }
  });

  it("removes the scratch files of a download that died with its process once they are a day old, and nothing else", async () => {
    const cache = new BlobCache(await temporary());
    const bytes = new TextEncoder().encode("module bytes");
    const stale = cache.scratchPath(), recent = cache.scratchPath(), kept = cache.scratchPath();
    await mkdir(dirname(stale), { recursive: true });
    for (const path of [stale, recent, kept]) await writeFile(path, "partial");
    const now = Date.now(), twoDaysAgo = new Date(now - 2 * 86_400_000), hourAgo = new Date(now - 3_600_000);
    await utimes(stale, twoDaysAgo, twoDaysAgo);
    await utimes(recent, hourAgo, hourAgo);
    const blobScratch = cache.scratchPath();
    await writeFile(blobScratch, bytes);
    const blob = await cache.adopt(blobScratch, sha(bytes));
    await utimes(blob, twoDaysAgo, twoDaysAgo); // an old blob is a cached file, not scratch
    await cache.sweepScratch(now);
    await expect(stat(stale)).rejects.toThrow();
    expect((await stat(recent)).isFile()).toBe(true);
    expect((await stat(kept)).isFile()).toBe(true);
    expect(await cache.find(sha(bytes), bytes.byteLength)).toBe(blob);
  });

  it("has nothing to sweep before the first download", async () => {
    await expect(new BlobCache(await temporary()).sweepScratch()).resolves.toBeUndefined();
  });

  it("keeps small documents by digest and refuses to read them back once they differ", async () => {
    const cache = new BlobCache(await temporary());
    const bytes = new TextEncoder().encode('{"a":1}\n');
    const digest = await cache.putBytes(bytes);
    expect(digest).toBe(sha(bytes));
    expect(await cache.putBytes(bytes)).toBe(digest);
    expect(await cache.readBytes(digest, 1024)).toEqual(bytes);
    expect(await cache.readBytes(digest, 3)).toBeUndefined();
    await writeFile(cache.blobPath(digest), "{}");
    expect(await cache.readBytes(digest, 1024)).toBeUndefined();
    expect(await cache.readBytes("f".repeat(64), 10)).toBeUndefined();
  });

  it("accepts only a lowercase sha256 as a blob name, so a name cannot leave the cache", async () => {
    const cache = new BlobCache(await temporary());
    for (const name of ["../x", "a".repeat(63), "A".repeat(64), `${"a".repeat(63)}/`, ""]) expect(() => cache.blobPath(name), name).toThrow();
  });

  it("copies a blob to a destination, replacing what was there, and never shares its storage", async () => {
    const root = await temporary();
    const source = join(root, "source"), destination = join(root, "deep", "out", "file");
    await writeFile(source, "one");
    await materialize(source, destination);
    await writeFile(destination, "edited in place");
    expect(await readFile(source, "utf8")).toBe("one");
    await materialize(source, destination);
    expect(await readFile(destination, "utf8")).toBe("one");
    const [original, copy] = await Promise.all([stat(source), stat(destination)]);
    expect(copy.isFile() && copy.ino !== original.ino).toBe(true);
  });
});
