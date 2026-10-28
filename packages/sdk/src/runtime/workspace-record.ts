import type { AgentProtocolVersion } from "./agent-protocol.js";
import { exactKeys, integer, protocolError, record, string } from "./decode.js";
import { VMError } from "./errors.js";

export interface FileOwnership { readonly uid: number; readonly gid: number }
export interface FileTimes { readonly accessNs: string; readonly modificationNs: string }

function timestamp(value: unknown): string {
  const input = string(value, "workspace timestamp");
  if (!/^(?:0|-?[1-9][0-9]{0,18})$/u.test(input)) throw protocolError("Invalid workspace timestamp");
  const number = BigInt(input);
  if (number < -(1n << 63n) || number >= 1n << 63n) throw protocolError("Workspace timestamp is outside i64");
  return input;
}

export function decodeFileTimes(value: unknown): FileTimes {
  const times = record(value, "workspace timestamps"); exactKeys(times, ["accessNs", "modificationNs"]);
  return { accessNs: timestamp(times["accessNs"]), modificationNs: timestamp(times["modificationNs"]) };
}

/** OXRF v8 / OXWD v3 carry signed nanoseconds. Flag 2 distinguishes
 * recorded epoch zero from legacy metadata with no timestamp claim. */
export function readFileTimes(view: DataView, offset: number, timed: boolean): FileTimes | undefined {
  if (!timed) return undefined;
  const flags = view.getUint8(offset + 1);
  const access = view.getBigInt64(offset + 20, true); const modification = view.getBigInt64(offset + 28, true);
  if ((flags & ~3) !== 0 || (flags & 2) === 0 && (access !== 0n || modification !== 0n)) throw protocolError("Invalid workspace timestamp record");
  return (flags & 2) === 0 ? undefined : { accessNs: access.toString(), modificationNs: modification.toString() };
}

export function writeFileTimes(view: DataView, offset: number, times: FileTimes | undefined): void {
  view.setUint8(offset + 1, view.getUint8(offset + 1) | (times === undefined ? 0 : 2));
  view.setBigInt64(offset + 20, times === undefined ? 0n : BigInt(timestamp(times.accessNs)), true);
  view.setBigInt64(offset + 28, times === undefined ? 0n : BigInt(timestamp(times.modificationNs)), true);
}

export function sameFileTimes(left: FileTimes | undefined, right: FileTimes | undefined): boolean {
  return left?.accessNs === right?.accessNs && left?.modificationNs === right?.modificationNs;
}

/** Linux capture chooses the first inode path in byte order. Locale and UTF-16
 * sorting can move a hardlink ahead of its source during a mode switch. */
export function compareWorkspacePaths(left: Uint8Array, right: Uint8Array): number {
  for (const [index, byte] of left.entries()) {
    const other = right[index];
    if (other === undefined) return 1;
    if (byte !== other) return byte - other;
  }
  return left.length - right.length;
}

export function requireWorkspaceDialect(bytes: Uint8Array, dialect: AgentProtocolVersion | undefined, kind: "OXRF" | "OXWD", capabilities = 0): void {
  if (bytes.length < 6 || new TextDecoder().decode(bytes.subarray(0, 4)) !== kind) return;
  const version = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(4, true);
  if (version >= (kind === "OXRF" ? 10 : 5) && (dialect !== 7 || (capabilities & 8192) === 0)) throw new VMError("FEATURE_NOT_AVAILABLE",
    "Workspace whiteouts require updated guest integration", { reason: "image-update-required", format: kind, version });
  if (version === (kind === "OXRF" ? 8 : 3) && (dialect !== 7 || (capabilities & 1024) === 0)) throw new VMError("FEATURE_NOT_AVAILABLE", "Workspace timestamps require updated guest integration", { reason: "image-update-required", format: kind, version });
  if (dialect === 3 && version >= (kind === "OXRF" ? 6 : 2)) throw new VMError("FEATURE_NOT_AVAILABLE",
    "This workspace ownership format requires guest protocol v4", { format: kind, version, guestProtocol: 3, requiredGuestProtocol: 4 });
  if ((version === (kind === "OXRF" ? 7 : 4) || version >= (kind === "OXRF" ? 9 : 4)) && (dialect !== 7 || (capabilities & 4096) === 0)) throw new VMError("FEATURE_NOT_AVAILABLE",
    "Workspace inode metadata requires the workspaceMetadata guest capability", { format: kind, version, guestProtocol: dialect, requiredGuestProtocol: 7 });
}

