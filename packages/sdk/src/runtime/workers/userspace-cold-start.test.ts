import {expect,it,vi} from "vitest";
import {startNativeCold, type NativeColdRuntime} from "./userspace-cold-start.js";
import type {SnapshotStorageClient} from "./snapshot-channel.js";
import {workspaceBytesInput} from "./workspace-stream.js";
vi.mock("./userspace-snapshot-workspace.js",()=>({stageCandidateWorkspace:vi.fn(async()=>{})}));
function fixture(failAt?:string) {
 const calls:string[]=[];
 const exported={snapshot:workspaceBytesInput(new Uint8Array()),delta:workspaceBytesInput(new Uint8Array()),complete:(ok:boolean)=>{calls.push(`ack:${String(ok)}`);}};
 const candidate={beginReconcile:()=>{throw new Error("mock reconciliation owns this");},exportWorkspace:()=>exported,complete:()=>{calls.push("native");if(failAt==="native")throw new Error("native failure");},abort:()=>{calls.push("abort");}};
 const runtime:NativeColdRuntime={workspaceBaseSha256:"a".repeat(64),beginCold:()=>Promise.resolve(candidate),reconcileCold:()=>Promise.resolve({workspace:{workspace:"in-sync",unresolved:[]},workspaceDetails:{state:"in-sync",conflicts:[],omittedConflicts:0}}),coldPublished:()=>{calls.push("visible");},coldFailed:()=>{calls.push("fenced");return Promise.resolve();}};
 const storage:Pick<SnapshotStorageClient,"request">={request:async request=>{await Promise.resolve();calls.push(request.type);if(request.type===failAt)throw new Error("storage failure");return undefined;}};
 return {calls,runtime,storage};
}
it("acknowledges the exported workspace only after atomic durable publication",async()=>{
 const f=fixture();await startNativeCold(f.runtime,f.storage,"source",new AbortController().signal);
 expect(f.calls).toEqual(["publish-native-cold","ack:true","native","visible","complete-native-cold"]);
});
it("rejects publication failure and fences the partially reconciled cold runtime",async()=>{
 const f=fixture("publish-native-cold");await expect(startNativeCold(f.runtime,f.storage,"source",new AbortController().signal)).rejects.toThrow("storage failure");
 expect(f.calls).toEqual(["publish-native-cold","ack:false","abort","abort","fenced"]);
});
it("never sends a false durable acknowledgement after selected files committed",async()=>{
 const f=fixture("native");await expect(startNativeCold(f.runtime,f.storage,"source",new AbortController().signal)).rejects.toThrow("native failure");
 expect(f.calls).toEqual(["publish-native-cold","ack:true","native","abort","abort","fenced"]);
});
it("reports published cold startup when temporary pin retirement fails",async()=>{
 const f=fixture("complete-native-cold");
 await expect(startNativeCold(f.runtime,f.storage,"source",new AbortController().signal)).resolves.toMatchObject({state:"in-sync"});
 expect(f.calls).not.toContain("abort");expect(f.calls).not.toContain("fenced");
});
