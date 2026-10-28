import { AgentPayloadReader, AgentPayloadWriter, MAX_AGENT_PAYLOAD_BYTES } from "./agent-protocol.ts";
import { VMError } from "./errors.ts";
import { compareFileNames, decodeAgentFileEntries, encodeAgentFileRequest, readAgentFileEntry, writeAgentFileEntry, workspaceFilePath, type AgentFileRequest } from "./protocol/agent-files.ts";
import { decodeWorkspaceChangesMessage, type FileResult } from "./protocol/workspace-files.ts";
import { MAX_WORKSPACE_CHANGES, MAX_WORKSPACE_FILE_BYTES, type WorkspaceChange, type WorkspaceFileEntry } from "./workspace-files.ts";

export const MAX_LEGACY_FILE_BYTES = MAX_AGENT_PAYLOAD_BYTES - 4_096;
export type UserspaceFileRequest = AgentFileRequest
  | { readonly operation: "remove"; readonly path: string; readonly recursive: boolean }
  | { readonly operation: "legacy-read"; readonly path: string };
export type UserspaceFileResult = FileResult
  | { readonly operation: "remove" }
  | { readonly operation: "legacy-read"; readonly entry: WorkspaceFileEntry; readonly data: Uint8Array };
export type UserspaceFileRecord = UserspaceFileResult
  | { readonly operation: "image"; readonly entry: WorkspaceFileEntry; readonly path: string; readonly sha256: string | null };
export interface FileChangesRead { readonly cursor: bigint; readonly changes: readonly WorkspaceChange[] }
const operations = { entries: 1, stat: 2, read: 3, write: 4, mkdir: 5, rename: 6, remove: 7, "legacy-read": 8 } as const;

export function encodeUserspaceFileRequest(request: UserspaceFileRequest): Uint8Array<ArrayBuffer> {
  const writer = new AgentPayloadWriter().u32(1).u8(operations[request.operation]);
  if (request.operation === "remove") return writer.string(workspaceFilePath(request.path)).u8(request.recursive ? 1 : 0).finish();
  if (request.operation === "legacy-read") return writer.string(workspaceFilePath(request.path)).u32(MAX_LEGACY_FILE_BYTES).finish();
  return writer.bytesRaw(encodeAgentFileRequest(request)).finish();
}

export function decodeUserspaceFileRecord(bytes: Uint8Array, request: UserspaceFileRequest): UserspaceFileRecord {
  const input = new AgentPayloadReader(bytes);
  if (input.u32() !== 1 || input.u8() !== operations[request.operation]) fail("file record version/operation mismatch");
  const outcome = input.u8();
  if (outcome !== 0) {
    let error: VMError;
    switch (outcome) {
      case 1: error = errnoError(input.u32()); break;
      case 2: error = storageError("version-mismatch"); break;
      case 3: { const size = input.u64(); if (size > BigInt(Number.MAX_SAFE_INTEGER)) fail("file size is outside the safe integer range"); error = storageError("too-large", Number(size)); break; }
      case 4: error = storageError("not-a-file"); break;
      default: fail("invalid file outcome");
    }
    input.finish(); throw error;
  }
  const path = workspaceFilePath(request.operation === "rename" ? request.from : request.path);
  if (request.operation === "entries") return { operation: "entries", ...decodeAgentFileEntries(bytes.subarray(6), path) };
  if (request.operation === "mkdir" || request.operation === "rename" || request.operation === "remove") { input.finish(); return { operation: request.operation }; }
  if (request.operation === "stat" || request.operation === "write") {
    const entry = readAgentFileEntry(input, path); input.finish(); return { operation: request.operation, entry };
  }
  const source = input.u8(); const entry = readAgentFileEntry(input, path);
  const maximum = request.operation === "legacy-read" ? MAX_LEGACY_FILE_BYTES : request.maxBytes;
  if (entry.kind !== "file" || entry.size > maximum) fail("invalid file read entry");
  if (source === 0) {
    const length = input.u32(); if (length !== entry.size || length > maximum) fail("invalid file read length");
    const data = input.take(length).slice(); input.finish(); return { operation: request.operation, entry, data };
  }
  if (source === 1) {
    const imagePath = input.string();
    if (!imagePath.startsWith("/") || imagePath.includes("\0") || new TextEncoder().encode(imagePath).length > 4_095 || imagePath.split("/").some(part => part === "." || part === "..")) fail("invalid image blob path");
    const hasHash = input.u8(); if (hasHash > 1) fail("invalid image blob identity");
    const sha256 = hasHash === 1 ? Array.from(input.take(32), byte => byte.toString(16).padStart(2, "0")).join("") : null;
    input.finish(); return { operation: "image", entry, path: imagePath, sha256 };
  }
  fail("invalid file source");
}

