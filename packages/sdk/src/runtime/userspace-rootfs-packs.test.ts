import { expect, it } from "vitest";
import { packRootfsContents } from "./userspace-rootfs-packing.js";
import { decodeRootfsPackIndex, ROOTFS_PACK_BYTES } from "./userspace-rootfs-packs.js";
import { sha256Hex } from "./workers/snapshot-content.js";

it("packs complete files deterministically and splits a large file across bounded chunks", async () => {
  const content = [Uint8Array.of(1,2,3), new Uint8Array(ROOTFS_PACK_BYTES + 17).fill(9), new Uint8Array()];
  const blobs = await Promise.all(content.map(async bytes => ({sha256:await sha256Hex(bytes),bytes:bytes.length})));
  const byHash = new Map(blobs.map((blob,index) => [blob.sha256,content[index] ?? new Uint8Array()]));
  const emitted = new Map<string, Uint8Array>();
  const read = async function*(blob: {readonly sha256:string}) { yield await Promise.resolve(byHash.get(blob.sha256) ?? new Uint8Array()); };
  const first = await packRootfsContents(blobs, read, (chunk,bytes) => { emitted.set(chunk.sha256,bytes.slice()); return Promise.resolve(); });
  expect(first.chunks.length).toBe(2);
  expect(first.chunks.every(chunk => chunk.bytes <= ROOTFS_PACK_BYTES)).toBe(true);
  expect(decodeRootfsPackIndex(first, blobs)).toEqual(first);
  for (const blob of first.blobs) {
    const bytes = new Uint8Array(blobs.find(ref => ref.sha256 === blob.sha256)?.bytes ?? 0);
    for (const extent of blob.extents) bytes.set(emitted.get(extent.chunk)?.subarray(extent.offset,extent.offset+extent.bytes) ?? new Uint8Array(),extent.fileOffset);
    expect(await sha256Hex(bytes)).toBe(blob.sha256);
  }
  expect(await packRootfsContents([...blobs].reverse(),read,()=>Promise.resolve())).toEqual(first);
});

it("rejects malformed, duplicate and incomplete extent graphs", async () => {
  const bytes=Uint8Array.of(1,2,3),blob={sha256:await sha256Hex(bytes),bytes:3};
  const index=await packRootfsContents([blob],async function*(){yield await Promise.resolve(bytes);},()=>Promise.resolve());
  const packed=index.blobs[0],extent=packed?.extents[0];if(packed===undefined||extent===undefined)throw new Error("missing fixture");
  for(const broken of [
    {...index,version:2}, {...index,extra:true}, {...index,chunks:[...index.chunks,...index.chunks]},
    {...index,blobs:[]}, {...index,blobs:[packed,packed]},
    {...index,blobs:[{...packed,extents:[{...extent,fileOffset:1}]}]},
    {...index,blobs:[{...packed,extents:[{...extent,bytes:4}]}]},
    {...index,blobs:[{...packed,extents:[{...extent,chunk:"f".repeat(64)}]}]},
  ])expect(()=>decodeRootfsPackIndex(broken,[blob])).toThrow();
  await expect(packRootfsContents([blob],async function*(){yield await Promise.resolve(Uint8Array.of(9,9,9));},()=>Promise.resolve())).rejects.toMatchObject({code:"PROTOCOL_ERROR"});
  await expect(packRootfsContents([blob],async function*(){yield await Promise.resolve(bytes);},()=>Promise.resolve(),AbortSignal.abort())).rejects.toMatchObject({code:"ABORTED"});
});
