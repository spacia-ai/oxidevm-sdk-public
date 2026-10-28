import { describe, expect, it } from "vitest";
import { UserspaceReconcile } from "./reconcile.js";

function fixture() {
  let frame = new Uint8Array();
  const calls: string[] = [];
  let conflictReason=0;
  const raw = {
    stage(bytes: Uint8Array) { calls.push(`stage:${bytes.length}`); },
    u64() { return 7n; },
    ok(name: string) { calls.push(name);if(name==="reconcile_conflict"){const path=new TextEncoder().encode("/workspace/a");frame=new Uint8Array(4+path.length);frame.set(path,4);new DataView(frame.buffer).setUint32(0,conflictReason,true);}else if(name==="reconcile_unresolved"){frame=new TextEncoder().encode("/workspace/a");} },
    frame() { return frame.slice(); },
  };
  return { raw, calls,setConflictReason:(reason:number)=>{conflictReason=reason;}, setFrame: (bytes: Uint8Array) => { frame = bytes.slice(); } };
}
describe("native workspace reconciliation bridge", () => {
  it("refuses malformed native requirements before apply and leaves publication to recovery", () => {
    const { raw, calls, setFrame } = fixture();
    const transfer = new UserspaceReconcile(raw, 3n, "point-1");
    setFrame(new Uint8Array(7));
    expect(() => transfer.plan()).toThrow();
    expect(() => transfer.apply()).toThrow();
    expect(calls).not.toContain("reconcile_apply");
  });
  it("streams bodies in bounded frames and projects the native conflict result", () => {
    const { raw, calls, setFrame } = fixture();
    const transfer = new UserspaceReconcile(raw, 3n, "point-1");
    transfer.source(0, 12); transfer.feed(new Uint8Array(12)); transfer.sourceComplete();
    const plan = new Uint8Array(8); new DataView(plan.buffer).setUint32(0, 1 << 3, true); setFrame(plan);
    expect(transfer.plan()).toEqual({ sources: [3], hosts: 0 });
    transfer.apply(); transfer.replay(3); transfer.replayFeed(new Uint8Array(65536)); transfer.replayComplete();
    const result = new Uint8Array(20); const view = new DataView(result.buffer); view.setUint32(0, 1, true); view.setUint32(4, 1, true);view.setUint32(12,1,true); setFrame(result);
    expect(transfer.finish()).toEqual({ workspace:{workspace:"conflict-preserved",unresolved:[]},workspaceDetails:{state:"conflict-preserved",conflicts:[{path:"/workspace/a",reason:"changed-in-both"}],omittedConflicts:0} });
    expect(calls.at(-1)).toBe("reconcile_retire");
    expect(() => transfer.feed(new Uint8Array(1))).toThrow();
  });
});

it("projects native unavailable-content reasons and the retained generation identity",()=>{
  const {raw,setFrame,setConflictReason}=fixture(),preserved="123e4567-e89b-42d3-a456-426614174001";
  const transfer=new UserspaceReconcile(raw,3n,"point-1",preserved);
  setFrame(new Uint8Array(8));transfer.plan();transfer.apply();
  const bytes=new Uint8Array(20),view=new DataView(bytes.buffer);view.setUint32(8,1,true);view.setUint32(12,1,true);view.setUint32(16,2,true);setFrame(bytes);setConflictReason(2);
  expect(transfer.finish()).toMatchObject({workspace:{workspace:"conflict-preserved",unresolved:["/workspace/a"]},workspaceDetails:{preserved:{id:preserved,reason:"content-unavailable"},conflicts:[{path:"/workspace/a",reason:"content-unavailable"}]}});
});