/** OXRF v6 / OXWD v2 extend the 12-byte entry header by UID/GID. Flag 1
 * carries ownership; flag 0 retains a legacy entry without inventing an owner.
 * Linux's -1 no-change sentinel is never an admissible recorded identity. */
export function readFileOwnership(view: DataView, offset: number, extended: boolean, timed = false): FileOwnership | undefined {
  const raw = view.getUint8(offset + 1);
  if (timed && (raw & ~3) !== 0) throw protocolError("Invalid workspace entry flags");
  const flags = timed ? raw & 1 : raw;
  if (!extended) {
    if (flags !== 0) throw protocolError("Workspace entry is malformed: invalid legacy flags");
    return undefined;
  }
  const uid = view.getUint32(offset + 12, true);
  const gid = view.getUint32(offset + 16, true);
  if (flags === 0 && uid === 0 && gid === 0) return undefined;
  if (flags !== 1 || uid === 0xffff_ffff || gid === 0xffff_ffff) throw protocolError("Invalid workspace ownership record");
  return { uid, gid };
}

export function writeFileOwnership(view: DataView, offset: number, owner: FileOwnership | undefined): void {
  view.setUint8(offset + 1, owner === undefined ? 0 : 1);
  view.setUint32(offset + 12, owner === undefined ? 0 : integer(owner.uid, "workspace UID", 0, 0xffff_fffe), true);
  view.setUint32(offset + 16, owner === undefined ? 0 : integer(owner.gid, "workspace GID", 0, 0xffff_fffe), true);
}

export function sameFileOwnership(left: FileOwnership | undefined, right: FileOwnership | undefined): boolean {
  return left?.uid === right?.uid && left?.gid === right?.gid;
}

/** OXRF9 / OXWD4 store three signed times and byte-ordered xattrs. Keep the
 * validated bytes intact: decoding names as text would change Linux identity. */
export function validateWorkspaceMetadata(bytes: Uint8Array): void {
  if (bytes.length < 40 || bytes.length > 64 * 1024 * 1024) throw protocolError("Invalid workspace inode metadata length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const offset of [8, 20, 32]) {
    if (view.getUint32(offset, true) >= 1_000_000_000) throw protocolError("Invalid workspace timestamp nanoseconds");
  }
  const count = view.getUint32(36, true);
  if (count > (bytes.length - 40) / 8) throw protocolError("Invalid workspace xattr count");
  let offset = 40, names = 0;
  let previous: Uint8Array | undefined;
  for (let index = 0; index < count; index += 1) {
    if (offset + 8 > bytes.length) throw protocolError("Truncated workspace xattr header");
    const nameLength = view.getUint16(offset, true), valueLength = view.getUint32(offset + 4, true);
    const nameStart = offset + 8, valueStart = nameStart + nameLength, end = valueStart + valueLength;
    if (view.getUint16(offset + 2, true) !== 0 || nameLength === 0 || nameLength > 255
      || valueLength > 65_536 || end > bytes.length) throw protocolError("Invalid workspace xattr bounds");
    const name = bytes.subarray(nameStart, valueStart);
    names += nameLength + 1;
    if (name.includes(0) || names > 65_536 || previous !== undefined && compareWorkspacePaths(previous, name) >= 0) {
      throw protocolError("Invalid workspace xattr name or ordering");
    }
    previous = name;
    offset = end;
  }
  if (offset !== bytes.length) throw protocolError("Trailing workspace inode metadata");
}

export function sameWorkspaceMetadata(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  return left === undefined || right === undefined ? left === right : left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** The common claims of rich inode records and legacy timestamp-only records. */
export function workspaceMetadataTimes(bytes: Uint8Array): FileTimes {
  validateWorkspaceMetadata(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ns = (offset: number) => (view.getBigInt64(offset, true) * 1_000_000_000n + BigInt(view.getUint32(offset + 8, true))).toString();
  return { accessNs: ns(0), modificationNs: ns(12) };
}

/** Updating legacy time claims preserves the richer record's ctime and xattrs. */
export function withWorkspaceMetadataTimes(bytes: Uint8Array, times: FileTimes): Uint8Array<ArrayBuffer> {
  validateWorkspaceMetadata(bytes);
  const checked = decodeFileTimes(times), output = bytes.slice(), view = new DataView(output.buffer);
  for (const [index, time] of [checked.accessNs, checked.modificationNs].entries()) {
    const ns = BigInt(time), remainder = (ns % 1_000_000_000n + 1_000_000_000n) % 1_000_000_000n;
    view.setBigInt64(index * 12, (ns - remainder) / 1_000_000_000n, true);
    view.setUint32(index * 12 + 8, Number(remainder), true);
  }
  return output;
}
