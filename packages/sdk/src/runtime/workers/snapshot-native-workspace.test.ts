import {expect,it} from "vitest";
import {NativeSnapshotFiles} from "./snapshot-userspace-files.js";
import {WorkspaceSelections} from "./workspace-selections.js";
import {WorkspaceStore} from "./workspace-store.js";
import {openUserspaceRootStore} from "./userspace-root-store.js";
import {opfsWorkspaceStoreBackend} from "./workspace-backend.js";
import {MemoryDirectory} from "./opfs-double.test-support.js";
import {SnapshotObjects} from "./snapshot-objects.js";
import {workspaceBytesInput} from "./workspace-stream.js";
const BASE="a".repeat(64),ROOT="b".repeat(64),SAVED="11111111-2222-4333-8444-555555555555",BEFORE="22222222-2222-4333-8444-555555555555";
const signal=()=>new AbortController().signal;
async function fixture(){
 const backend=opfsWorkspaceStoreBackend(new MemoryDirectory()),selections=new WorkspaceSelections(backend),objects=await SnapshotObjects.open(new MemoryDirectory()),files=new NativeSnapshotFiles(selections,objects);
 const write=async(value:number)=>{await new WorkspaceStore(selections.backend).commitStreams(BASE,{snapshot:workspaceBytesInput(new Uint8Array([value])),delta:workspaceBytesInput(new Uint8Array())},signal());await(await openUserspaceRootStore(selections.backend,ROOT)).commitStreams(ROOT,{snapshot:workspaceBytesInput(new Uint8Array([value+1])),delta:workspaceBytesInput(new Uint8Array())},signal());};
 const read=async(owner:WorkspaceSelections)=>[await new WorkspaceStore(owner.backend).read(BASE),await(await openUserspaceRootStore(owner.backend,ROOT)).read(ROOT)];
 await write(1);const durable=await files.capture(SAVED,BASE,ROOT,signal());await write(3);await selections.retain(BEFORE,ROOT);
 return {backend,selections,files,durable,read};
}
it("atomically persists reconciled workspace before native publication and keeps explicit restore unchanged",async()=>{
 const f=await fixture(),candidate=await f.files.prepare(SAVED,ROOT,f.durable,signal());
 await candidate.stageWorkspace(BASE,{snapshot:workspaceBytesInput(new Uint8Array([9])),delta:workspaceBytesInput(new Uint8Array())},signal());
 expect(await f.read(f.selections)).toEqual([new Uint8Array([3]),new Uint8Array([4])]);
 await candidate.commit(signal(),{resume:SAVED,replaced:BEFORE});
 // Reopen immediately, with no idle guest flush after the publication.
 const restarted=new WorkspaceSelections(f.backend);expect(await f.read(restarted)).toEqual([new Uint8Array([9]),new Uint8Array([2])]);
 const explicit=await new NativeSnapshotFiles(restarted,await SnapshotObjects.open(new MemoryDirectory())).prepare(SAVED,ROOT,f.durable,signal());
 await explicit.commit(signal(),{resume:SAVED});expect(await f.read(restarted)).toEqual([new Uint8Array([1]),new Uint8Array([2])]);
});
it("keeps reported preserved UUIDs reachable after another selection and collection",async()=>{
 const f=await fixture(),candidate=await f.files.prepare(SAVED,ROOT,f.durable,signal());await candidate.commit(signal(),{resume:SAVED},BEFORE);
 await f.selections.selectBoot("fresh-image",ROOT,"33333333-2222-4333-8444-555555555555",signal());await f.selections.release(BEFORE);await f.selections.collect(new Set([SAVED]));
 const reopened=new WorkspaceSelections(f.backend);expect(await reopened.isPreserved(BEFORE)).toBe(true);
 const kept=await reopened.retainedWorkspace(BEFORE,signal(),BASE);if(kept?.snapshot===undefined)throw new Error("preserved source lost");
 const source=kept.snapshot.source(signal()),parts:Uint8Array[]=[];for await(const part of source.frames)parts.push(part);await source.retire();await kept.retire();expect(parts).toEqual([new Uint8Array([3])]);
});
