import { exactKeys, integer, protocolError, record, string } from "../decode.ts";
import { decodeSerializedError, type SerializedError } from "../errors.ts";
import { MAX_WORKSPACE_CHANGES, MAX_WORKSPACE_ENTRIES, MAX_WORKSPACE_FILE_BYTES, type WorkspaceChange, type WorkspaceFileEntry } from "../workspace-files.ts";
import { compareFileNames, encodeAgentFileRequest, encodeAgentFileWatch, workspaceFilePath, type AgentFileRequest } from "./agent-files.ts";
import { PROTOCOL_VERSION } from "./common.ts";
import { decodeBytes, decodeUndefined } from "./decoders.ts";

export type FileResult =
  | { readonly operation: "entries"; readonly entries: WorkspaceFileEntry[]; readonly omitted: number }
  | { readonly operation: "stat"; readonly entry: WorkspaceFileEntry }
  | { readonly operation: "write"; readonly entry: WorkspaceFileEntry }
  | { readonly operation: "read"; readonly entry: WorkspaceFileEntry; readonly data: Uint8Array }
  | { readonly operation: "mkdir" }
  | { readonly operation: "rename" };

export function isFileResultOperation<K extends FileResult["operation"]>(result: FileResult, operation: K): result is Extract<FileResult, { operation: K }> {
  return result.operation === operation;
}

export interface FileControlOperations {
  readonly "agent-files": { readonly request: { readonly request: AgentFileRequest }; readonly response: FileResult };
  readonly "agent-files-watch": { readonly request: { readonly port: MessagePort }; readonly response: undefined };
  readonly "agent-files-set": { readonly request: { readonly directories: readonly string[] }; readonly response: undefined };
  readonly "agent-files-unwatch": { readonly request: undefined; readonly response: undefined };
}

type Base = { readonly id: number; readonly version: typeof PROTOCOL_VERSION };
export type FileControlRequest =
  | (Base & { readonly type: "agent-files"; readonly request: AgentFileRequest })
  | (Base & { readonly type: "agent-files-watch"; readonly port: MessagePort })
  | (Base & { readonly type: "agent-files-set"; readonly directories: readonly string[] })
  | (Base & { readonly type: "agent-files-unwatch" });

export type WorkspaceChangesMessage =
  | { readonly type: "changes"; readonly changes: readonly WorkspaceChange[] }
  | { readonly type: "failed"; readonly error: SerializedError };

export const fileResponseDecoders = {
  "agent-files": decodeFileResult,
  "agent-files-watch": decodeUndefined,
  "agent-files-set": decodeUndefined,
  "agent-files-unwatch": decodeUndefined,
};

export function isFileControlType(type: string): type is keyof FileControlOperations {
  return Object.hasOwn(fileResponseDecoders, type);
}

export function decodeFileControl(value: unknown): FileControlRequest {
  const input = record(value, "native file request");
  const id = integer(input["id"], "request id", 1);
  integer(input["version"], "protocol version", PROTOCOL_VERSION, PROTOCOL_VERSION);
  const base: Base = { id, version: PROTOCOL_VERSION };
  switch (input["type"]) {
    case "agent-files": exactKeys(input, ["id", "version", "type", "request"]); return { ...base, type: "agent-files", request: decodeFileRequest(input["request"]) };
    case "agent-files-watch": {
      exactKeys(input, ["id", "version", "type", "port"]);
      if (!(input["port"] instanceof MessagePort)) throw protocolError("workspace watch requires a MessagePort");
      return { ...base, type: "agent-files-watch", port: input["port"] };
    }
    case "agent-files-set": exactKeys(input, ["id", "version", "type", "directories"]); return { ...base, type: "agent-files-set", directories: decodeDirectories(input["directories"]) };
    case "agent-files-unwatch": exactKeys(input, ["id", "version", "type"]); return { ...base, type: "agent-files-unwatch" };
    default: throw protocolError("unknown native file control operation");
  }
}

export function decodeDirectories(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw protocolError("workspace directories must be an array");
  const paths = value.map(item => decodedPath(item));
  try { encodeAgentFileWatch(paths); } catch { throw protocolError("invalid workspace directory set"); }
  return paths;
}

export function decodeFileRequest(value: unknown): AgentFileRequest {
  const input = record(value, "native file operation");
  let request: AgentFileRequest;
  switch (input["operation"]) {
    case "entries": case "stat": case "mkdir":
      exactKeys(input, ["operation", "path"]); request = { operation: input["operation"], path: decodedPath(input["path"]) }; break;
    case "read": exactKeys(input, ["operation", "path", "maxBytes"]); request = { operation: "read", path: decodedPath(input["path"]), maxBytes: integer(input["maxBytes"], "read limit", 0, MAX_WORKSPACE_FILE_BYTES) }; break;
    case "write": {
      exactKeys(input, ["operation", "path", "data"], ["ifVersion"]);
      const version = input["ifVersion"];
      if (version !== undefined && version !== null && (typeof version !== "string" || !/^[0-9a-f]{48}$/u.test(version))) throw protocolError("invalid workspace version");
      request = { operation: "write", path: decodedPath(input["path"]), data: decodeBytes(input["data"]), ...(version === undefined ? {} : { ifVersion: version }) }; break;
    }
    case "rename": exactKeys(input, ["operation", "from", "to"]); request = { operation: "rename", from: decodedPath(input["from"]), to: decodedPath(input["to"]) }; break;
    default: throw protocolError("unknown native file operation");
  }
  try { encodeAgentFileRequest(request); } catch { throw protocolError("invalid native file operation"); }
  return request;
}

