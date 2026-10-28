import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { c } from "tar";
import { afterEach, beforeEach, expect, it } from "vitest";
import { unpackSourceArchive } from "./archive.js";
import { restoreImageEntries, savedImageEntries } from "./docker-init-layer.js";
import { collectRootfs, hash } from "./files.js";

/** One tar entry: a regular file, a directory, a symbolic link, or an OCI whiteout marker. */
type Entry =
  | { readonly path: string; readonly file: string; readonly mode?: number; readonly uid?: number }
  | { readonly path: string; readonly directory: true; readonly mode?: number }
  | { readonly path: string; readonly link: string };

let work: string;
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), "oxidevm-init-layer-")); });
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

/** A tar of `entries`, with the modes and owners they name rather than the host's. */
async function tarOf(name: string, entries: readonly Entry[]): Promise<string> {
  const source = join(work, `${name}.d`); const archive = join(work, `${name}.tar`);
  const modes = new Map<string, { mode: number; uid: number }>();
  for (const entry of entries) {
    const path = join(source, entry.path);
    await mkdir("directory" in entry ? path : dirname(path), { recursive: true });
    if ("file" in entry) await writeFile(path, entry.file);
    if ("link" in entry) await symlink(entry.link, path);
    modes.set(entry.path, { mode: "link" in entry ? 0o777 : entry.mode ?? ("directory" in entry ? 0o755 : 0o644), uid: "file" in entry ? entry.uid ?? 0 : 0 });
  }
  await c({ file: archive, cwd: source, jobs: 1, noMtime: true, portable: false, onWriteEntry(written) {
    const wanted = modes.get(written.path.replace(/\/$/u, ""));
    if (written.stat === undefined) throw new Error("archive entry has no stat");
    written.stat.mode = (written.stat.mode & ~0o7777) | (wanted?.mode ?? 0o755);
    written.stat.uid = wanted?.uid ?? 0; written.stat.gid = 0;
  } }, entries.map(entry => entry.path).filter(path => !entries.some(other => other.path !== path && path.startsWith(`${other.path}/`))));
  return archive;
}

/** What `docker image save` writes: layer blobs, a config blob, then manifest.json. */
async function savedImage(layers: readonly (readonly Entry[])[], images = 1): Promise<string> {
  const layout = join(work, "saved.d"); await mkdir(join(layout, "blobs/sha256"), { recursive: true });
  const names: string[] = [];
  for (const [index, entries] of layers.entries()) {
    const bytes = await readFile(await tarOf(`layer-${String(index)}`, entries));
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(layout, "blobs/sha256", digest), bytes); names.push(`blobs/sha256/${digest}`);
  }
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux" }));
  const configDigest = createHash("sha256").update(config).digest("hex");
  await writeFile(join(layout, "blobs/sha256", configDigest), config);
  const image = { Config: `blobs/sha256/${configDigest}`, RepoTags: null, Layers: names };
  await writeFile(join(layout, "manifest.json"), JSON.stringify(Array.from({ length: images }, () => image)));
  const archive = join(work, "saved.tar");
  await c({ file: archive, cwd: layout, jobs: 1, noMtime: true }, ["blobs", "manifest.json"]);
  return archive;
}

/** Docker's init layer as `docker export` writes it over a container's image (moby daemon/initlayer). */
const INIT_LAYER: readonly Entry[] = [
  { path: ".dockerenv", file: "", mode: 0o755 }, { path: "dev/console", file: "", mode: 0o755 },
  { path: "dev/pts", directory: true }, { path: "dev/shm", directory: true },
  { path: "etc/hostname", file: "", mode: 0o755 }, { path: "etc/hosts", file: "", mode: 0o755 },
  { path: "etc/resolv.conf", file: "", mode: 0o755 }, { path: "etc/mtab", link: "/proc/mounts" },
  { path: "proc", directory: true }, { path: "sys", directory: true },
];

/** The exported container unpacked, its init-layer paths restored from `saved`, as the rootfs records them. */
async function restored(exported: readonly Entry[], saved: string) {
  const root = join(work, "root"); await mkdir(root);
  const metadata = await unpackSourceArchive(await tarOf("exported", exported), root);
  const fixed = await restoreImageEntries(root, metadata, await savedImageEntries(saved));
  return new Map((await collectRootfs(root, undefined, undefined, fixed)).entries.map(entry => [entry.path, entry]));
}

