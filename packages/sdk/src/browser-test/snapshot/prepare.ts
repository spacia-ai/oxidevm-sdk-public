import {VMError,type VM} from "./sdk.js";
import {exactKeys,record,string,integer} from "../../runtime/decode.js";
import type {SnapshotData,SnapshotPreparationContext} from "../../snapshot-authoring.js";
import type {SnapshotAuthoringRun} from "./context.js";
import {snapshotData} from "../../snapshot-authoring-receipt.js";
import {digest} from "./transport.js";
type AuthorFunction=(context:unknown)=>unknown;
function isAuthorFunction(value:unknown):value is AuthorFunction {return typeof value==="function";}
export function authorFunction(value:unknown):AuthorFunction {
  if(!isAuthorFunction(value))throw new VMError("INVALID_ARGUMENT","Author module requires a default function");
  return value;
}
export function authorModule(value:unknown):(context:unknown)=>unknown {return authorFunction(record(value,"author module")["default"]);}
export function moduleURL(value:unknown):string {
  const path=string(value,"author module URL");
  if(!path.startsWith("/author/")||path.includes("..")||path.includes("\\")||path.includes("?")||path.includes("#"))throw new VMError("PROTOCOL_ERROR","Author module URL is invalid");
  return new URL(path,location.href).href;
}
async function boundedFile(url:string,maximum:number,signal:AbortSignal):Promise<Uint8Array<ArrayBuffer>> {
  const response=await fetch(url,{signal});
  if(!response.ok||response.body===null)throw new VMError("STORAGE_ERROR","Author input is unavailable");
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{
    for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>maximum)throw new VMError("PROTOCOL_ERROR","Author input exceeds its byte bound");parts.push(next.value);}
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}

export async function prepareWorkload(config:Readonly<Record<string,unknown>>,vm:VM,context:SnapshotPreparationContext,run:SnapshotAuthoringRun):Promise<SnapshotData|undefined> {
  run.onPhase("stage");
  if(!Array.isArray(config["files"])||config["files"].length>4096)throw new VMError("PROTOCOL_ERROR","Staged files are invalid");
  for(const value of Array.from<unknown>(config["files"])){
    const file=record(value,"staged file");exactKeys(file,["url","to","bytes","sha256"]);
    const url=string(file["url"],"staged URL"),to=string(file["to"],"staged destination");
    if(!url.startsWith("/inputs/")||!to.startsWith("/workspace/"))throw new VMError("PROTOCOL_ERROR","Staged file escaped its declared scope");
    const bytes=await boundedFile(url,integer(file["bytes"],"staged bytes",0,16*1024**2),context.signal);
    if(bytes.length!==file["bytes"]||await digest(bytes)!==file["sha256"])throw new VMError("PROTOCOL_ERROR","Staged file identity differs");
    const path=to.slice("/workspace".length);await vm.workspace.writeFile(path,bytes,context.signal);
    const stored=await vm.workspace.readFile(path,context.signal);
    if(await digest(stored.slice())!==file["sha256"])throw new VMError("STORAGE_ERROR","Guest staged file differs");
  }
  run.onPhase("prepare");
  const workload=record(config["workload"],"preparation workload");exactKeys(workload,["kind","url"]);
  let data:SnapshotData|undefined;
  if(workload["kind"]==="shell"){
    const bytes=await boundedFile(moduleURL(workload["url"]),16*1024**2,context.signal);
    await context.run({command:"/bin/sh",args:["-s"],stdin:bytes});
  }else{
    if(workload["kind"]!=="module")throw new VMError("PROTOCOL_ERROR","Preparation workload kind is invalid");
    const module:unknown=await import(moduleURL(workload["url"])),result:unknown=await authorModule(module)(context);
    data=result===undefined?undefined:snapshotData(result);
  }
  return data;
}
