import {readFile} from "node:fs/promises";
import {expect,it} from "vitest";
import {instantiateRuntime} from "./userspace-runtime.js";
import {engineModulePath} from "./engine-wasm.test-support.js";
import {callUserspaceU32 as call} from "./userspace-exports.js";
import {reconcileWorkspaceStreams} from "./userspace-workspace-reconcile.js";
import {type WorkspaceStreamInput} from "./workspace-stream.js";
import {decodeUserspaceFileRecord,encodeUserspaceFileRequest} from "../userspace-files.js";
import {readFileRecord} from "./userspace-files.js";
const SOURCE="123e4567-e89b-42d3-a456-426614174001",BASE="a".repeat(64);
function tree(length:number):WorkspaceStreamInput {
 const path=new TextEncoder().encode("/workspace/large"),header=new Uint8Array(length===0?12:24+path.length),view=new DataView(header.buffer);
 header.set([79,88,82,70]);view.setUint16(4,5,true);view.setUint32(8,length===0?0:1,true);
 if(length!==0){header[12]=1;view.setUint16(14,0o644,true);view.setUint32(16,path.length,true);view.setUint32(20,length,true);header.set(path,24);}
 return {bytes:header.length+length,source:()=>({frames:(async function*(){yield await Promise.resolve(header);const block=new Uint8Array(65536).fill(0xab);for(let left=length;left>0;left-=block.length)yield await Promise.resolve(block.subarray(0,Math.min(left,block.length)));})(),retire:()=>Promise.resolve()})};
}
it("cold-starts a workspace larger than the retired bulk-buffer limit using bounded native passes",async()=>{
 const module=await WebAssembly.compile(new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm"))).buffer);
 const runtime=await instantiateRuntime(module,"cold-stream-test",{kind:"disabled"});
 const stage=(bytes:Uint8Array)=>{expect(call(runtime.instance,"oxidevm_userspace_staging_resize",bytes.length)).toBe(0);new Uint8Array(runtime.memory.buffer,call(runtime.instance,"oxidevm_userspace_staging_ptr"),bytes.length).set(bytes);};
 try {
  stage(new Uint8Array());expect(call(runtime.instance,"oxidevm_userspace_mount_rootfs",0,1,384)).toBe(0);
  expect(call(runtime.instance,"oxidevm_userspace_configure_workspace_persistence")).toBe(0);
  const cold=runtime.checkpoints.beginCold(new Uint8Array(32)),length=129*1024*1024,body=tree(length),signal=new AbortController().signal;
  const result=await reconcileWorkspaceStreams(cold.beginReconcile(SOURCE),tree(0),async selection=>{
   await Promise.resolve();expect(selection.kind).toBe("retained");
   return {selection:{generation:1,workspaceBaseSha256:BASE,snapshot:body},retire:()=>Promise.resolve()};
  },{kind:"cold",retainedId:SOURCE,workspaceBaseSha256:BASE},signal,()=>Promise.resolve(undefined));
  expect(result.workspaceDetails.preserved).toBeUndefined();
  const exported=cold.exportWorkspace(),reader=exported.snapshot.source(signal);let received=0,lastByte:number|undefined;
  for await(const frame of reader.frames){expect(frame.length).toBeLessThanOrEqual(65536);received+=frame.length;lastByte=frame.at(-1);}
  await reader.retire();expect(received).toBe(exported.snapshot.bytes);expect(received).toBeGreaterThan(length);expect(lastByte).toBe(0xab);
  exported.complete(true);cold.complete();
  const request={operation:"stat",path:"/large"} as const,bytes=encodeUserspaceFileRequest(request);stage(bytes);
  expect(call(runtime.instance,"oxidevm_userspace_files",bytes.length)).toBe(0);
  expect(decodeUserspaceFileRecord(readFileRecord(runtime),request)).toMatchObject({entry:{kind:"file",size:length}});
 }finally{await runtime.jitRuntime.dispose();}
},60_000);

it("discards a failed startup import and remounts policy in the same instance before cold initialization",async()=>{
 const module=await WebAssembly.compile(new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm"))).buffer);
 const runtime=await instantiateRuntime(module,"cold-fallback-test",{kind:"disabled"});
 const stage=(bytes:Uint8Array)=>{expect(call(runtime.instance,"oxidevm_userspace_staging_resize",bytes.length)).toBe(0);new Uint8Array(runtime.memory.buffer,call(runtime.instance,"oxidevm_userspace_staging_ptr"),bytes.length).set(bytes);};
 const mount=()=>{stage(new Uint8Array());expect(call(runtime.instance,"oxidevm_userspace_mount_rootfs",0,1,64)).toBe(0);stage(new Uint8Array(32));expect(call(runtime.instance,"oxidevm_userspace_configure_root_persistence")).toBe(0);expect(call(runtime.instance,"oxidevm_userspace_configure_workspace_persistence")).toBe(0);};
 try {
  mount();const record=encodeUserspaceFileRequest({operation:"write",path:"/old",data:new Uint8Array([8])});stage(record);expect(call(runtime.instance,"oxidevm_userspace_files",record.length)).toBe(0);
  const chunks:{graph:Uint8Array[];payloads:Uint8Array[]}={graph:[],payloads:[]};
  const saved=runtime.checkpoints.beginCapture(new Uint8Array(32));await saved.transfer(async(area,_index,bytes)=>{chunks[area].push(bytes);await Promise.resolve();});saved.finish(true);
  const input=(parts:readonly Uint8Array[],truncated=false)=>({bytes:parts.reduce((n,part)=>n+part.length,0),frames:(async function*(){for(let i=0;i<parts.length;i++){const part=parts[i];if(part!==undefined)yield await Promise.resolve(truncated&&i===parts.length-1?part.subarray(0,part.length-1):part);}})(),retire:()=>Promise.resolve()});
  runtime.checkpoints.pauseClock();
  const candidate=runtime.checkpoints.beginRestore(new Uint8Array(32));
  await expect(candidate.read(input(chunks.graph),input(chunks.payloads,true))).rejects.toMatchObject({detail:{recoveryRequired:true}});
  const before=runtime.checkpoints.incarnation;candidate.discardStartup();expect(runtime.checkpoints.incarnation).toBeGreaterThan(before);
  mount();runtime.checkpoints.resumeClock();const stat={operation:"stat",path:"/old"} as const,bytes=encodeUserspaceFileRequest(stat);stage(bytes);expect(call(runtime.instance,"oxidevm_userspace_files",bytes.length)).toBe(0);
  expect(()=>decodeUserspaceFileRecord(readFileRecord(runtime),stat)).toThrow();
  const cold=runtime.checkpoints.beginCold(new Uint8Array(32));cold.abort();
 }finally{await runtime.jitRuntime.dispose();}
});
