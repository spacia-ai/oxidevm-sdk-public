import { exactKeys, integer, protocolError, record, string } from "./decode.js";
import { compareWorkspacePaths, decodeFileTimes, sameFileOwnership, sameFileTimes, type FileOwnership, type FileTimes } from "./workspace-record.js";
import type { UserspaceRootfsEntry, UserspaceRootfsManifest } from "./userspace-rootfs.js";

const MAX_FILES = 262_144;
const MODE_MAX = 0o7777;
const MAX_PATH_BYTES = 4096;
const MAX_COMPONENT_BYTES = 255;
const MAX_DEPTH = 64;

/** Owned schemas (4 and newer) admit hardlinks and use guest UTF-8 path order;
 * schema 6 adds exact inode timestamps. */
export function decodeRootfsEntries(value: unknown, blobs: ReadonlySet<string>, owned: boolean, timed: boolean): UserspaceRootfsEntry[] {
  if (!Array.isArray(value) || value.length > MAX_FILES) throw protocolError("rootfs entries must be a bounded array");
  let previous = "";
  const files = new Map<string, UserspaceRootfsEntry>();
  return value.map((item, index) => {
    const entry = record(item, `entries[${index}]`);
    const type = string(entry["type"], `entries[${index}].type`);
    const optional = type === "file" ? ["blob"] : type === "symlink" || type === "hardlink" ? ["target"] : [];
    if (type !== "file" && type !== "directory" && type !== "symlink" && !(owned && type === "hardlink")) {
      throw protocolError(`entries[${index}].type is unsupported`);
    }
    exactKeys(entry, ["type", "path", "mode", ...optional, ...(owned ? ["ownership"] : []), ...(timed ? ["times"] : [])]);
    const metadata: { ownership?: FileOwnership; times?: FileTimes } = {};
    if (owned) {
      const owner = record(entry["ownership"], "rootfs ownership"); exactKeys(owner, ["uid", "gid"]);
      metadata.ownership = { uid: integer(owner["uid"], "rootfs UID", 0, 0xffff_fffe), gid: integer(owner["gid"], "rootfs GID", 0, 0xffff_fffe) };
    }
    if (timed) metadata.times = decodeFileTimes(entry["times"]);
    const path = rootfsPath(entry["path"], `entries[${index}].path`);
    const order = owned ? compareWorkspacePaths(new TextEncoder().encode(path), new TextEncoder().encode(previous)) : path < previous ? -1 : path === previous ? 0 : 1;
    if (order <= 0) throw protocolError("rootfs entries must use unique sorted paths");
    previous = path;
    const mode = integer(entry["mode"], `entries[${index}].mode`, 0, MODE_MAX);
    if (type === "directory") return { type, path, mode, ...metadata };
    if (type === "file") {
      const blob = string(entry["blob"], `entries[${index}].blob`);
      if (!blobs.has(blob)) throw protocolError(`entries[${index}] references an unknown blob`);
      const file: UserspaceRootfsEntry = { type, path, mode, blob, ...metadata };
      files.set(path, file);
      return file;
    }
    if (type === "hardlink") {
      const target = rootfsPath(entry["target"], `entries[${index}].target`);
      const file = files.get(target);
      if (file?.type !== "file" || mode !== file.mode || !sameFileOwnership(metadata.ownership, file.ownership) || !sameFileTimes(metadata.times, file.times)) {
        throw protocolError("rootfs hardlink must name a preceding regular file with matching metadata");
      }
      return { type, path, mode, target, ...metadata };
    }
    const target = string(entry["target"], `entries[${index}].target`);
    validateSymlink(path, target);
    return { type, path, mode, target, ...metadata };
  });
}

export function decodeRootfsRuntimes(value: unknown, entries: readonly UserspaceRootfsEntry[]): UserspaceRootfsManifest["runtimes"] {
  const runtimes = record(value, "runtimes");
  exactKeys(runtimes, ["supportingFiles"], ["muslLoader", "glibcLoader", "node", "bun"]);
  const files = new Set(entries.filter((entry) => entry.type === "file").map((entry) => entry.path));
  const result: {
    muslLoader?: string;
    glibcLoader?: string;
    node?: string;
    bun?: string;
    supportingFiles: string[];
  } = { supportingFiles: [] };
  for (const name of ["muslLoader", "glibcLoader", "node", "bun"] as const) {
    if (runtimes[name] === undefined) continue;
    const path = rootfsPath(runtimes[name], `runtimes.${name}`);
    if (!files.has(path)) throw protocolError(`runtimes.${name} is not a regular file in the rootfs`);
    result[name] = path;
  }
  if (!Array.isArray(runtimes["supportingFiles"]) || runtimes["supportingFiles"].length > MAX_FILES) {
    throw protocolError("runtimes.supportingFiles must be a bounded array");
  }
  const supportingFiles = runtimes["supportingFiles"].map((value, index) => rootfsPath(value, `runtimes.supportingFiles[${index}]`));
  if (new Set(supportingFiles).size !== supportingFiles.length || supportingFiles.some((path) => !files.has(path))) {
    throw protocolError("runtimes.supportingFiles must name unique regular files in the rootfs");
  }
  result.supportingFiles = supportingFiles;
  return result;
}

function rootfsPath(value: unknown, label: string): string {
  const path = string(value, label);
  const bytes = new TextEncoder();
  if (path.length === 0 || path.startsWith("/") || path.includes("\0") || bytes.encode(path).byteLength > MAX_PATH_BYTES) {
    throw protocolError(`${label} is not a canonical relative path`);
  }
  const components = path.split("/");
  if (components.length > MAX_DEPTH || components.some((part) => part === "" || part === "." || part === ".." || bytes.encode(part).byteLength > MAX_COMPONENT_BYTES)) {
    throw protocolError(`${label} is not a canonical relative path`);
  }
  return path;
}

function validateSymlink(path: string, target: string): void {
  if (target.length === 0 || target.includes("\0") || new TextEncoder().encode(target).byteLength > MAX_PATH_BYTES) {
    throw protocolError("rootfs symlink target is invalid");
  }
  const stack = target.startsWith("/") ? [] : path.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.pop() === undefined) throw protocolError("rootfs symlink escapes the root");
    } else {
      if (new TextEncoder().encode(part).byteLength > MAX_COMPONENT_BYTES || stack.length >= MAX_DEPTH) {
        throw protocolError("rootfs symlink target is invalid");
      }
      stack.push(part);
    }
  }
}
