import { expect, it, vi } from "vitest";
import { openUserspaceRootStore } from "./userspace-root-store.js";
import { NativeColdFiles } from "./native-cold-files.js";
import { NativeSnapshotFiles } from "./snapshot-userspace-files.js";
import { WorkspaceSelections } from "./workspace-selections.js";
import { WorkspaceStore } from "./workspace-store.js";
import { opfsWorkspaceStoreBackend } from "./workspace-backend.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { SnapshotObjects } from "./snapshot-objects.js";
import { workspaceBytesInput } from "./workspace-stream.js";
const BASE = "a".repeat(64), NEXT = "b".repeat(64);
const signal = () => new AbortController().signal;
const streams = (value: number) => ({ snapshot: workspaceBytesInput(new Uint8Array([value])), delta: workspaceBytesInput(new Uint8Array()) });

async function fixture() {
  const backend = opfsWorkspaceStoreBackend(new MemoryDirectory()), selections = new WorkspaceSelections(backend);
  const files = new NativeSnapshotFiles(selections, await SnapshotObjects.open(new MemoryDirectory()));
  await new WorkspaceStore(selections.backend).commitStreams(BASE, streams(1), signal());
  return { backend, selections, cold: new NativeColdFiles(selections, files) };
}
it("retains a foreign cold source and publishes its reconciled stream only at the selected commit", async () => {
  const f = await fixture(), sourceId = await f.cold.begin(undefined, NEXT, signal());
  expect(f.cold.busy).toBe(true);
  await f.cold.files(sourceId, NEXT).stageWorkspace(NEXT, streams(2), signal());
  f.cold.staged(sourceId, true);
  expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([1]));
  await f.cold.publish(sourceId, signal());
  const reopened = new WorkspaceSelections(f.backend);
  expect(await new WorkspaceStore(reopened.backend).read(NEXT)).toEqual(new Uint8Array([2]));
  await f.cold.complete(sourceId);
  expect(await reopened.isPreserved(sourceId)).toBe(true);
  const lease = await reopened.retainedWorkspace(sourceId, signal(), BASE);
  expect(lease?.snapshot?.bytes).toBe(1); await lease?.retire();
  expect(f.cold.busy).toBe(false);
});
it("refuses stale cold tokens and discards only the unpublished candidate on failure", async () => {
  const f = await fixture(), sourceId = await f.cold.begin(undefined, NEXT, signal());
  expect(() => f.cold.files(crypto.randomUUID(), NEXT)).toThrow();
  await expect(f.cold.publish(sourceId, signal())).rejects.toThrow();
  await f.cold.files(sourceId, NEXT).stageWorkspace(NEXT, streams(2), signal());
  await f.cold.abort();
  expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([1]));
  expect(await f.selections.has(sourceId)).toBe(false);
  expect(f.cold.busy).toBe(false);
});

it("reserves source reachability before asynchronous preparation and rejects another begin",async()=>{
 const f=await fixture(),pending=f.cold.begin(undefined,NEXT,signal());
 expect(f.cold.busy).toBe(true);expect(f.cold.retainedIds).toHaveLength(1);
 await expect(f.cold.begin(undefined,NEXT,signal())).rejects.toMatchObject({code:"PROTOCOL_ERROR"});
 const id=await pending;await f.selections.collect(new Set(f.cold.retainedIds));
 expect(await f.selections.has(id)).toBe(true);await f.cold.abort(id);
});
it("keeps a committed cold selection and preserved source after later native publication failure",async()=>{
 const f=await fixture(),id=await f.cold.begin(undefined,NEXT,signal());
 await f.cold.files(id,NEXT).stageWorkspace(NEXT,streams(9),signal());f.cold.staged(id,true);await f.cold.publish(id,signal());
 await f.cold.abort(id);await f.selections.collect(new Set());
 const reopened=new WorkspaceSelections(f.backend);
 expect(await new WorkspaceStore(reopened.backend).read(NEXT)).toEqual(new Uint8Array([9]));
 expect(await reopened.isPreserved(id)).toBe(true);
});
it("rejects a staged export whose base differs from the verified selected image",async()=>{
 const f=await fixture(),id=await f.cold.begin(undefined,NEXT,signal());
 expect(()=>f.cold.files(id,BASE)).toThrow();await f.cold.abort(id);
});

