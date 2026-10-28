import {randomUUID} from "node:crypto";
import {lstat,mkdir,rename,rm,open,readdir} from "node:fs/promises";
import {basename,dirname,join} from "node:path";
import {abortIfRequested} from "./tools.js";
import {readSourceFile} from "./files.js";
import {withOutputLock} from "./output-lock.js";
import {exactKeys,record,string} from "../runtime/decode.js";
import {VMError} from "../runtime/errors.js";
interface Publication {readonly version:1;readonly temporary:string;readonly backup:string;readonly hadPrevious:boolean;readonly phase:"prepared"|"committed"}
export type PublicationBoundary="intent-durable"|"previous-renamed"|"output-renamed"|"commit-durable";
async function present(path:string):Promise<boolean> {
  try{const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw new VMError("INVALID_ARGUMENT","Bundle output must be a regular directory");return true;}
  catch(error){if(typeof error==="object"&&error!==null&&"code" in error&&error.code==="ENOENT")return false;throw error;}
}
async function syncDirectory(directory:string):Promise<void> {const file=await open(directory,"r");try{await file.sync();}finally{await file.close();}}
async function syncTree(root:string,depth=0):Promise<void> {
  if(depth>64)throw new VMError("STORAGE_ERROR","Publication tree exceeds its depth bound");
  for(const entry of await readdir(root,{withFileTypes:true})){
    const path=join(root,entry.name);
    if(entry.isDirectory())await syncTree(path,depth+1);
    else if(entry.isFile()){const file=await open(path,"r");try{await file.sync();}finally{await file.close();}}
    else throw new VMError("STORAGE_ERROR","Publication contains a nonregular artifact");
  }
  await syncDirectory(root);
}
async function writeIntent(out:string,publication:Publication):Promise<void> {
  const path=`${out}.publication.json`,temporary=`${path}.writing`;
  const file=await open(temporary,"w",0o600);
  try{await file.writeFile(JSON.stringify(publication));await file.sync();}finally{await file.close();}
  await rename(temporary,path);await syncDirectory(dirname(out));
}
export async function recoverBundlePublication(out:string):Promise<"committed"|"rolled-back"|"none"> {
  let bytes:Uint8Array<ArrayBuffer>;
  try{bytes=(await readSourceFile(`${out}.publication.json`,4096)).bytes;}
  catch(error){if(await lstat(`${out}.publication.json`).catch(()=>undefined)===undefined)return "none";throw error;}
  const parsed:unknown=JSON.parse(new TextDecoder().decode(bytes)),value=record(parsed,"bundle publication");
  exactKeys(value,["version","temporary","backup","hadPrevious","phase"]);
  const temporary=string(value["temporary"],"staging directory"),backup=string(value["backup"],"previous directory"),prefix=basename(out);
  const valid=(name:string,role:string)=>name.startsWith(`${prefix}.${role}-`)&&/^[a-f0-9-]{36}$/u.test(name.slice(prefix.length+role.length+2));
  if(value["version"]!==1||typeof value["hadPrevious"]!=="boolean"||value["phase"]!=="prepared"&&value["phase"]!=="committed"
    ||!valid(temporary,"building")||!valid(backup,"previous"))throw new VMError("STORAGE_ERROR","Publication intent is malformed",{reason:"snapshot-publication-incomplete"});
  const staged=join(dirname(out),temporary),previous=join(dirname(out),backup);
  await present(staged);await present(previous);await present(out);
  if(value["phase"]==="prepared"){
    if(await present(previous)){await rm(out,{recursive:true,force:true});await rename(previous,out);}
    else if(!value["hadPrevious"])await rm(out,{recursive:true,force:true});
    else if(!await present(out))throw new VMError("STORAGE_ERROR","Previous publication is missing",{reason:"snapshot-publication-incomplete"});
  }else if(!await present(out))throw new VMError("STORAGE_ERROR","Committed publication is missing",{reason:"snapshot-publication-incomplete"});
  await rm(staged,{recursive:true,force:true});await rm(previous,{recursive:true,force:true});await syncDirectory(dirname(out));
  await rm(`${out}.publication.json`,{force:true});await rm(`${out}.publication.json.writing`,{force:true});await syncDirectory(dirname(out));
  return value["phase"]==="committed"?"committed":"rolled-back";
}
export async function atomicBundle<T>(out:string,build:(staging:string)=>Promise<T>,signal?:AbortSignal,onBoundary?:(boundary:PublicationBoundary)=>Promise<void>):Promise<T> {
  await mkdir(dirname(out),{recursive:true});
  return withOutputLock(out,async()=>{
    await recoverBundlePublication(out);
    const id=randomUUID(),temporary=`${out}.building-${id}`,backup=`${out}.previous-${id}`;
    await mkdir(temporary);let committed=false,outcome:{result:T}|undefined;
    try{
      const result=await build(temporary);outcome={result};abortIfRequested(signal);await syncTree(temporary);abortIfRequested(signal);
      const hadPrevious=await present(out),publication:Publication={version:1,temporary:basename(temporary),backup:basename(backup),hadPrevious,phase:"prepared"};
      await writeIntent(out,publication);
      await onBoundary?.("intent-durable");
      if(hadPrevious)await rename(out,backup);
      await syncDirectory(dirname(out));await onBoundary?.("previous-renamed");await rename(temporary,out);await syncDirectory(dirname(out));await onBoundary?.("output-renamed");
      await writeIntent(out,{...publication,phase:"committed"});committed=true;
      await onBoundary?.("commit-durable").catch(()=>{});
      await recoverBundlePublication(out).catch(()=>{});return result;
    }catch(error){
      if(!committed&&await recoverBundlePublication(out)==="committed"&&outcome!==undefined){committed=true;return outcome.result;}
      throw error;
    }
    finally{if(!committed)await rm(temporary,{recursive:true,force:true});}
  });
}
