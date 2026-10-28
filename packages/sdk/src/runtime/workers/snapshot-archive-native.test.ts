import { afterEach, expect, it, vi } from "vitest";
import { ManagedBases } from "./managed-base.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { importBackup, inspectBackup } from "./snapshot-archive-jobs.js";
import { writeBackup } from "./snapshot-archive/writer.js";
import { SnapshotStore } from "./snapshot-store.js";
import type { UserspaceSnapshotManifest } from "./snapshot-manifest.js";
import { sha256Hex } from "./snapshot-content.js";
import { record } from "../decode.js";
import { signedCheckpointRootfsFixture } from "./rootfs-checkpoint.test-support.js";

afterEach(()=>vi.unstubAllGlobals());

async function fixture(schemaVersion:number) {
  const root = await signedCheckpointRootfsFixture("backup", 8);
  const source = record(JSON.parse(new TextDecoder().decode(root.bytes)) as unknown, "fixture");
  const bytes = new TextEncoder().encode(JSON.stringify({...source,schemaVersion}));
  const graph = Uint8Array.of(1), objects = new Map<string,Uint8Array<ArrayBuffer>>();
  const ref = async(content:Uint8Array<ArrayBuffer>)=>{const sha256=await sha256Hex(content);objects.set(sha256,content);return {sha256,bytes:content.length};};
  const snapshot:UserspaceSnapshotManifest = {
    schema:4,mode:"userspace",id:crypto.randomUUID(),createdAt:"2026-10-14T00:00:00.000Z",kind:"named",capturedAtUnixMs:Date.parse("2026-10-14T00:00:00.000Z"),parent:null,
    compatibility:{format:"OXUC",version:1,abiVersion:37,memoryBytes:256*1024**2},
    graph:{bytes:1,chunks:[{index:0,...await ref(graph)}]},payloads:{bytes:0,chunks:[]},
    rootfs:{origin:"managed",image:{id:"test-rootfs",version:"backup"},rootTreeSha256:String(source["rootTreeSha256"]),manifest:await ref(bytes)},
  };
  const chunks:Uint8Array<ArrayBuffer>[]=[];
  await writeBackup(snapshot,reference=>{
    const content=objects.get(reference.sha256);if(content===undefined)throw new Error("missing fixture object");return Promise.resolve(content);
  },chunk=>{chunks.push(chunk);return Promise.resolve();});
  const store=await SnapshotStore.open(new MemoryDirectory(),{
    images:new MemoryDirectory(),bases:new ManagedBases(),workspaceId:"backup-test",
    clock:{now:()=>Date.now(),startOfDay:time=>time-time%86400000},machine:{mode:"userspace",memoryMiB:256,vcpus:1},
  });
  // Isolate embedded rootfs support from the already-tested outer runtime/image checks.
  vi.spyOn(store,"compatibility").mockResolvedValue(true);
  return {store,file:new Blob(chunks)};
}

it("refuses unsupported embedded rootfs schemas during inspection and before import publication",async()=>{
  const f=await fixture(9),error={code:"SNAPSHOT_VERSION",detail:{reason:"backup-newer"}};
  await expect(inspectBackup(f.store,f.file,Date.now())).rejects.toMatchObject(error);
  await expect(importBackup(f.store,f.file,{enqueue:work=>work(),signal:new AbortController().signal,now:()=>Date.now()})).rejects.toMatchObject(error);
  expect(await f.store.list()).toEqual([]);
});

it("recognizes supported packed rootfs schemas and honors inspection cancellation",async()=>{
  const f=await fixture(8);
  await expect(inspectBackup(f.store,f.file,Date.now())).resolves.toMatchObject({mode:"userspace",compatible:true});
  await expect(inspectBackup(f.store,f.file,Date.now(),AbortSignal.abort())).rejects.toMatchObject({code:"ABORTED"});
});
