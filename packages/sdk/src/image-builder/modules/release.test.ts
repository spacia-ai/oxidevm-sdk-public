import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VMError } from "../../runtime/errors.js";
import { readReleaseDirectory, servedName, verifyRelease, type Measured } from "./release.js";
import { buildReleaseFiles, sha, writeReleaseDirectory, type BuiltRelease } from "./release.test-support.js";
import { formatSums } from "./sums.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "oxidevm-release-")); directories.push(directory); return directory; }

function measuredOf(release: BuiltRelease): Measured[] {
  return [...release.files].filter(([name]) => name !== "module.json" && name !== "SHA256SUMS").map(([name, bytes]) => ({ name, sha256: sha(bytes), bytes: bytes.byteLength }));
}
const verify = (release: BuiltRelease, measured: readonly Measured[] = measuredOf(release), sums = release.sumsBytes, manifest = release.manifestBytes) => verifyRelease(manifest, sums, measured);

describe("verifyRelease", () => {
  it("accepts a consistent release and names it by the digest of SHA256SUMS", () => {
    const release = buildReleaseFiles({ artifacts: { "a.wasm": Uint8Array.of(1, 2, 3), "b.bin": Uint8Array.of(4) } });
    const verified = verify(release);
    expect(verified.id).toBe(sha(release.sumsBytes));
    expect(verified.files.map(file => file.name)).toEqual(["adapter.mjs", "a.wasm", "b.bin"]);
    expect(verified.manifest.id).toBe("tool");
  });

  it("rejects a module.json that is not in canonical form", () => {
    const release = buildReleaseFiles();
    const pretty = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(release.manifestBytes)), null, 4));
    expect(() => verify(release, undefined, release.sumsBytes, pretty)).toThrow(VMError);
  });

  it("rejects SHA256SUMS that lists too few, too many or the wrong files", () => {
    const release = buildReleaseFiles();
    const entry = (name: string, bytes: Uint8Array) => ({ name, sha256: sha(bytes) });
    const adapter = release.files.get("adapter.mjs") ?? new Uint8Array();
    for (const [label, entries] of [
      ["no module.json", [entry("adapter.mjs", adapter), entry("tool.wasm", release.files.get("tool.wasm") ?? adapter)]],
      ["an extra file", [...[...release.files].filter(([name]) => name !== "SHA256SUMS").map(([name, bytes]) => entry(name, bytes)), entry("extra.txt", adapter)]],
      ["a missing artifact", [entry("module.json", release.manifestBytes), entry("adapter.mjs", adapter)]],
    ] as const) expect(() => verify(release, undefined, formatSums(entries)), label).toThrow(/must list exactly/u);
  });

  it("rejects a SHA256SUMS whose module.json digest is not the digest of module.json", () => {
    const release = buildReleaseFiles();
    const entries = [...release.files].filter(([name]) => name !== "SHA256SUMS").map(([name, bytes]) => ({ name, sha256: name === "module.json" ? "0".repeat(64) : sha(bytes) }));
    expect(() => verify(release, undefined, formatSums(entries))).toThrow(/module.json does not match SHA256SUMS/u);
  });

  it("rejects measured files that are missing, extra, longer, shorter or different", () => {
    const release = buildReleaseFiles({ artifacts: { "a.wasm": Uint8Array.of(1, 2, 3) } });
    const whole = measuredOf(release);
    const other = whole[0];
    if (other === undefined) throw new Error("fixture");
    const cases: readonly (readonly [string, readonly Measured[], RegExp])[] = [
      ["missing adapter", whole.filter(file => file.name !== "adapter.mjs"), /is missing adapter.mjs/u],
      ["unlisted file", [...whole, { name: "extra.txt", sha256: "0".repeat(64), bytes: 1 }], /unlisted file extra.txt/u],
      ["longer", whole.map(file => file.name === "a.wasm" ? { ...file, bytes: file.bytes + 1 } : file), /pins/u],
      ["different digest", whole.map(file => file.name === "a.wasm" ? { ...file, sha256: "1".repeat(64) } : file), /pinned sha256/u],
    ];
    for (const [label, measured, message] of cases) expect(() => verify(release, measured), label).toThrow(message);
  });

  it("rejects a SHA256SUMS digest that disagrees with the pin even when the file matches the pin", () => {
    const release = buildReleaseFiles({ artifacts: { "a.wasm": Uint8Array.of(1, 2, 3) } });
    const entries = [...release.files].filter(([name]) => name !== "SHA256SUMS").map(([name, bytes]) => ({ name, sha256: name === "a.wasm" ? "2".repeat(64) : sha(bytes) }));
    expect(() => verify(release, undefined, formatSums(entries))).toThrow(/pinned sha256/u);
  });
});

describe("readReleaseDirectory", () => {
  it("measures and verifies a build output directory", async () => {
    const release = buildReleaseFiles();
    const directory = await temporary();
    await writeReleaseDirectory(directory, release);
    const read = await readReleaseDirectory(directory);
    expect(read.id).toBe(sha(release.sumsBytes));
    expect(read.directory).toBe(directory);
  });

  it("refuses a directory with an unlisted file, a missing document, or an entry that is not a regular file", async () => {
    const release = buildReleaseFiles();
    for (const [label, mutate] of [
      ["unlisted", async (directory: string) => { await writeFile(join(directory, ".DS_Store"), "x"); }],
      ["no SHA256SUMS", async (directory: string) => { await rm(join(directory, "SHA256SUMS")); }],
      ["a symlink", async (directory: string) => { await rm(join(directory, "adapter.mjs")); await symlink("/etc/hostname", join(directory, "adapter.mjs")); }],
    ] as const) {
      const directory = await temporary();
      await writeReleaseDirectory(directory, release);
      await mutate(directory);
      await expect(readReleaseDirectory(directory), label).rejects.toBeInstanceOf(VMError);
    }
  });
});

