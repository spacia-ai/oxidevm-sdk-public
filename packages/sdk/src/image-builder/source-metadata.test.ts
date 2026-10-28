import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { c } from "tar";
import { materializeSource } from "./sources.js";
import { collectRootfs, hash, hashFile } from "./files.js";

it("retains archive permissions and numeric ownership independently of host extraction umask", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-source-metadata-"));
  try {
    const source = join(directory, "source"); await mkdir(source); await writeFile(join(source, "file"), "content");
    const archive = join(directory, "source.tar");
    await c({ file: archive, cwd: source, jobs: 1, noMtime: true, onWriteEntry(entry) { if (entry.stat === undefined) throw new Error("archive entry has no stat"); entry.stat.mode = 0o100640; entry.stat.uid = 123; entry.stat.gid = 456; } }, ["file"]);
    const staging = join(directory, "staging"); await mkdir(staging);
    const resolved = await materializeSource({ kind: "archive", artifact: { path: archive, sha256: await hashFile(archive) } }, staging, { recipeDir: directory, signingKeyFile: "unused.pem" });
    const tree = await collectRootfs(resolved.root, undefined, undefined, resolved.metadata);
    expect(tree.entries).toEqual([{ path: "file", type: "file", mode: 0o640, ownership: { uid: 123, gid: 456 }, blob: hash("content") }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("reads execute-only guest files through private staging without changing their signed permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-execute-only-"));
  try {
    const source = join(directory, "source"); await mkdir(join(source, "parent"), { recursive: true });
    await writeFile(join(source, "parent/tool"), "executable bytes");
    const archive = join(directory, "source.tar");
    await c({ file: archive, cwd: source, jobs: 1, noMtime: true, onWriteEntry(entry) {
      if (entry.stat === undefined) throw new Error("archive entry has no stat");
      entry.stat.mode = (entry.stat.mode & ~0o7777) | (entry.stat.isDirectory() ? 0o500 : 0o4111);
    } }, ["parent"]);
    const staging = join(directory, "staging"); await mkdir(staging);
    const resolved = await materializeSource({ kind: "archive", artifact: { path: archive, sha256: await hashFile(archive) } }, staging, { recipeDir: directory, signingKeyFile: "unused.pem" });
    const tree = await collectRootfs(resolved.root, undefined, undefined, resolved.metadata);
    expect(tree.entries.find(entry => entry.path === "parent/tool")).toMatchObject({ type: "file", mode: 0o4111 });
    expect(tree.entries.find(entry => entry.path === "parent")).toMatchObject({ type: "directory", mode: 0o500 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
