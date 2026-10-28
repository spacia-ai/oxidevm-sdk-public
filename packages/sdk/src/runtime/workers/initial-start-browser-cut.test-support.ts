import {InitialStart} from "./initial-start.js";
import {writeDiskHead} from "./managed-disk-head.js";
import {opfsWorkspaceStoreBackend} from "./workspace-backend.js";
import {WorkspaceSelections} from "./workspace-selections.js";
import {decodeShippedInstallIdentity} from "../protocol/shipped-source.js";
import {VMError} from "../errors.js";
const source=decodeShippedInstallIdentity({mode:"userspace",snapshotManifestSHA256:"ab".repeat(32),imageManifestSHA256:"cd".repeat(32)});
async function run(input:unknown):Promise<unknown> {
  if(typeof input!=="object"||input===null||!("name" in input)||typeof input.name!=="string"||!("phase" in input)||typeof input.phase!=="string")throw new Error("Invalid cut request");
  const root=await (await navigator.storage.getDirectory()).getDirectoryHandle(input.name,{create:true}),overlay=await root.getDirectoryHandle("overlay",{create:true}),backend=opfsWorkspaceStoreBackend(overlay);
  if(input.phase==="inspect")return (await InitialStart.open(root,backend)).state();
  const initial=await InitialStart.open(root,backend);
  if(input.phase==="conflict"){
    try{await initial.begin(decodeShippedInstallIdentity({...source,snapshotManifestSHA256:"ef".repeat(32)}));}
    catch(error){if(error instanceof VMError&&error.code==="INVALID_ARGUMENT")return {conflict:true};throw error;}
    throw new Error("A different source was accepted");
  }
  if(input.phase==="source-created"){
    await (await root.getDirectoryHandle("initial-start-v2",{create:true})).getFileHandle("source.json",{create:true});
    return {phase:input.phase};
  }
  await initial.begin(source);
  if(input.phase==="pending")return {phase:input.phase};
  if(input.phase==="retire-created"){
    await root.getFileHandle("initial-start-retired.json",{create:true});return {phase:input.phase};
  }
  if(input.phase==="retired"){await initial.retire();return {phase:input.phase};}
  if(input.phase==="disk-head"){
    await writeDiskHead(await root.getDirectoryHandle("managed-disks",{create:true}),{schema:2,generation:"fixture",previous:null,resume:null,initialStart:source});
    return {phase:input.phase};
  }
  if(input.phase==="native-head"){
    const selections=new WorkspaceSelections(backend);
    const id="123e4567-e89b-42d3-a456-426614174000";await selections.retain(id);
    await selections.publish(id,new AbortController().signal,{resume:null,image:"123e4567-e89b-42d3-a456-426614174001"},undefined,source);
    return {phase:input.phase};
  }
  if(input.phase==="retry"){await initial.begin(source);return initial.state();}
  throw new Error("Unknown cut phase");
}
self.addEventListener("message",(event:MessageEvent<unknown>)=>{void run(event.data).then(value=>self.postMessage({ok:true,value}),()=>self.postMessage({ok:false}));});