it("puts the image's own host files back where docker export left Docker's empty ones", async () => {
  const base: Entry[] = [
    { path: "bin/sh", file: "shell", mode: 0o755 }, { path: "dev", directory: true },
    { path: "etc/hostname", file: "localhost\n" }, { path: "etc/hosts", file: "127.0.0.1\tlocalhost\n" },
    { path: "etc/mtab", link: "../proc/mounts" }, { path: "proc", directory: true, mode: 0o555 }, { path: "sys", directory: true, mode: 0o555 },
  ];
  const copied: Entry[] = [{ path: "etc/hosts", file: "127.0.0.1\tlocalhost oxidevm\n" }, { path: "etc/resolv.conf", file: "nameserver 192.0.2.1\n", uid: 7 }];
  const tree = await restored([{ path: "bin/sh", file: "shell", mode: 0o755 }, ...INIT_LAYER], await savedImage([base, copied]));
  expect(tree.get("etc/hosts")).toMatchObject({ type: "file", mode: 0o644, blob: hash("127.0.0.1\tlocalhost oxidevm\n") });
  expect(tree.get("etc/hostname")).toMatchObject({ type: "file", blob: hash("localhost\n") });
  expect(tree.get("etc/resolv.conf")).toMatchObject({ type: "file", ownership: { uid: 7, gid: 0 }, blob: hash("nameserver 192.0.2.1\n") });
  expect(tree.get("etc/mtab")).toMatchObject({ type: "symlink", target: "../proc/mounts" });
  expect(tree.get("proc")).toMatchObject({ type: "directory", mode: 0o555 });
  expect(tree.get("sys")).toMatchObject({ type: "directory", mode: 0o555 });
  for (const docker of [".dockerenv", "dev/console", "dev/pts", "dev/shm"]) expect(tree.has(docker), docker).toBe(false);
  expect(tree.get("dev")).toMatchObject({ type: "directory" });
  expect(tree.get("bin/sh")).toMatchObject({ type: "file", mode: 0o755, blob: hash("shell") });
});

it("follows the image's whiteouts and opaque directories", async () => {
  const base: Entry[] = [{ path: "etc/hostname", file: "base\n" }, { path: "etc/hosts", file: "base hosts\n" }, { path: "etc/resolv.conf", file: "nameserver 10.0.0.1\n" }];
  const upper: Entry[] = [{ path: "etc/.wh.hostname", file: "" }];
  const opaque: Entry[] = [{ path: "etc/.wh..wh..opq", file: "" }, { path: "etc/resolv.conf", file: "nameserver 192.0.2.1\n" }];
  const tree = await restored([...INIT_LAYER], await savedImage([base, upper, opaque]));
  expect(tree.has("etc/hostname")).toBe(false);
  expect(tree.has("etc/hosts")).toBe(false);
  expect(tree.get("etc/resolv.conf")).toMatchObject({ blob: hash("nameserver 192.0.2.1\n") });
});

it("removes what the init layer added to an image built from scratch", async () => {
  const tree = await restored([{ path: "hello", file: "elf", mode: 0o755 }, ...INIT_LAYER], await savedImage([[{ path: "hello", file: "elf", mode: 0o755 }]]));
  expect([...tree.keys()]).toEqual(["hello"]);
});

it("keeps a directory the image fills without naming it", async () => {
  const tree = await restored([{ path: "proc/version", file: "image" }, ...INIT_LAYER.filter(entry => entry.path !== "proc")], await savedImage([[{ path: "proc/version", file: "image" }]]));
  expect(tree.get("proc/version")).toMatchObject({ blob: hash("image") });
  expect(tree.get("proc")).toMatchObject({ type: "directory" });
});

it("refuses a save that is not exactly one readable image", async () => {
  await expect(savedImageEntries(await savedImage([[{ path: "etc/hosts", file: "x" }]], 2))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  const oversized = await savedImage([[{ path: "etc/hosts", file: "x".repeat(1024 * 1024 + 1) }]]);
  await expect(savedImageEntries(oversized)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  const missing = join(work, "missing.d"); await mkdir(missing);
  await writeFile(join(missing, "manifest.json"), JSON.stringify([{ Config: "blobs/sha256/0", Layers: [`blobs/sha256/${"a".repeat(64)}`] }]));
  const archive = join(work, "missing.tar"); await c({ file: archive, cwd: missing, jobs: 1, noMtime: true }, ["manifest.json"]);
  await expect(savedImageEntries(archive)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
});
