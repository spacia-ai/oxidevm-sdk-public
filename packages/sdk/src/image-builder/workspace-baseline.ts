import { VMError } from "../runtime/errors.js";
import type { UserspaceRootfsBlob, UserspaceRootfsEntry } from "../runtime/userspace-rootfs.js";

/** OXWB v3 is decoded by the native agent. Directory sizes do not participate in its identity. */
export function encodeWorkspaceBaseline(entries: readonly UserspaceRootfsEntry[], blobs: readonly UserspaceRootfsBlob[], workspace: string, epoch: number): Uint8Array<ArrayBuffer> {
  const nanoseconds = Number.isSafeInteger(epoch) && epoch >= 0 ? BigInt(epoch) * 1_000_000_000n : -1n;
  if (nanoseconds < 0n || nanoseconds > 0x7fff_ffff_ffff_ffffn) throw new VMError("INVALID_ARGUMENT", "workspace baseline epoch exceeds the native timestamp bound");
  const files = new Map(entries.map(entry => [entry.path, entry]));
  const sizes = new Map(blobs.map(blob => [blob.sha256, blob.bytes]));
  const selected = entries.filter(entry => entry.path === workspace || entry.path.startsWith(`${workspace}/`));
  const root = files.get(workspace);
  if (root?.type !== "directory") throw new VMError("INVALID_ARGUMENT", "workspace baseline requires a guest directory");
  const records = selected.map(entry => {
    const path = Buffer.from(entry.path === workspace ? "" : entry.path.slice(workspace.length + 1));
    const target = entry.type === "symlink" ? Buffer.from(entry.target) : Buffer.alloc(0);
    const file = entry.type === "hardlink" ? files.get(entry.target) : entry;
    if (entry.type === "hardlink" && file?.type !== "file") throw new VMError("PROTOCOL_ERROR", "workspace baseline hardlink target is absent");
    const blob = file?.type === "file" ? file.blob : undefined;
    const size = blob === undefined ? target.byteLength : sizes.get(blob);
    if (size === undefined) throw new VMError("PROTOCOL_ERROR", "workspace baseline file size is absent");
    const bytes = Buffer.alloc(60 + path.byteLength + target.byteLength);
    bytes[0] = entry.type === "directory" ? 0 : entry.type === "symlink" ? 2 : 1;
    bytes.writeUInt16LE(entry.mode, 2);
    bytes.writeUInt32LE(path.byteLength, 4);
    bytes.writeUInt32LE(target.byteLength, 8);
    bytes.writeBigUInt64LE(BigInt(size), 12);
    bytes.writeUInt32LE(entry.ownership?.uid ?? 0, 20);
    bytes.writeUInt32LE(entry.ownership?.gid ?? 0, 24);
    if (blob !== undefined) bytes.set(Buffer.from(blob, "hex"), 28);
    bytes.set(path, 60);
    bytes.set(target, 60 + path.byteLength);
    return { path, bytes };
  }).sort((a, b) => Buffer.compare(a.path, b.path));
  const header = Buffer.alloc(20);
  header.write("OXWB"); header.writeUInt16LE(3, 4);
  header.writeUInt32LE(records.length, 8); header.writeBigInt64LE(nanoseconds, 12);
  const result = Buffer.concat([header, ...records.map(record => record.bytes)]);
  if (result.byteLength > 128 * 1024 ** 2) throw new VMError("INVALID_ARGUMENT", "workspace baseline exceeds the native byte bound");
  return new Uint8Array(result);
}
