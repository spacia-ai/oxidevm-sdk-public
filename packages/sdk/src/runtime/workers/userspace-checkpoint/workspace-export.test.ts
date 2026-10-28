import { expect, it } from "vitest";
import { UserspaceCandidateWorkspace } from "./workspace-export.js";
function fixture() {
  const descriptor = new Uint8Array(24); descriptor.set([79,88,87,80,1,0,0,0]);
  const view = new DataView(descriptor.buffer); view.setBigUint64(8,7n,true);view.setBigUint64(16,12n,true);
  let frame=descriptor, next=0;
  const calls: (string|number|bigint)[][]=[];
  const raw={ok(name:string,...args:readonly(number|bigint)[]){calls.push([name,...args]);if(name==="workspace_export_next")frame=next++===0?new Uint8Array(12):new Uint8Array();},frame(){return frame.slice();}};
  return {raw,calls};
}
it("retiring candidate bytes leaves durability unacknowledged until storage selection commits",async()=>{
  const f=fixture(), exported=new UserspaceCandidateWorkspace(f.raw,4n);
  expect(()=>exported.complete(true)).toThrow();
  const source=exported.snapshot.source(new AbortController().signal);
  const frames=[];for await(const frame of source.frames)frames.push([...frame]);
  await source.retire();
  expect(frames).toEqual([Array<number>(12).fill(0)]);
  expect(f.calls).not.toContainEqual(["workspace_publication_complete",4n,7n,1]);
  exported.complete(true);
  expect(f.calls.at(-1)).toEqual(["workspace_publication_complete",4n,7n,1]);
  expect(()=>exported.snapshot.source(new AbortController().signal)).toThrow();
});
it("cancelled candidate export retires without claiming committed bytes",()=>{
  const f=fixture(), exported=new UserspaceCandidateWorkspace(f.raw,4n);
  exported.complete(false);
  expect(f.calls.slice(-2)).toEqual([["workspace_export_retire",4n,7n],["workspace_publication_complete",4n,7n,0]]);
  exported.complete(false);
});
