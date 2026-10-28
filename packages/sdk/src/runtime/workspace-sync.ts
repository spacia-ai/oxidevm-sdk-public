import { compareWorkspacePaths, sameWorkspaceMetadata, sameFileOwnership } from "./workspace-record.js";
import type { AgentWorkspaceManifestEntry } from "./agent-protocol.js";
import { VMError } from "./errors.js";
import { encodeFilesystemRecord, type RootfsMetadataEntry } from "./userspace-rootfs-record.js";

const HEADER_BYTES = 12;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const encoder = new TextEncoder();

export async function captureSystemWorkspace(
  manifest: readonly AgentWorkspaceManifestEntry[],
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const extended = manifest.some(entry => entry.ownership !== undefined);
  const rich = manifest.some(entry => entry.metadata !== undefined || entry.kind === "fifo" || entry.kind === "whiteout");
  const headerBytes = rich ? 24 : extended ? 20 : 12;
  const entries: RootfsMetadataEntry[] = [];
  const hardlinks = new Map<string, string>();
  let length = HEADER_BYTES;
  const ordered = manifest.map(node => ({ node, path: encoder.encode(node.path) }))
    .sort((left, right) => compareWorkspacePaths(left.path, right.path));
  for (const { node, path } of ordered) {
    let tag: number;
    let payload: Uint8Array<ArrayBuffer>;
    const identity = `${node.device.toString()}:${node.inode.toString()}`;
    const target = node.kind === "directory" ? undefined : hardlinks.get(identity);
    if (target !== undefined) {
      tag = 4; payload = encoder.encode(target);
    } else if (node.kind === "directory" || node.kind === "fifo" || node.kind === "whiteout") {
      tag = node.kind === "whiteout" ? 7 : node.kind === "fifo" ? 6 : 0; payload = new Uint8Array();
    } else if (node.kind === "symlink") {
      tag = 2; payload = encoder.encode(node.target);
    } else {
      if (node.size < 0n || node.size > BigInt(MAX_SNAPSHOT_BYTES - length)) throw new VMError("QUOTA_EXCEEDED", "workspace snapshot exceeds 128 MiB");
      tag = 1;
      const bytes = await readFile(node.path);
      if (BigInt(bytes.byteLength) !== node.size) {
        throw new VMError("STORAGE_ERROR", `workspace file changed while synchronizing: ${node.path}`);
      }
      payload = bytes.slice();
    }
    if (node.kind !== "directory" && target === undefined) hardlinks.set(identity, node.path);
    length = checkedLength(length, headerBytes + path.byteLength + payload.byteLength + (node.metadata?.length ?? 0));
    entries.push({ tag, mode: node.mode, path, pathText: node.path, payload,
      ...(node.ownership === undefined ? {} : { ownership: node.ownership }), ...(node.metadata === undefined ? {} : { metadata: node.metadata }) });
  }
  return encodeFilesystemRecord(entries, "snapshot");
}

export function sameWorkspaceManifest(
  left: readonly AgentWorkspaceManifestEntry[],
  right: readonly AgentWorkspaceManifestEntry[],
): boolean {
  if (left.length !== right.length) return false;
  const orderedLeft = [...left].sort((a, b) => compare(a.path, b.path));
  const orderedRight = [...right].sort((a, b) => compare(a.path, b.path));
  return orderedLeft.every((entry, index) => {
    const other = orderedRight[index];
    return other !== undefined
      && entry.kind === other.kind
      && entry.mode === other.mode
      && sameFileOwnership(entry.ownership, other.ownership)
      && sameWorkspaceMetadata(entry.metadata, other.metadata)
      && entry.size === other.size
      && entry.mtimeNs === other.mtimeNs
      && entry.ctimeNs === other.ctimeNs
      && entry.device === other.device
      && entry.inode === other.inode
      && entry.path === other.path
      && (entry.kind !== "symlink" || other.kind === "symlink" && entry.target === other.target);
  });
}

function checkedLength(current: number, added: number): number {
  const next = current + added;
  if (!Number.isSafeInteger(next) || next > MAX_SNAPSHOT_BYTES) {
    throw new VMError("QUOTA_EXCEEDED", "workspace snapshot exceeds 128 MiB");
  }
  return next;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
