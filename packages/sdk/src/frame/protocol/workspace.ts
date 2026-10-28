import { exactKeys, integer, protocolError, record, string } from "../../runtime/decode.js";
import { VMError } from "../../runtime/errors.js";
import { decodeFileEntry } from "../../runtime/protocol/workspace-files.js";
import { MAX_WORKSPACE_CHANGES, MAX_WORKSPACE_ENTRIES, MAX_WORKSPACE_FILE_BYTES, MAX_WORKSPACE_WATCH_DIRECTORIES } from "../../runtime/workspace-files.js";
import type { WorkspaceChange, WorkspaceFile, WorkspaceFileEntry } from "../../runtime/workspace-files.js";

// The workspace file requests of the frame protocol beyond plain reads and writes: entries with
// versions, bounded reads, conditional writes, directories, renames and directory watches. The VM
// validates paths and limits itself in the frame; the page validates the limits a decoder here
// bounds before it sends them, so a bad argument fails with the VM's own INVALID_ARGUMENT.
// A watch is a long-lived request ended by `cancel`; its events are change batches, and
// `workspace.watch.setDirectories` names the watch by its request id.

export type WorkspaceFrameOperation =
  | { readonly type: "workspace.entries" | "workspace.stat" | "workspace.createDirectory"; readonly path: string }
  | { readonly type: "workspace.readEntry"; readonly path: string; readonly maxBytes?: number }
  | { readonly type: "workspace.writeEntry"; readonly path: string; readonly data: Uint8Array; readonly ifVersion?: string | null }
  | { readonly type: "workspace.rename"; readonly from: string; readonly to: string }
  | { readonly type: "workspace.watch" }
  | { readonly type: "workspace.watch.setDirectories"; readonly watch: number; readonly directories: readonly string[] };

export type WorkspaceFrameType = WorkspaceFrameOperation["type"];

/** Paths are validated by the VM; the wire only bounds them (raw paths may repeat separators). */
export const MAX_FRAME_PATH_LENGTH = 16 * 1024;
const VERSION = /^[0-9a-f]{48}$/u;
const TYPES: readonly WorkspaceFrameType[] = [
  "workspace.entries", "workspace.stat", "workspace.createDirectory", "workspace.readEntry", "workspace.writeEntry",
  "workspace.rename", "workspace.watch", "workspace.watch.setDirectories",
];

export function isWorkspaceFrameType(type: string): type is WorkspaceFrameType {
  return TYPES.some(candidate => candidate === type);
}

/**
 * Decodes a workspace request's own fields; `envelope` names the fields every request carries.
 * `maxWrite` is the largest write the page may send in one message.
 */
export function decodeWorkspaceRequest(message: Readonly<Record<string, unknown>>, type: WorkspaceFrameType, envelope: readonly string[], maxWrite: number): WorkspaceFrameOperation {
  const fields = (required: readonly string[], optional: readonly string[] = []) => exactKeys(message, [...envelope, ...required], optional);
  switch (type) {
    case "workspace.entries": case "workspace.stat": case "workspace.createDirectory":
      fields(["path"]);
      return { type, path: path(message["path"]) };
    case "workspace.readEntry": {
      fields(["path"], ["maxBytes"]);
      const maxBytes = message["maxBytes"];
      return { type, path: path(message["path"]), ...(maxBytes === undefined ? {} : { maxBytes: integer(maxBytes, "workspace read limit", 0, MAX_WORKSPACE_FILE_BYTES) }) };
    }
    case "workspace.writeEntry": {
      fields(["path", "data"], ["ifVersion"]);
      const data = message["data"];
      if (!(data instanceof Uint8Array) || data.byteLength > maxWrite) throw protocolError("workspace write bytes are invalid");
      const ifVersion = message["ifVersion"];
      if (ifVersion !== undefined && ifVersion !== null && (typeof ifVersion !== "string" || !VERSION.test(ifVersion))) throw protocolError("workspace file version is invalid");
      return { type, path: path(message["path"]), data, ...(ifVersion === undefined ? {} : { ifVersion }) };
    }
    case "workspace.rename":
      fields(["from", "to"]);
      return { type, from: path(message["from"]), to: path(message["to"]) };
    case "workspace.watch":
      fields([]);
      return { type };
    case "workspace.watch.setDirectories": {
      fields(["watch", "directories"]);
      const directories: unknown = message["directories"];
      if (!Array.isArray(directories) || directories.length > MAX_WORKSPACE_WATCH_DIRECTORIES) throw protocolError("watched directories are invalid");
      const list: readonly unknown[] = directories;
      return { type, watch: integer(message["watch"], "workspace watch id", 1, 0x7fff_ffff), directories: list.map(path) };
    }
  }
}

/** The page's copy of a watch's directories: unique, and no more than a VM may watch. */
export function watchedDirectories(paths: readonly string[]): readonly string[] {
  const directories = [...new Set(paths)];
  if (directories.length > MAX_WORKSPACE_WATCH_DIRECTORIES) throw new VMError("INVALID_ARGUMENT", "at most 256 directories may be watched per VM");
  return directories;
}

/** An entry with exactly its wire fields, whatever else the VM's object carries. */
export function encodeFileEntry(entry: WorkspaceFileEntry): WorkspaceFileEntry {
  return { kind: entry.kind, link: entry.link === null ? null : { kind: entry.link.kind, path: entry.link.path }, name: entry.name, path: entry.path, size: entry.size, version: entry.version };
}

/** A batch larger than one event may carry becomes a rescan, which tells the page to read again. */
export function encodeWorkspaceChanges(changes: readonly WorkspaceChange[]): readonly WorkspaceChange[] {
  if (changes.length > MAX_WORKSPACE_CHANGES) return [{ kind: "rescan" }];
  return changes.map(change => change.kind === "rescan" ? { kind: "rescan" } : { kind: "changed", directory: change.directory, name: change.name });
}

export function decodeFrameEntries(value: unknown): WorkspaceFileEntry[] {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_ENTRIES) throw protocolError("workspace entries are invalid");
  const entries: readonly unknown[] = value;
  return entries.map(decodeFileEntry);
}

/** A bounded read's result: a file entry and exactly its bytes, no more than the page allowed. */
export function decodeFrameFile(value: unknown, maxBytes: number): WorkspaceFile {
  const file = record(value, "workspace file");
  exactKeys(file, ["entry", "data"]);
  const entry = decodeFileEntry(file["entry"]);
  const data = file["data"];
  if (!(data instanceof Uint8Array) || entry.kind !== "file" || data.byteLength !== entry.size || data.byteLength > Math.min(maxBytes, MAX_WORKSPACE_FILE_BYTES)) {
    throw protocolError("workspace file bytes are invalid");
  }
  return { entry, data };
}

function path(value: unknown): string {
  const text = string(value, "workspace path");
  if (text.length > MAX_FRAME_PATH_LENGTH) throw protocolError("workspace path is too long");
  return text;
}
