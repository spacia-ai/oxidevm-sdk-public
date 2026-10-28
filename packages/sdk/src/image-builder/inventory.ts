import type { UserspaceRootfsBlob, UserspaceRootfsEntry } from "../runtime/userspace-rootfs.js";
import { VMError } from "../runtime/errors.js";
import { hash } from "./files.js";
import type { InventoryFile } from "./evidence.js";

/** Package inventories cover every file name, including hardlinks and link targets. */
export function treeInventory(tree: { readonly entries: readonly UserspaceRootfsEntry[]; readonly blobs: readonly UserspaceRootfsBlob[] }): readonly InventoryFile[] {
  const blobs = new Map(tree.blobs.map(blob => [blob.sha256, blob]));
  const files = new Map<string, InventoryFile>();
  for (const entry of tree.entries) {
    if (entry.type === "directory") continue;
    if (entry.type === "symlink") {
      files.set(entry.path, { path: entry.path, bytes: Buffer.byteLength(entry.target), sha256: hash(entry.target) });
    } else if (entry.type === "hardlink") {
      const target = files.get(entry.target);
      if (target === undefined) throw new VMError("PROTOCOL_ERROR", "inventory hardlink has no preceding file");
      files.set(entry.path, { ...target, path: entry.path });
    } else {
      const blob = blobs.get(entry.blob);
      if (blob === undefined) throw new VMError("PROTOCOL_ERROR", "inventory file has no payload");
      files.set(entry.path, { path: entry.path, bytes: blob.bytes, sha256: blob.sha256 });
    }
  }
  return [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function payloadIdentity(value: Readonly<Record<string, unknown>>): string {
  // Packs include provenance bytes; the reproduction identity names the logical guest payload.
  const payload = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "provenance" && key !== "packs"));
  return hash(JSON.stringify(payload));
}
