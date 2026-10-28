import { AgentPayloadReader, AgentPayloadWriter } from "../agent-protocol.ts";
import { VMError } from "../errors.ts";
import { normalizeWorkspacePath } from "../workspace-path.ts";
import { MAX_WORKSPACE_CHANGES, MAX_WORKSPACE_ENTRIES, MAX_WORKSPACE_FILE_BYTES, MAX_WORKSPACE_WATCH_DIRECTORIES, validateWorkspaceReadLimit, validateWorkspaceVersion } from "../workspace-files.ts";
import type { WorkspaceChange, WorkspaceFile, WorkspaceFileEntry } from "../workspace-files.ts";

export type AgentFileRequest =
  | { readonly operation: "entries"; readonly path: string }
  | { readonly operation: "stat"; readonly path: string }
  | { readonly operation: "mkdir"; readonly path: string }
  | { readonly operation: "read"; readonly path: string; readonly maxBytes: number }
  | { readonly operation: "write"; readonly path: string; readonly data: Uint8Array; readonly ifVersion?: string | null }
  | { readonly operation: "rename"; readonly from: string; readonly to: string };

export const AGENT_FILE_KINDS = { entries: 26, stat: 27, read: 28, write: 29, mkdir: 30, rename: 31 } as const;

export function workspaceFilePath(path: string): string {
  return `/${normalizeWorkspacePath(path).join("/")}`;
}

export function encodeAgentFileRequest(request: AgentFileRequest): Uint8Array<ArrayBuffer> {
  const output = new AgentPayloadWriter();
  output.string(workspaceFilePath(request.operation === "rename" ? request.from : request.path));
  switch (request.operation) {
    case "entries": case "stat": case "mkdir": break;
    case "read": output.u32(validateWorkspaceReadLimit(request.maxBytes)); break;
    case "write": {
      validateWorkspaceVersion(request.ifVersion);
      if (request.data.byteLength > MAX_WORKSPACE_FILE_BYTES) throw new VMError("INVALID_ARGUMENT", "write exceeds 16 MiB");
      output.u8(request.ifVersion === undefined ? 0 : request.ifVersion === null ? 1 : 2);
      if (typeof request.ifVersion === "string") {
        output.bytesRaw(Uint8Array.from(request.ifVersion.match(/../gu) ?? [], (hex) => Number.parseInt(hex, 16)));
      }
      output.bytes(request.data); break;
    }
    case "rename": output.string(workspaceFilePath(request.to)); break;
  }
  return output.finish();
}

export function decodeAgentFileEntry(payload: Uint8Array, path: string): WorkspaceFileEntry {
  const reader = new AgentPayloadReader(payload);
  const entry = readAgentFileEntry(reader, workspaceFilePath(path));
  reader.finish();
  return entry;
}

export function decodeAgentFileEntries(payload: Uint8Array, path: string): { readonly entries: WorkspaceFileEntry[]; readonly omitted: number } {
  const reader = new AgentPayloadReader(payload);
  const count = reader.u32();
  const omitted = reader.u32();
  if (count + omitted > MAX_WORKSPACE_ENTRIES) fail("too many workspace entries");
  const directory = workspaceFilePath(path);
  const entries: WorkspaceFileEntry[] = [];
  let previous: string | undefined;
  for (let index = 0; index < count; index += 1) {
    const entry = readAgentFileEntry(reader, directory, true);
    if (previous !== undefined && compareFileNames(previous, entry.name) >= 0) fail("workspace entries are not strictly sorted");
    entries.push(entry); previous = entry.name;
  }
  reader.finish();
  return { entries, omitted };
}

export function decodeAgentFileRead(payload: Uint8Array, path: string, maxBytes: number): WorkspaceFile {
  const reader = new AgentPayloadReader(payload);
  const outcome = reader.u8();
  if (outcome > 2) fail("invalid workspace read outcome");
  const entry = readAgentFileEntry(reader, workspaceFilePath(path));
  if (outcome !== 0) {
    reader.finish();
    throw fileFailure(outcome === 1 ? "too-large" : "not-a-file", entry.size);
  }
  const length = reader.u32();
  if (length > maxBytes || length > MAX_WORKSPACE_FILE_BYTES) fail("workspace read exceeds limit");
  const data = reader.take(length).slice();
  reader.finish();
  if (entry.kind !== "file" || data.byteLength !== entry.size || data.byteLength > maxBytes) fail("invalid workspace read bytes");
  return { entry, data };
}

export function decodeAgentFileWrite(payload: Uint8Array, path: string): WorkspaceFileEntry {
  const reader = new AgentPayloadReader(payload);
  const outcome = reader.u8();
  if (outcome > 2) fail("invalid workspace write outcome");
  if (outcome === 0) { const entry = readAgentFileEntry(reader, workspaceFilePath(path)); reader.finish(); return entry; }
  const present = reader.u8();
  if (present > 1) fail("invalid conditional file entry");
  if (present === 1) readAgentFileEntry(reader, workspaceFilePath(path));
  reader.finish();
  throw fileFailure(outcome === 1 ? "version-mismatch" : "exists");
}

