import { link, lstat, mkdir, open, readdir, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Parser } from "tar";
import type { ReadEntry } from "tar";
import { VMError } from "../runtime/errors.js";
import { record, string } from "../runtime/decode.js";
import type { SourceFileMetadata } from "./files.js";
import { readTarFile } from "./tar-reader.js";
import { abortIfRequested } from "./tools.js";

// `docker export` writes a container, not its image. Docker's init layer (moby daemon/initlayer)
// covers these paths with empty files, an /etc/mtab link to /proc/mounts and four directories,
// whatever the image holds, so an image's own /etc/hosts or /etc/resolv.conf never reached its
// rootfs. The image's layers, from `docker image save`, say what belongs there instead.

/** Docker's init-layer paths, each before the directory that holds it. */
const INIT_PATHS = [".dockerenv", "dev/console", "dev/pts", "dev/shm", "etc/hostname", "etc/hosts", "etc/mtab", "etc/resolv.conf", "proc", "sys", "dev", "etc"] as const;
const TRACKED: ReadonlySet<string> = new Set(INIT_PATHS);
/** Directories whose opaque marker can hide a tracked path from the layers below. */
const OPAQUE: ReadonlySet<string> = new Set(["", "dev", "etc"]);
const MAX_FILE_BYTES = 1024 ** 2;
const MAX_MANIFEST_BYTES = 1024 ** 2;
const MAX_LAYERS = 512;
/** A blob of an OCI layout or a layer of the older docker-archive format. */
const BLOB = /^(?:blobs\/sha256\/[0-9a-f]{64}|[0-9a-f]{64}\/layer\.tar)$/u;

/** The image's own entry at an init-layer path. */
export type ImageEntry = { readonly mode: number; readonly uid: number; readonly gid: number } & (
  | { readonly type: "File"; readonly bytes: Uint8Array }
  | { readonly type: "Directory" }
  | { readonly type: "SymbolicLink" | "Link"; readonly linkpath: string });

/** What one layer does at a tracked path; "unsupported" is an entry a rootfs cannot hold (a device). */
type Change = ImageEntry | "whiteout" | "unsupported";
interface Layer { readonly changes: Map<string, Change>; readonly opaque: Set<string> }

function normalized(path: string): string { return path.split("/").filter(part => part !== "" && part !== ".").join("/"); }
function below(path: string, directory: string): boolean { return directory === "" ? path !== "" : path.startsWith(`${directory}/`); }

/** One saved blob read as a layer; undefined when it is no tar (the image config, a manifest). */
function readLayer(blob: ReadEntry): Promise<Layer | VMError | undefined> {
  return new Promise(resolve => {
    const layer: Layer = { changes: new Map(), opaque: new Set() };
    let entries = 0; let invalid = false; let failure: VMError | undefined;
    const parser = new Parser({ strict: false, onwarn: code => { if (code !== "TAR_BAD_ARCHIVE" || entries > 0) invalid = true; }, onReadEntry: entry => {
      entries += 1;
      const path = normalized(entry.path); const slash = path.lastIndexOf("/");
      const name = path.slice(slash + 1); const parent = slash < 0 ? "" : path.slice(0, slash);
      if (name === ".wh..wh..opq") { if (OPAQUE.has(parent)) layer.opaque.add(parent); entry.resume(); return; }
      if (name.startsWith(".wh.")) {
        const hidden = parent === "" ? name.slice(4) : `${parent}/${name.slice(4)}`;
        if (TRACKED.has(hidden)) layer.changes.set(hidden, "whiteout");
        entry.resume(); return;
      }
      if (!TRACKED.has(path)) { entry.resume(); return; }
      const owner = { mode: (entry.mode ?? 0o644) & 0o7777, uid: entry.uid ?? 0, gid: entry.gid ?? 0 };
      if (entry.type === "File" || entry.type === "OldFile" || entry.type === "ContiguousFile") {
        if (entry.size > MAX_FILE_BYTES) { failure ??= new VMError("INVALID_ARGUMENT", `the image's /${path} exceeds ${String(MAX_FILE_BYTES)} bytes`); entry.resume(); return; }
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => { chunks.push(chunk); });
        entry.on("end", () => { layer.changes.set(path, { ...owner, type: "File", bytes: Buffer.concat(chunks) }); });
        return;
      }
      if (entry.type === "Directory") layer.changes.set(path, { ...owner, type: "Directory" });
      else if (entry.type === "SymbolicLink" || entry.type === "Link") layer.changes.set(path, { ...owner, type: entry.type, linkpath: entry.linkpath ?? "" });
      else layer.changes.set(path, "unsupported");
      entry.resume();
    } });
    parser.on("error", () => { invalid = true; });
    parser.on("end", () => { resolve(failure ?? (invalid ? undefined : layer)); });
    blob.pipe(parser);
  });
}

/** Applies a layer over the entries below it: opaque directories first, then its own entries. */
function apply(state: Map<string, Change>, layer: Layer): void {
  for (const directory of layer.opaque) for (const path of [...state.keys()]) if (below(path, directory)) state.delete(path);
  for (const [path, change] of layer.changes) {
    if (change === "whiteout" || change === "unsupported" || change.type !== "Directory") for (const lower of [...state.keys()]) if (below(lower, path)) state.delete(lower);
    if (change === "whiteout") state.delete(path); else state.set(path, change);
  }
}

