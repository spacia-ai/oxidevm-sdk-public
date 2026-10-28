import { sha256 } from "@noble/hashes/sha2.js";
import { VMError } from "./errors.js";
import { ROOTFS_PACK_BYTES, type RootfsBlobIdentity, type RootfsPackIndex } from "./userspace-rootfs-packs.js";

/** One bounded packing algorithm shared by the Node builder and browser cache accelerator. */
export async function packRootfsContents(
  references: readonly RootfsBlobIdentity[],
  read: (blob: RootfsBlobIdentity) => AsyncIterable<Uint8Array>,
  emit: (chunk: RootfsBlobIdentity, bytes: Uint8Array<ArrayBuffer>) => Promise<void>,
  signal?: AbortSignal,
): Promise<RootfsPackIndex> {
  const active = () => { if (signal?.aborted === true) throw new VMError("ABORTED", "Rootfs packing cancelled"); };
  const chunks = new Map<string, RootfsBlobIdentity>(), identities: string[] = [];
  const blobs: {sha256:string;extents:{ordinal:number;offset:number;bytes:number;fileOffset:number}[]}[] = [];
  let buffer = new Uint8Array(ROOTFS_PACK_BYTES), used = 0;
  const flush = async () => {
    if (used === 0) return;
    active(); const bytes = used === buffer.length ? buffer : buffer.slice(0, used), sha = sha256(bytes);
    const hash = hex(sha), chunk = { sha256: hash, bytes: bytes.length };
    if (!chunks.has(hash)) { await emit(chunk, bytes); chunks.set(hash, chunk); }
    identities.push(hash); buffer = new Uint8Array(ROOTFS_PACK_BYTES); used = 0;
  };
  const distinct = [...new Map(references.map(blob => [blob.sha256, blob])).values()].sort((a,b) => a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0);
  for (const blob of distinct) {
    active(); const hash = sha256.create(), extents: typeof blobs[number]["extents"] = [];
    let received = 0;
    for await (const bytes of read(blob)) {
      active(); if (received + bytes.length > blob.bytes) throw invalid();
      hash.update(bytes);
      for (let offset = 0; offset < bytes.length;) {
        const count = Math.min(buffer.length - used, bytes.length - offset);
        extents.push({ordinal:identities.length,offset:used,bytes:count,fileOffset:received});
        buffer.set(bytes.subarray(offset, offset + count), used);
        used += count; received += count; offset += count;
        if (used === buffer.length) await flush();
      }
    }
    if (received !== blob.bytes || hex(hash.digest()) !== blob.sha256) throw invalid();
    blobs.push({sha256:blob.sha256,extents});
  }
  await flush(); active();
  return {version:1,chunks:[...chunks.values()],blobs:blobs.map(blob => ({sha256:blob.sha256,extents:coalesce(blob.extents.map(({ordinal,...extent}) => {
    const chunk = identities[ordinal]; if (chunk === undefined) throw invalid(); return {chunk,...extent};
  }))}))};
}
function coalesce(extents: RootfsPackIndex["blobs"][number]["extents"]): RootfsPackIndex["blobs"][number]["extents"] {
  const result: {chunk:string;offset:number;bytes:number;fileOffset:number}[] = [];
  for (const extent of extents) {
    const previous = result.at(-1);
    if (previous?.chunk === extent.chunk && previous.offset + previous.bytes === extent.offset && previous.fileOffset + previous.bytes === extent.fileOffset) previous.bytes += extent.bytes;
    else result.push({...extent});
  }
  return result;
}
function hex(bytes: Uint8Array): string { return [...bytes].map(byte => byte.toString(16).padStart(2,"0")).join(""); }
function invalid(): VMError { return new VMError("PROTOCOL_ERROR", "Rootfs packing source differs from its immutable identity"); }
