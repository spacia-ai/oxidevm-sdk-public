import { protocolError } from "./decode.js";
import { readFileOwnership, readFileTimes, sameFileOwnership, sameFileTimes, sameWorkspaceMetadata, validateWorkspaceMetadata, workspaceMetadataTimes, writeFileOwnership, writeFileTimes, type FileOwnership, type FileTimes } from "./workspace-record.js";

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;

export interface RootfsMetadataEntry {
  readonly ownership?: FileOwnership;
  readonly metadata?: Uint8Array<ArrayBuffer>;
  readonly times?: FileTimes;
  readonly tag: number;
  readonly mode: number;
  readonly path: Uint8Array<ArrayBuffer>;
  readonly pathText: string;
  readonly payload: Uint8Array<ArrayBuffer>;
}

/** The same record grammar serves immutable mount metadata and workspace files;
 * the latter additionally restrict paths and allow delta tombstones. */
export function decodeFilesystemRecord(record: Uint8Array, kind: "rootfs" | "snapshot" | "delta"): RootfsMetadataEntry[] {
  const delta = kind === "delta", workspace = kind !== "rootfs";
  const label = delta ? "workspace delta" : workspace ? "workspace snapshot" : "Userspace rootfs metadata";
  if (record.length < 12 || record.length > MAX_BYTES
    || new TextDecoder().decode(record.subarray(0, 4)) !== (delta ? "OXWD" : "OXRF")) throw protocolError(`${label} header is malformed`);
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const version = view.getUint16(4, true), count = view.getUint32(8, true);
  const versions = delta ? [1, 2, 3, 4, 5] : [4, 5, 6, 7, 8, 9, 10];
  if (!versions.includes(version) || view.getUint16(6, true) !== 0) throw protocolError(`${label} version is unsupported`);
  if (count > (workspace ? 1_000_000 : 65_536)) throw protocolError(`${label} has too many entries`);
  const rich = version >= (delta ? 4 : 9) || workspace && !delta && version === 7;
  const timed = version === (delta ? 3 : 8);
  const combined = version >= (delta ? 4 : 9);
  const owned = rich || timed || version === (delta ? 2 : 6) || !workspace && version === 7;
  const headerBytes = timed ? 36 : rich ? 24 : owned ? 20 : 12;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths = new Set<string>(), entries: RootfsMetadataEntry[] = [];
  let offset = 12;
  try {
    for (let index = 0; index < count; index += 1) {
      if (offset + headerBytes > record.length) throw protocolError(`${label} is truncated`);
      const tag = view.getUint8(offset), mode = view.getUint16(offset + 2, true);
      const ownership = readFileOwnership(view, offset, owned, timed || combined);
      let times = readFileTimes(view, offset, timed);
      const pathLength = view.getUint32(offset + 4, true), payloadLength = view.getUint32(offset + 8, true);
      const metadataLength = rich ? view.getUint32(offset + 20, true) : 0;
      const pathStart = offset + headerBytes, payloadStart = pathStart + pathLength;
      const metadataStart = payloadStart + payloadLength, end = metadataStart + metadataLength;
      if (pathLength === 0 || pathLength > MAX_PATH_BYTES || end > record.length) throw protocolError(`${label} entry is truncated or malformed`);
      const pathText = decoder.decode(record.subarray(pathStart, payloadStart));
      validatePath(pathText, workspace, tag === 0);
      if (paths.has(pathText)) throw protocolError(`${label} path is duplicated`);
      const payload = record.slice(payloadStart, metadataStart);
      validatePayload(tag, mode, payload, kind, version);
      const legacyTimes = combined && (view.getUint8(offset + 1) & 2) !== 0;
      if (legacyTimes) {
        if (metadataLength !== 16) throw protocolError("Invalid workspace timestamp metadata length");
        times = { accessNs: view.getBigInt64(metadataStart, true).toString(), modificationNs: view.getBigInt64(metadataStart + 8, true).toString() };
      }
      const metadata = metadataLength === 0 || legacyTimes ? undefined : record.slice(metadataStart, end);
      if (tag === 5 && (metadataLength !== 0 || times !== undefined)) throw protocolError("workspace tombstone has inode metadata");
      if (metadata !== undefined) {
        if (tag === 5) throw protocolError("workspace tombstone has inode metadata");
        validateWorkspaceMetadata(metadata);
      }
      paths.add(pathText);
      entries.push({ tag, mode, path: record.slice(pathStart, payloadStart), pathText, payload,
        ...(ownership === undefined ? {} : { ownership }), ...(times === undefined ? {} : { times }), ...(metadata === undefined ? {} : { metadata }) });
      offset = end;
    }
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw protocolError(`${label} is malformed`);
    throw error;
  }
  if (offset !== record.length) throw protocolError(`${label} has trailing bytes`);
  validateHardlinks(entries);
  return entries;
}

