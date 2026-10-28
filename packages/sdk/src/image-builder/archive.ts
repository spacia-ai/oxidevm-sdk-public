import { link, lstat, symlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Parser } from "tar";
import { VMError } from "../runtime/errors.js";
import { integer } from "../runtime/decode.js";
import type { SourceFileMetadata } from "./files.js";
import { abortIfRequested } from "./tools.js";
import { readTarFile } from "./tar-reader.js";
import { extractTarFiles } from "./extract-tar.js";
import type { StagedTarEntry } from "./extract-tar.js";

function invalid(message: string): never { throw new VMError("INVALID_ARGUMENT", `source archive: ${message}`); }
function relative(path: string): string {
  if (isAbsolute(path) || path.includes("\0") || path.includes("\\") || path.split("/").includes("..") || Buffer.byteLength(path) > 4096 || path.split("/").length > 64) return invalid("entry path escapes its bounded root");
  return path.split("/").filter(part => part !== "" && part !== ".").join("/");
}
async function parent(root: string, path: string): Promise<void> {
  let directory = root;
  for (const segment of path.split("/").slice(0, -1)) {
    directory = join(directory, segment); const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return invalid("link parent is not a staged directory");
  }
}

/** Guest metadata stays distinct from the readable author staging permissions. */
export async function unpackSourceArchive(archive: string, root: string, signal?: AbortSignal): Promise<ReadonlyMap<string, SourceFileMetadata>> {
  const metadata = new Map<string, SourceFileMetadata>();
  const kinds = new Map<string, string>(); const symlinks = new Map<string, string>(); const hardlinks = new Map<string, string>();
  const staged = new Map<string, StagedTarEntry>();
  let bytes = 0;
  const validation: { failure: Error | undefined } = { failure: undefined };
  const requireValid = (): void => { if (validation.failure !== undefined) throw validation.failure; };
  try {
    const parser = new Parser({ strict: true, onReadEntry: entry => {
      if (validation.failure !== undefined) return;
      try {
      abortIfRequested(signal);
      const path = relative(entry.path);
      if (path === "" && entry.type === "Directory") return;
      if (path === "" || kinds.has(path)) return invalid("empty or duplicate normalized path");
      const type = entry.type;
      if (type !== "File" && type !== "Directory" && type !== "Link" && type !== "SymbolicLink") return invalid("unsupported entry type");
      bytes += integer(entry.size, "entry bytes", 0, 128 * 1024 ** 2);
      if (bytes > 8 * 1024 ** 3 || kinds.size >= 262_144) return invalid("expanded filesystem exceeds its byte or entry bound");
      kinds.set(path, entry.type);
      staged.set(path, { type, bytes: entry.size, ...(type === "Link" || type === "SymbolicLink" ? { linkpath: entry.linkpath ?? "" } : {}) });
      metadata.set(path, { mode: integer(entry.mode ?? 0o755, "archive mode", 0, 0o7777), ownership: { uid: integer(entry.uid ?? 0, "archive UID", 0, 0xffff_fffe), gid: integer(entry.gid ?? 0, "archive GID", 0, 0xffff_fffe) } });
      if (entry.type === "Link") {
        if (entry.linkpath === undefined) return invalid("hardlink has no target");
        hardlinks.set(path, relative(entry.linkpath));
      }
      if (entry.type === "SymbolicLink") {
        if (entry.linkpath === undefined || entry.linkpath.includes("\0") || Buffer.byteLength(entry.linkpath) > 4096) return invalid("symlink has an invalid target");
        symlinks.set(path, entry.linkpath);
      }
      } catch (error) {
        validation.failure = error instanceof Error ? error : new VMError("INVALID_ARGUMENT", "source archive validation failed");
        parser.abort(validation.failure);
      } finally { entry.resume(); }
    } });
    await readTarFile(archive, parser, signal);
    requireValid();
    for (const path of kinds.keys()) {
      const segments = path.split("/");
      for (let length = 1; length < segments.length; length++) {
        const ancestor = kinds.get(segments.slice(0, length).join("/"));
        if (ancestor !== undefined && ancestor !== "Directory") return invalid("entry descends through a nondirectory");
      }
    }
    const targets = new Map<string, string>();
    for (const [path, initial] of hardlinks) {
      let target = initial; let depth = 0;
      for (;;) {
        const next = hardlinks.get(target);
        if (next === undefined) break;
        if (depth++ >= 64 || target === path) return invalid("hardlink chain is cyclic or too deep");
        target = next;
      }
      if (kinds.get(target) !== "File") return invalid("hardlink target is not a regular file");
      targets.set(path, target);
    }
    abortIfRequested(signal);
    await extractTarFiles(archive, root, staged, signal);
    requireValid();
    for (const [path, target] of targets) { abortIfRequested(signal); await parent(root, path); await link(join(root, target), join(root, path)); }
    for (const [path, target] of symlinks) { abortIfRequested(signal); await parent(root, path); await symlink(target, join(root, path)); }
    return metadata;
  } catch (error) {
    abortIfRequested(signal);
    if (error instanceof VMError) throw error;
    return invalid("malformed archive or unsupported filesystem structure");
  }
}