/** What the image `docker image save` wrote to `archive` holds at the init-layer paths, all layers applied. */
export async function savedImageEntries(archive: string, signal?: AbortSignal): Promise<ReadonlyMap<string, ImageEntry>> {
  const blobs = new Map<string, Promise<Layer | VMError | undefined>>(); const manifest: Buffer[] = [];
  let manifestBytes = 0;
  const parser = new Parser({ strict: true, onReadEntry: entry => {
    const path = normalized(entry.path);
    if (entry.type === "File" && path === "manifest.json") {
      entry.on("data", (chunk: Buffer) => { manifestBytes += chunk.byteLength; if (manifestBytes <= MAX_MANIFEST_BYTES) manifest.push(chunk); });
    } else if (entry.type === "File" && BLOB.test(path)) blobs.set(path, readLayer(entry));
    else entry.resume();
  } });
  await readTarFile(archive, parser, signal);
  if (manifestBytes === 0 || manifestBytes > MAX_MANIFEST_BYTES) throw new VMError("PROTOCOL_ERROR", "docker image save wrote no bounded manifest.json");
  let images: unknown;
  try { images = JSON.parse(Buffer.concat(manifest).toString("utf8")); } catch { throw new VMError("PROTOCOL_ERROR", "docker image save wrote an unreadable manifest.json"); }
  if (!Array.isArray(images) || images.length !== 1) throw new VMError("PROTOCOL_ERROR", "docker image save must write exactly one image");
  const layers = record(images[0], "saved image")["Layers"];
  if (!Array.isArray(layers) || layers.length > MAX_LAYERS) throw new VMError("PROTOCOL_ERROR", "saved image lists no bounded layers");
  const state = new Map<string, Change>();
  for (const [index, value] of layers.entries()) {
    abortIfRequested(signal);
    const layer = await blobs.get(normalized(string(value, `saved image layer ${String(index)}`)));
    if (layer instanceof VMError) throw layer;
    if (layer === undefined) throw new VMError("PROTOCOL_ERROR", "a saved image layer is missing or is not a tar archive");
    apply(state, layer);
  }
  const entries = new Map<string, ImageEntry>();
  for (const [path, change] of state) if (change !== "whiteout" && change !== "unsupported") entries.set(path, change);
  return entries;
}

function forget(metadata: Map<string, SourceFileMetadata>, path: string): void {
  for (const key of [...metadata.keys()]) if (key === path || below(key, path)) metadata.delete(key);
}

/** Puts the image's own entries back at the init-layer paths of the exported `root` and removes what
 *  only the init layer put there. Returns the metadata the rootfs records. */
export async function restoreImageEntries(root: string, exported: ReadonlyMap<string, SourceFileMetadata>, image: ReadonlyMap<string, ImageEntry>, signal?: AbortSignal): Promise<ReadonlyMap<string, SourceFileMetadata>> {
  const metadata = new Map(exported);
  for (const path of INIT_PATHS) {
    abortIfRequested(signal);
    const target = join(root, path); const entry = image.get(path);
    const present = await lstat(target).catch(() => undefined);
    if (entry === undefined) {
      // A directory the image fills without naming it stays; anything else only the init layer made.
      if (present?.isDirectory() === true && (await readdir(target)).length > 0) continue;
      await rm(target, { recursive: true, force: true }); forget(metadata, path); continue;
    }
    if ((await lstat(dirname(target)).catch(() => undefined))?.isDirectory() !== true) throw new VMError("PROTOCOL_ERROR", "docker export lacks a directory its image holds");
    if (entry.type === "Directory") {
      if (present?.isDirectory() !== true) { await rm(target, { recursive: true, force: true }); forget(metadata, path); await mkdir(target, { mode: 0o700 }); }
      metadata.set(path, { mode: entry.mode, ownership: { uid: entry.uid, gid: entry.gid } });
      continue;
    }
    await rm(target, { recursive: true, force: true }); forget(metadata, path);
    if (entry.type === "File") {
      const file = await open(target, "wx", 0o600);
      try { await file.writeFile(entry.bytes); } finally { await file.close(); }
    } else if (entry.type === "SymbolicLink") {
      if (entry.linkpath === "" || entry.linkpath.includes("\0") || Buffer.byteLength(entry.linkpath) > 4096) throw new VMError("INVALID_ARGUMENT", `the image's /${path} is an invalid symlink`);
      await symlink(entry.linkpath, target);
    } else {
      const source = normalized(entry.linkpath);
      if (source === "" || isAbsolute(entry.linkpath) || entry.linkpath.split("/").includes("..") || TRACKED.has(source) || (await lstat(join(root, source)).catch(() => undefined))?.isFile() !== true) {
        throw new VMError("INVALID_ARGUMENT", `the image's /${path} is a hard link to no regular file`);
      }
      await link(join(root, source), target);
      metadata.set(path, metadata.get(source) ?? { mode: entry.mode, ownership: { uid: entry.uid, gid: entry.gid } });
      continue;
    }
    metadata.set(path, { mode: entry.mode, ownership: { uid: entry.uid, gid: entry.gid } });
  }
  return metadata;
}