export function decodeUserspaceFileChanges(bytes: Uint8Array): FileChangesRead {
  const input = new AgentPayloadReader(bytes);
  if (input.u32() !== 1) fail("file change record version mismatch");
  const cursor = input.u64(); const lost = input.u8(); const count = input.u32();
  if (lost > 1 || count > MAX_WORKSPACE_CHANGES || lost === 1 && count !== 0) fail("invalid file changes header");
  const changes: WorkspaceChange[] = []; let previous: readonly [string, string] | undefined;
  for (let i = 0; i < count; i++) {
    const directory = input.string(); const name = input.string();
    if (previous !== undefined && (compareFileNames(previous[0], directory) > 0 || previous[0] === directory && compareFileNames(previous[1], name) >= 0)) fail("unordered file changes");
    changes.push({ kind: "changed", directory, name }); previous = [directory, name];
  }
  input.finish();
  const message = decodeWorkspaceChangesMessage({ type: "changes", changes: lost === 1 ? [{ kind: "rescan" }] : changes });
  if (message.type !== "changes") fail("invalid file changes");
  return { cursor, changes: message.changes };
}
function errnoError(errno: number): VMError {
  switch (errno) {
    case 2: return new VMError("STORAGE_NOT_FOUND", "Workspace entry is missing");
    case 1: case 13: case 30: return new VMError("PERMISSION_DENIED", "Workspace entry is not accessible");
    case 17: return storageError("exists");
    case 20: return storageError("not-a-directory");
    case 21: return storageError("not-a-file");
    case 11: case 16: return storageError("busy");
    case 22: case 36: case 40: return new VMError("INVALID_ARGUMENT", "Invalid workspace path or operation", { errno });
    case 5: case 12: case 28: case 39: return new VMError("STORAGE_ERROR", "Workspace operation failed", { errno });
    default: fail("unknown file errno");
  }
}
function storageError(reason: string, size?: number) { return new VMError("STORAGE_ERROR", `Workspace operation failed: ${reason}`, { reason, ...(size === undefined ? {} : { size }) }); }
function fail(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }

export function decodeUserspaceFileRequest(bytes: Uint8Array): UserspaceFileRequest {
  const input = new AgentPayloadReader(bytes);
  if (input.u32() !== 1) fail("file request version mismatch");
  const operation = input.u8(); const path = input.string();
  checkedPath(path);
  let request: UserspaceFileRequest;
  switch (operation) {
    case 1: request = { operation: "entries", path }; break;
    case 2: request = { operation: "stat", path }; break;
    case 3: { const maxBytes = input.u32(); if (maxBytes > MAX_WORKSPACE_FILE_BYTES) fail("file request exceeds limit"); request = { operation: "read", path, maxBytes }; break; }
    case 4: {
      const condition = input.u8(); if (condition > 2) fail("invalid file condition");
      const version = condition === 2 ? Array.from(input.take(24), byte => byte.toString(16).padStart(2, "0")).join("") : condition === 1 ? null : undefined;
      const length = input.u32(); if (length > MAX_WORKSPACE_FILE_BYTES) fail("file write exceeds limit");
      request = { operation: "write", path, data: input.take(length), ...(version === undefined ? {} : { ifVersion: version }) }; break;
    }
    case 5: request = { operation: "mkdir", path }; break;
    case 6: { const to = input.string(); checkedPath(to); request = { operation: "rename", from: path, to }; break; }
    case 7: { const recursive = input.u8(); if (recursive > 1) fail("invalid remove flags"); request = { operation: "remove", path, recursive: recursive === 1 }; break; }
    case 8: if (input.u32() !== MAX_LEGACY_FILE_BYTES) fail("invalid legacy file limit"); request = { operation: "legacy-read", path }; break;
    default: fail("unknown file request");
  }
  input.finish(); return request;
}

function checkedPath(path: string): void {
  try { if (workspaceFilePath(path) !== path) fail("noncanonical file path"); }
  catch { fail("invalid workspace file path"); }
}

export function encodeResidentFileRecord(request: UserspaceFileRequest, entry: WorkspaceFileEntry, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const writer = new AgentPayloadWriter().u32(1).u8(operations[request.operation]).u8(0).u8(0);
  writeAgentFileEntry(writer, entry); return writer.bytes(bytes).finish();
}

export function isFileOperation<K extends UserspaceFileResult["operation"]>(result: UserspaceFileRecord, operation: K): result is Extract<UserspaceFileResult, { operation: K }> {
  return result.operation === operation;
}
