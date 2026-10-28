import {VMError} from "./sdk.js";
import {SNAPSHOT_UPLOAD_SLICE_BYTES,type SnapshotTransportIdentity} from "../../snapshot-authoring-protocol.js";
export async function digest(bytes:Uint8Array<ArrayBuffer>):Promise<string> {return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),byte=>byte.toString(16).padStart(2,"0")).join("");}
export function createTransport(transportIdentity:SnapshotTransportIdentity) {
  let sequence=0,queue=Promise.resolve();
  const post=(data:Readonly<Record<string,unknown>>,bytes?:Uint8Array<ArrayBuffer>,signal?:AbortSignal):Promise<void>=>{
    const operation=queue.then(async()=>{
      const ordinal=++sequence;
      const response=bytes===undefined?await fetch("/transport",{method:"POST",...(signal===undefined?{}:{signal}),headers:{"Content-Type":"application/json"},body:JSON.stringify({...transportIdentity,sequence:ordinal,...data})})
        :await fetch("/upload",{method:"POST",...(signal===undefined?{}:{signal}),headers:{"Authorization":`Bearer ${transportIdentity.token}`,"X-OxideVM-Sequence":String(ordinal),"X-OxideVM-Offset":String(data["offset"])},body:bytes});
      if(!response.ok)throw new VMError("STORAGE_ERROR","Snapshot transport did not acknowledge its operation");
    });queue=operation;void operation.catch(()=>{});return operation;
  };
  return {post,settle:()=>queue,upload:async(file:File,signal:AbortSignal)=>{
    await post({type:"upload-begin",bytes:file.size},undefined,signal);
    for(let offset=0;offset<file.size;offset+=SNAPSHOT_UPLOAD_SLICE_BYTES){const bytes=new Uint8Array(await file.slice(offset,offset+SNAPSHOT_UPLOAD_SLICE_BYTES).arrayBuffer());await post({offset},bytes,signal);}
    await post({type:"upload-end"},undefined,signal);
  }};
}
