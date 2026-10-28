import {afterEach,expect,it,vi} from "vitest";
import {openCachedRootfsFile} from "./rootfs-file-read.js";
import {MemoryDirectory} from "./opfs-double.test-support.js";
import {sha256Hex} from "./snapshot-content.js";
import {write} from "./rootfs-store-backend.js";
afterEach(()=>vi.restoreAllMocks());
it("authenticates cached immutable bodies and replays only64KiB frames without full-file copies",async()=>{
 const root=new MemoryDirectory(),backend={kind:"opfs",root} as const,bytes=new Uint8Array(2*65536+7).fill(9),digest=await sha256Hex(bytes),release=vi.fn();
 await write(backend,"blobs",digest,bytes);
 const reads=vi.spyOn(Blob.prototype,"arrayBuffer");
 const signal=new AbortController().signal,lease=await openCachedRootfsFile(backend,{sha256:digest,bytes:bytes.length,url:new URL("https://source.test/file")},signal,release);
 expect(release).not.toHaveBeenCalled();if(lease.snapshot===undefined)throw new Error("missing file stream");
 const source=lease.snapshot.source(signal),frames:Uint8Array[]=[];
 for await(const frame of source.frames) {expect(frame.length).toBeLessThanOrEqual(65536);frames.push(frame);}
 await source.retire();expect(frames.map(frame=>frame.length)).toEqual([65536,65536,7]);
 expect(frames.every(frame=>frame.every(byte=>byte===9))).toBe(true);
 await lease.retire();await lease.retire();expect(release).toHaveBeenCalledOnce();
 const contexts:readonly unknown[]=reads.mock.contexts;for(const value of contexts){if(!(value instanceof Blob))throw new Error("unexpected reader");expect(value.size).toBeLessThanOrEqual(65536);}
});
it("rejects damaged/missing/cancelled files before lending any frames and retires pins",async()=>{
 const root=new MemoryDirectory(),backend={kind:"opfs",root} as const,digest="a".repeat(64),blob={sha256:digest,bytes:1,url:new URL("https://source.test/file")},signal=new AbortController().signal;
 const missing=vi.fn();await expect(openCachedRootfsFile(backend,blob,signal,missing)).rejects.toMatchObject({code:"STORAGE_ERROR"});expect(missing).toHaveBeenCalledOnce();
 await write(backend,"blobs",digest,new Uint8Array([1]));const damaged=vi.fn();await expect(openCachedRootfsFile(backend,blob,signal,damaged)).rejects.toMatchObject({code:"STORAGE_ERROR"});expect(damaged).toHaveBeenCalledOnce();
 const cancellation=new AbortController();cancellation.abort();const retired=vi.fn();await expect(openCachedRootfsFile(backend,blob,cancellation.signal,retired)).rejects.toMatchObject({code:"ABORTED"});expect(retired).toHaveBeenCalledOnce();
});
