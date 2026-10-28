import {afterEach,expect,it,vi} from "vitest";
import {RootfsStore} from "./rootfs-store.js";
import {RootfsNetworkClient,serveRootfsNetwork} from "./rootfs-network-channel.js";
import {signedCheckpointRootfsFixture,ROOTFS_CHECKPOINT_URL} from "./rootfs-checkpoint.test-support.js";
import {MemoryDirectory} from "./opfs-double.test-support.js";
import {SnapshotStore} from "./snapshot-store.js";
import {ManagedBases} from "./managed-base.js";
import {WorkspaceSelections} from "./workspace-selections.js";
import {opfsWorkspaceStoreBackend} from "./workspace-backend.js";
import {decodeSnapshotManifest} from "./snapshot-manifest.js";
import {sha256Hex} from "./snapshot-content.js";
import {writeBackup} from "./snapshot-archive/writer.js";
import {encodeBackupManifest} from "./snapshot-archive/manifest.js";
import {inspectBackup,importBackup,type ArchiveRun} from "./snapshot-archive-jobs.js";
const ports:MessagePort[]=[];
afterEach(()=>{vi.unstubAllGlobals();for(const port of ports.splice(0))port.close();});
const NOW=Date.parse("2026-10-13T12:00:00.000Z");
const run=():ArchiveRun=>({enqueue:turn=>turn(),signal:new AbortController().signal,now:()=>NOW});
async function destination() {
 const fixture=await signedCheckpointRootfsFixture("2026.10.13",6);
 const channel=new MessageChannel();ports.push(channel.port1,channel.port2);serveRootfsNetwork(channel.port2);
 const roots=RootfsStore.opfs(new MemoryDirectory(),new RootfsNetworkClient(channel.port1));
 const image=await roots.prepare(ROOTFS_CHECKPOINT_URL,fixture.trusted);
 const store=await SnapshotStore.open(new MemoryDirectory(),{images:new MemoryDirectory(),bases:new ManagedBases(),workspaceId:"fresh",clock:{now:()=>NOW,startOfDay:t=>t-t%86_400_000},machine:{mode:"userspace",memoryMiB:256,vcpus:1},image:()=>image,native:{rootfs:roots,selections:new WorkspaceSelections(opfsWorkspaceStoreBackend(new MemoryDirectory())),cachedImages:()=>roots.cachedCheckpointIdentities()}});
 const graph=new Uint8Array([1]),graphHash=await sha256Hex(graph),sourceHash=await sha256Hex(fixture.bytes);
 const manifest=decodeSnapshotManifest({schema:4,mode:"userspace",id:"123e4567-e89b-42d3-a456-426614174001",createdAt:"2026-10-13T10:00:00.000Z",kind:"named",capturedAtUnixMs:Date.parse("2026-10-13T10:00:00.000Z"),parent:null,compatibility:{format:"OXUC",version:1,abiVersion:37,memoryBytes:256*1024**2},graph:{bytes:1,chunks:[{index:0,bytes:1,sha256:graphHash}]},payloads:{bytes:0,chunks:[]},rootfs:{origin:"managed",image:{id:image.id,version:image.version},rootTreeSha256:image.rootTreeSha256,manifest:{sha256:sourceHash,bytes:fixture.bytes.length}}});
 const objects=new Map([[graphHash,graph],[sourceHash,fixture.bytes]]),chunks:Uint8Array<ArrayBuffer>[]=[];
 await writeBackup(manifest,ref=>{const bytes=objects.get(ref.sha256);if(bytes===undefined)throw new Error("missing fixture object");return Promise.resolve(bytes);},bytes=>{chunks.push(bytes.slice());return Promise.resolve();});
 return {store,roots,manifest,file:new Blob(chunks)};
}
it("admits a backup of the verified active native root without an offline checkpoint pin",async()=>{
 const f=await destination();
 expect(await f.roots.cachedCheckpointIdentities()).toEqual(new Set());
 expect(await f.store.compatibility(f.manifest)).toBe(true);
 expect((await inspectBackup(f.store,f.file,NOW)).compatible).toBe(true);
 expect((await importBackup(f.store,f.file,run())).resumable).toBe(true);
 expect(await f.roots.cachedCheckpointIdentities()).toEqual(new Set());
 if(f.manifest.schema!==4)throw new Error("wrong runtime");
 expect(await f.store.compatibility({...f.manifest,rootfs:{...f.manifest.rootfs,rootTreeSha256:"a".repeat(64)}})).toBe("base-missing");
});
it("rejects inspecting or importing a native backup truncated before its required rootfs manifest",async()=>{
 const f=await destination(),truncated=f.file.slice(0,512+Math.ceil(encodeBackupManifest(f.manifest).length/512)*512);
 await expect(inspectBackup(f.store,truncated,NOW)).rejects.toMatchObject({detail:{reason:"backup-damaged"}});
 await expect(importBackup(f.store,truncated,run())).rejects.toMatchObject({detail:{reason:"backup-damaged"}});
 expect(await f.store.list()).toEqual([]);
});