export function decodeFileResult(value: unknown): FileResult {
  const input = record(value, "native file result");
  switch (input["operation"]) {
    case "entries": {
      exactKeys(input, ["operation", "entries", "omitted"]);
      const omitted = integer(input["omitted"], "omitted filenames", 0, MAX_WORKSPACE_ENTRIES);
      if (!Array.isArray(input["entries"]) || input["entries"].length + omitted > MAX_WORKSPACE_ENTRIES) throw protocolError("invalid native entries");
      const entries = input["entries"].map(decodeFileEntry);
      for (let i = 1; i < entries.length; i++) if (compareFileNames(entries[i - 1]?.name ?? "", entries[i]?.name ?? "") >= 0) throw protocolError("unordered native entries");
      return { operation: "entries", entries, omitted };
    }
    case "stat": case "write": exactKeys(input, ["operation", "entry"]); return { operation: input["operation"], entry: decodeFileEntry(input["entry"]) };
    case "read": {
      exactKeys(input, ["operation", "entry", "data"]);
      const entry = decodeFileEntry(input["entry"]); const data = decodeBytes(input["data"]);
      if (entry.kind !== "file" || data.byteLength !== entry.size || data.byteLength > MAX_WORKSPACE_FILE_BYTES) throw protocolError("invalid native file bytes");
      return { operation: "read", entry, data };
    }
    case "mkdir": case "rename": exactKeys(input, ["operation"]); return { operation: input["operation"] };
    default: throw protocolError("unknown native file result");
  }
}

export function decodeFileEntry(value: unknown): WorkspaceFileEntry {
  const input = record(value, "workspace entry");
  exactKeys(input, ["kind", "link", "name", "path", "size", "version"]);
  const kind = input["kind"];
  if (kind !== "file" && kind !== "directory" && kind !== "symlink") throw protocolError("invalid workspace kind");
  const path = decodedPath(input["path"]); const name = decodedName(input["name"], path === "/");
  if (name !== path.split("/").at(-1)) throw protocolError("workspace path/name mismatch");
  const size = integer(input["size"], "file size", 0); const version = string(input["version"], "file version");
  if (!/^[0-9a-f]{48}$/u.test(version) || kind === "directory" && size !== 0) throw protocolError("invalid workspace identity");
  let link: WorkspaceFileEntry["link"] = null;
  if (kind === "symlink") {
    const target = record(input["link"], "workspace link"); exactKeys(target, ["kind", "path"]);
    if (target["kind"] !== "file" && target["kind"] !== "directory" && target["kind"] !== "missing") throw protocolError("invalid link kind");
    const resolved = target["path"] === null ? null : decodedPath(target["path"]);
    if ((target["kind"] === "missing") !== (resolved === null)) throw protocolError("invalid link target");
    link = { kind: target["kind"], path: resolved };
  } else if (input["link"] !== null) throw protocolError("non-link entry has a link target");
  return { kind, link, name, path, size, version };
}

export function decodeWorkspaceChangesMessage(value: unknown): WorkspaceChangesMessage {
  const input = record(value, "workspace changes message");
  if (input["type"] === "failed") { exactKeys(input, ["type", "error"]); return { type: "failed", error: decodeSerializedError(input["error"]) }; }
  exactKeys(input, ["type", "changes"]);
  if (input["type"] !== "changes") throw protocolError("invalid workspace changes");
  return { type: "changes", changes: decodeWorkspaceChanges(input["changes"]) };
}

/** One batch of at most 1,024 workspace changes with normalized directories and Linux names. */
export function decodeWorkspaceChanges(value: unknown): readonly WorkspaceChange[] {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_CHANGES) throw protocolError("invalid workspace changes");
  const items: readonly unknown[] = value;
  return items.map((item): WorkspaceChange => {
    const change = record(item, "workspace change");
    if (change["kind"] === "rescan") { exactKeys(change, ["kind"]); return { kind: "rescan" }; }
    exactKeys(change, ["kind", "directory", "name"]);
    if (change["kind"] !== "changed") throw protocolError("unknown workspace change");
    return { kind: "changed", directory: decodedPath(change["directory"]), name: decodedName(change["name"]) };
  });
}

function decodedPath(value: unknown): string {
  const path = string(value, "workspace path");
  try { if (workspaceFilePath(path) === path) return path; } catch { /* invalid wire path */ }
  throw protocolError("invalid workspace path");
}
function decodedName(value: unknown, root = false): string {
  const name = string(value, "workspace name");
  if ((!root && name === "") || new TextEncoder().encode(name).length > 255 || /[/\\\0]/u.test(name) || name === "." || name === "..") throw protocolError("invalid workspace name");
  return name;
}