it("keeps saved generations through same-base cold publication, later writes and collection",async()=>{
 const f=await fixture(),saved=crypto.randomUUID();await f.selections.retain(saved);
 await new WorkspaceStore(f.selections.backend).commitStreams(BASE,streams(2),signal());
 const id=await f.cold.begin(undefined,BASE,signal());
 await f.cold.files(id,BASE).stageWorkspace(BASE,streams(2),signal());f.cold.staged(id,false);
 await f.cold.publish(id,signal());await f.cold.complete(id);await f.selections.collect(new Set([saved]));
 expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([2]));
 await f.selections.publish(saved,signal());
 expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([1]));
 await new WorkspaceStore(f.selections.backend).commitStreams(BASE,streams(2),signal());
 await f.selections.collect(new Set([saved]));await f.selections.validate(saved,signal());
});


it.each(["workspace", "root"] as const)("does not reclaim an in-flight %s flush while collecting retired cold generations",async scope=>{
 const f=await fixture(),root=scope==="root"?NEXT:undefined;
 if(root!==undefined)await (await openUserspaceRootStore(f.selections.backend,root)).commitStreams(root,streams(1),signal());
 const id=await f.cold.begin(root,BASE,signal());
 await f.cold.files(id,BASE).stageWorkspace(BASE,streams(1),signal());f.cold.staged(id,false);
 await f.cold.publish(id,signal());await f.cold.complete(id);
 const saved=crypto.randomUUID();await f.selections.retain(saved,root);
 const writing=Promise.withResolvers<undefined>(),resume=Promise.withResolvers<undefined>();
 const original=f.backend.write.bind(f.backend);
 vi.spyOn(f.backend,"write").mockImplementation(async(path,bytes)=>{
  await original(path,bytes);
  if(path.includes("chunks/")&&bytes.length===1&&bytes[0]===3){writing.resolve(undefined);await resume.promise;}
 });
 const writer=root===undefined?new WorkspaceStore(f.selections.backend):await openUserspaceRootStore(f.selections.backend,root);
 const commit=writer.commitStreams(root??BASE,streams(3),signal());
 const outcome=commit.then(()=>undefined,(error:unknown)=>error);
 await writing.promise;
 const reading=f.selections.retainedWorkspace(saved,signal(),BASE);
 const collection=f.selections.collect(new Set([saved]));
 // Let the independently admitted collector reach its existing staging scan.
 await Promise.race([collection, new Promise<void>(resolve=>setTimeout(resolve,25))]);
 resume.resolve(undefined);await collection;
 expect(await outcome).toBeUndefined();
 const lease=await reading;if(lease?.snapshot===undefined)throw new Error("Missing retained workspace");
 const producer=lease.snapshot.source(signal());
 const chunks:Uint8Array[]=[];for await(const bytes of producer.frames)chunks.push(bytes);
 expect(chunks).toEqual([new Uint8Array([1])]);
 await producer.retire();await lease.retire();
 const reader=root===undefined?new WorkspaceStore(f.selections.backend):await openUserspaceRootStore(f.selections.backend,root);
 expect(await reader.read(root??BASE)).toEqual(new Uint8Array([3]));
});

it("does not mistake another view's active legacy replacement for interrupted publication",async()=>{
 const f=await fixture(),writing=Promise.withResolvers<undefined>(),resume=Promise.withResolvers<undefined>();
 const original=f.backend.write.bind(f.backend);
 vi.spyOn(f.backend,"write").mockImplementation(async(path,bytes)=>{
  await original(path,bytes);if(path.startsWith("blobs/")&&bytes[0]===3){writing.resolve(undefined);await resume.promise;}
 });
 const replacement=new WorkspaceStore(f.selections.backend).replace(BASE,new Uint8Array([3]),true,signal());
 await writing.promise;
 const collection=new WorkspaceStore(f.selections.backend).collect().then(()=>undefined,(error:unknown)=>error);
 await Promise.race([collection,new Promise<void>(resolve=>setTimeout(resolve,25))]);resume.resolve(undefined);
 await replacement;expect(await collection).toBeUndefined();
 expect(await new WorkspaceStore(f.selections.backend).readDelta(BASE)).toEqual(new Uint8Array([3]));
});