export function decodeAgentFileUnit(payload: Uint8Array, operation: "mkdir" | "rename"): void {
  const reader = new AgentPayloadReader(payload);
  const outcome = reader.u8(); reader.finish();
  if (operation === "mkdir" && outcome <= 1 || operation === "rename" && outcome === 0) return;
  if (operation === "mkdir" && outcome === 2) throw fileFailure("not-a-directory");
  if (operation === "rename" && outcome === 1) throw fileFailure("exists");
  fail("invalid workspace mutation outcome");
}

export function encodeAgentFileWatch(paths: readonly string[] | null): Uint8Array<ArrayBuffer> {
  const writer = new AgentPayloadWriter();
  if (paths === null) return writer.u8(2).finish();
  if (paths.length > MAX_WORKSPACE_WATCH_DIRECTORIES) throw new VMError("INVALID_ARGUMENT", "at most 256 watched folders");
  const normalized = paths.map(workspaceFilePath);
  if (new Set(normalized).size !== normalized.length) throw new VMError("INVALID_ARGUMENT", "duplicate watched folder");
  writer.u8(1).u32(normalized.length);
  for (const path of normalized) writer.string(path);
  return writer.finish();
}

export function decodeAgentFileChanges(payload: Uint8Array, directories: readonly string[]): readonly WorkspaceChange[] {
  const reader = new AgentPayloadReader(payload);
  const flags = reader.u32(); const count = reader.u32();
  if ((flags & ~1) !== 0 || count > MAX_WORKSPACE_CHANGES) fail("invalid workspace changes header");
  const changes: WorkspaceChange[] = [];
  for (let index = 0; index < count; index += 1) {
    const directory = directories[reader.u32()];
    if (directory === undefined) fail("unknown workspace change directory");
    const name = readName(reader, false);
    changes.push({ kind: "changed", directory, name });
  }
  reader.finish();
  return flags === 1 ? [{ kind: "rescan" }] : changes;
}

export function readAgentFileEntry(reader: AgentPayloadReader, path: string, child = false): WorkspaceFileEntry {
  const tag = reader.u8(); const linkTag = reader.u8(); const bytes = reader.u64();
  if (tag < 1 || tag > 3 || bytes > BigInt(Number.MAX_SAFE_INTEGER)) fail("invalid workspace entry kind/size");
  const version = Array.from(reader.take(24), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const name = readName(reader, !child && path === "/");
  if (!child && name !== path.split("/").at(-1)) fail("workspace entry does not match requested path");
  const resolved = reader.string();
  if (resolved !== "") {
    try { if (workspaceFilePath(resolved) !== resolved || !resolved.startsWith("/")) fail("invalid resolved link path"); }
    catch { fail("invalid resolved link path"); }
  }
  if (tag !== 3 && (linkTag !== 0 || resolved !== "") || tag === 3 && (linkTag < 1 || linkTag > 3)) fail("invalid workspace link entry");
  if (tag === 2 && bytes !== 0n || linkTag === 3 && resolved !== "" || tag === 3 && linkTag !== 3 && resolved === "") fail("invalid workspace entry invariants");
  return {
    kind: tag === 1 ? "file" : tag === 2 ? "directory" : "symlink",
    link: tag === 3 ? { kind: linkTag === 1 ? "file" : linkTag === 2 ? "directory" : "missing", path: resolved === "" ? null : resolved } : null,
    name, path: child ? `${path === "/" ? "" : path}/${name}` : path, size: Number(bytes), version,
  };
}

function readName(reader: AgentPayloadReader, root: boolean): string {
  const bytes = reader.take(reader.u32());
  if (bytes.byteLength > 255) fail("workspace name exceeds 255 bytes");
  let name: string;
  try { name = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("workspace name is not UTF-8"); }
  if ((!root && name === "") || name.includes("/") || name.includes("\\") || name.includes("\0") || name === "." || name === "..") fail("invalid workspace name");
  return name;
}

/** Native UTF-8 sorting agrees with code-point order, including astral names. */
export function compareFileNames(left: string, right: string): number {
  const a = Array.from(left); const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const delta = (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

function fileFailure(reason: string, size?: number): VMError {
  return new VMError("STORAGE_ERROR", `Workspace file operation failed: ${reason}`, { reason, ...(size === undefined ? {} : { size }) });
}

function fail(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }

/** Only validated native entries are encoded; versions remain raw bytes. */
export function writeAgentFileEntry(writer: AgentPayloadWriter, entry: WorkspaceFileEntry): void {
  writer.u8(entry.kind === "file" ? 1 : entry.kind === "directory" ? 2 : 3)
    .u8(entry.link === null ? 0 : entry.link.kind === "file" ? 1 : entry.link.kind === "directory" ? 2 : 3)
    .u64(BigInt(entry.size)).bytesRaw(Uint8Array.from(entry.version.match(/../gu) ?? [], hex => Number.parseInt(hex, 16)))
    .string(entry.name).string(entry.link?.path ?? "");
}