describe("a directory too large to be a release", () => {
  // A sparse file costs nothing to create and a great deal to hash, so every bound must hold before anything is hashed.
  it("is refused for a file over the largest artifact, too many entries, or more bytes than a release may hold", async () => {
    const release = buildReleaseFiles();
    const huge = await temporary();
    await writeReleaseDirectory(huge, release);
    await truncate(join(huge, "adapter.mjs"), 600 * 1024 ** 2);
    await expect(readReleaseDirectory(huge)).rejects.toThrow(/adapter\.mjs is larger than/u);

    const many = await temporary();
    await writeReleaseDirectory(many, release);
    for (let index = 0; index < 300; index += 1) await writeFile(join(many, `extra-${String(index)}.txt`), "x");
    await expect(readReleaseDirectory(many)).rejects.toThrow(/more than 256 entries/u);

    const heavy = await temporary();
    await writeReleaseDirectory(heavy, release);
    await expect(readReleaseDirectory(heavy, undefined, { maxReleaseBytes: 10 })).rejects.toThrow(/more than 10 bytes/u);
    expect((await readReleaseDirectory(heavy, undefined, { maxReleaseBytes: 1 << 20 })).id).toBe(sha(release.sumsBytes));
  });
});

describe("served names", () => {
  it.each([
    ["adapter.mjs", "adapter.mjs.bin"], ["worker.js", "worker.js.bin"], ["lib.cjs", "lib.cjs.bin"], ["a.jsx", "a.jsx.bin"], ["a.ts", "a.ts.bin"], ["a.mts", "a.mts.bin"], ["a.tsx", "a.tsx.bin"],
    ["style.css", "style.css.bin"], ["theme.scss", "theme.scss.bin"], ["page.html", "page.html.bin"], ["page.htm", "page.htm.bin"], ["App.vue", "App.vue.bin"], ["WORKER.JS", "WORKER.JS.bin"],
  ])("gives %s the neutral name %s, because development servers rewrite files with that kind of name", (name, served) => {
    expect(servedName(name)).toBe(served);
  });

  it.each(["tool.wasm", "pyodide-lock.json", "numpy.whl", "stdlib.zip", "NOTICES.txt", "data.bin", "pglite.data", "script.py", "js", "mjs", "file.js.map", "archive.tar.gz"])("keeps %s as it is", name => {
    expect(servedName(name)).toBe(name);
  });
});

describe("a staged directory with served copies", () => {
  async function staged(release: BuiltRelease, copies: readonly string[] = ["adapter.mjs"]): Promise<string> {
    const directory = await temporary();
    await writeReleaseDirectory(directory, release);
    for (const name of copies) await writeFile(join(directory, `${name}.bin`), release.files.get(name) ?? new Uint8Array());
    return directory;
  }

  it("is read as the same release when copies are allowed", async () => {
    const release = buildReleaseFiles();
    const read = await readReleaseDirectory(await staged(release), undefined, { servedCopies: true });
    expect(read.id).toBe(sha(release.sumsBytes));
    expect(read.files.map(file => file.name)).toEqual(["adapter.mjs", "tool.wasm"]);
  });

  it("is refused by default, because an author's build output has no copies", async () => {
    await expect(readReleaseDirectory(await staged(buildReleaseFiles()))).rejects.toThrow(/unlisted file adapter\.mjs\.bin/u);
  });

  it("needs a copy of every script, stylesheet and page the release lists", async () => {
    const release = buildReleaseFiles({ artifacts: { "worker.js": new TextEncoder().encode("export {};"), "tool.wasm": Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0) } });
    await expect(readReleaseDirectory(await staged(release), undefined, { servedCopies: true })).rejects.toThrow(/served copy worker\.js\.bin/u);
    expect((await readReleaseDirectory(await staged(release, ["adapter.mjs", "worker.js"]), undefined, { servedCopies: true })).files).toHaveLength(3);
  });

  it("needs the adapter's copy", async () => {
    await expect(readReleaseDirectory(await staged(buildReleaseFiles(), []), undefined, { servedCopies: true })).rejects.toThrow(/served copy adapter\.mjs\.bin/u);
  });

  it("refuses a copy whose bytes differ from the original", async () => {
    const release = buildReleaseFiles();
    const directory = await staged(release);
    await writeFile(join(directory, "adapter.mjs.bin"), "export default () => 1;");
    await expect(readReleaseDirectory(directory, undefined, { servedCopies: true })).rejects.toThrow(/served copy adapter\.mjs\.bin differs/u);
  });

  it("refuses a file named like a copy that no listed script, stylesheet or page needs", async () => {
    for (const name of ["tool.wasm.bin", "ghost.mjs.bin", "notes.bin"]) {
      const directory = await staged(buildReleaseFiles());
      await writeFile(join(directory, name), "stray");
      await expect(readReleaseDirectory(directory, undefined, { servedCopies: true }), name).rejects.toThrow(/unlisted file/u);
    }
  });
});