export function encodeFilesystemRecord(entries: readonly RootfsMetadataEntry[], kind: "rootfs" | "snapshot" | "delta"): Uint8Array<ArrayBuffer> {
  const delta = kind === "delta";
  if (entries.length > (kind === "rootfs" ? 65_536 : 1_000_000)) throw protocolError(`${kind} metadata has too many entries`);
  const whiteouts = entries.some(entry => entry.tag === 7);
  const rich = whiteouts || entries.some(entry => entry.metadata !== undefined || entry.tag === 6
    || kind === "rootfs" && entry.tag === 4 && !new TextDecoder().decode(entry.payload).startsWith("/workspace/"));
  const timed = !rich && entries.some(entry => entry.times !== undefined);
  const owned = rich || timed || entries.some(entry => entry.ownership !== undefined);
  const version = delta ? whiteouts ? 5 : rich ? 4 : timed ? 3 : owned ? 2 : 1 : whiteouts ? 10 : rich ? 9 : timed ? 8 : owned ? 6 : kind === "snapshot" || entries.some(entry => entry.tag === 4) ? 5 : 4;
  const headerBytes = timed ? 36 : rich ? 24 : owned ? 20 : 12;
  let length = 12;
  const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.path.length === 0 || entry.path.length > MAX_PATH_BYTES
      || new TextDecoder("utf-8", { fatal: true }).decode(entry.path) !== entry.pathText || paths.has(entry.pathText)) throw protocolError("Invalid filesystem record path");
    validatePath(entry.pathText, kind !== "rootfs", entry.tag === 0);
    validatePayload(entry.tag, entry.mode, entry.payload, kind, version);
    if (entry.metadata !== undefined) {
      if (entry.times !== undefined) throw protocolError("Conflicting workspace metadata authorities");
      if (entry.tag === 5) throw protocolError("workspace tombstone has inode metadata");
      validateWorkspaceMetadata(entry.metadata);
    }
    paths.add(entry.pathText);
    if (entry.tag === 5 && entry.times !== undefined) throw protocolError("workspace tombstone has timestamps");
    length += headerBytes + entry.path.length + entry.payload.length + (rich ? entry.metadata?.length ?? (entry.times === undefined ? 0 : 16) : 0);
    if (length > MAX_BYTES) throw protocolError("filesystem record exceeds Wasm staging");
  }
  validateHardlinks(entries);
  const output = new Uint8Array(length), view = new DataView(output.buffer);
  output.set(new TextEncoder().encode(delta ? "OXWD" : "OXRF"));
  view.setUint16(4, version, true);
  view.setUint32(8, entries.length, true);
  let offset = 12;
  for (const entry of entries) {
    view.setUint8(offset, entry.tag); view.setUint16(offset + 2, entry.mode, true);
    view.setUint32(offset + 4, entry.path.length, true); view.setUint32(offset + 8, entry.payload.length, true);
    if (owned) writeFileOwnership(view, offset, entry.ownership);
    if (timed) writeFileTimes(view, offset, entry.times);
    if (rich) {
      view.setUint32(offset + 20, entry.metadata?.length ?? (entry.times === undefined ? 0 : 16), true);
      if (entry.times !== undefined) view.setUint8(offset + 1, view.getUint8(offset + 1) | 2);
    }
    offset += headerBytes;
    output.set(entry.path, offset); offset += entry.path.length;
    output.set(entry.payload, offset); offset += entry.payload.length;
    if (entry.metadata !== undefined) { output.set(entry.metadata, offset); offset += entry.metadata.length; }
    if (rich && entry.times !== undefined) {
      // Reuse the signed-time validator without inventing an xattr authority.
      const timeHeader = new DataView(new ArrayBuffer(36)); writeFileTimes(timeHeader, 0, entry.times);
      output.set(new Uint8Array(timeHeader.buffer, 20, 16), offset); offset += 16;
    }
  }
  return output;
}

function validatePath(path: string, workspace: boolean, allowWorkspaceRoot: boolean): void {
  if (!path.startsWith("/") || path.includes("\0") || path !== "/" && path.slice(1).split("/").some(part => part === "" || part === "." || part === "..")) {
    throw protocolError(workspace ? "workspace path escapes root" : "filesystem record path is malformed");
  }
  if (workspace && !(allowWorkspaceRoot && path === "/workspace") && !path.startsWith("/workspace/")) {
    throw protocolError("workspace path is outside /workspace");
  }
}

function validateHardlinks(entries: readonly RootfsMetadataEntry[]): void {
  const byPath = new Map(entries.map(entry => [entry.pathText, entry]));
  for (const entry of entries) {
    if (entry.tag !== 4) continue;
    const source = byPath.get(new TextDecoder("utf-8", { fatal: true }).decode(entry.payload));
    if (source !== undefined && ([0, 5].includes(source.tag) || entry.mode !== source.mode
      || entry.ownership !== undefined && source.ownership !== undefined && !sameFileOwnership(entry.ownership, source.ownership)
      || !matchingTimeClaims(entry, source)
      || entry.metadata !== undefined && source.metadata !== undefined && !sameWorkspaceMetadata(entry.metadata, source.metadata))) {
      throw protocolError("conflicting recorded hardlink metadata");
    }
  }
}

function matchingTimeClaims(left: RootfsMetadataEntry, right: RootfsMetadataEntry): boolean {
  const times = (entry: RootfsMetadataEntry) => entry.times ?? (entry.metadata === undefined ? undefined : workspaceMetadataTimes(entry.metadata));
  const a = times(left), b = times(right);
  return a === undefined || b === undefined || sameFileTimes(a, b);
}

function validatePayload(tag: number, mode: number, payload: Uint8Array, kind: "rootfs" | "snapshot" | "delta", version: number): void {
  const delta = kind === "delta", rich = version >= (delta ? 4 : 9) || kind === "snapshot" && version === 7;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777 || !Number.isInteger(tag)
    || ![0, 1, 2, 3, 4, ...(delta ? [5] : []), ...(rich ? [6] : []), ...(version >= (delta ? 5 : 10) ? [7] : [])].includes(tag)
    || [0, 5, 6, 7].includes(tag) && payload.length !== 0 || tag === 3 && payload.length !== 40
    || tag === 4 && !delta && version < 5 || [2, 4].includes(tag) && (payload.length === 0 || payload.length > MAX_PATH_BYTES || payload.includes(0))) {
    throw protocolError("filesystem record payload is malformed");
  }
  if (tag === 4) validatePath(new TextDecoder("utf-8", { fatal: true }).decode(payload), kind !== "rootfs", false);
}
