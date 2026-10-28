import {mkdir,open,readdir,rm,rmdir,lstat} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {exactKeys,integer,record} from "../runtime/decode.js";
import {VMError} from "../runtime/errors.js";
import {readSourceFile} from "./files.js";
function alive(pid:number):boolean {
  try{process.kill(pid,0);return true;}
  catch(error){return !(typeof error==="object"&&error!==null&&"code" in error&&error.code==="ESRCH");}
}
/** Claims are never reused. A contender must see itself alone before publishing. */
export async function withOutputLock<T>(out:string,operation:()=>Promise<T>):Promise<T> {
  const directory=`${out}.owners`,existing=await lstat(directory).catch(()=>undefined);
  if(existing?.isSymbolicLink()===true||existing!==undefined&&!existing.isDirectory())throw new VMError("STORAGE_ERROR","Output ownership must be a regular directory");
  await mkdir(directory,{recursive:true,mode:0o700});
  const parent=await lstat(directory);
  if(!parent.isDirectory()||parent.isSymbolicLink())throw new VMError("STORAGE_ERROR","Output ownership must be a regular directory");
  const name=`${String(process.pid)}-${randomUUID()}.json`,path=join(directory,name);
  const file=await open(path,"wx",0o600);
  try{
    await file.writeFile(JSON.stringify({version:1,pid:process.pid}));await file.sync();
    const claims=await readdir(directory);
    if(claims.length>64)throw new VMError("STORAGE_ERROR","Output ownership exceeds its bound");
    for(const claim of claims){
      if(claim===name)continue;
      if(!/^\d+-[a-f0-9-]{36}\.json$/u.test(claim))throw new VMError("STORAGE_ERROR","Output ownership is malformed");
      const namedPID=integer(Number(claim.split("-")[0]),"output owner PID",1,0x7fff_ffff);
      const candidate=join(directory,claim),metadata=await lstat(candidate).catch(()=>undefined);
      if(metadata===undefined)continue;
      if(!metadata.isFile()||metadata.isSymbolicLink())throw new VMError("STORAGE_ERROR","Output claim must be a regular file");
      if(!alive(namedPID)){
        const current=await lstat(candidate).catch(()=>undefined);
        if(current!==undefined&&current.dev===metadata.dev&&current.ino===metadata.ino&&!alive(namedPID))await rm(candidate,{force:true});
        continue;
      }
      let bytes:Uint8Array<ArrayBuffer>;
      try{bytes=(await readSourceFile(join(directory,claim),1024)).bytes;}
      catch{if(await lstat(join(directory,claim)).catch(()=>undefined)===undefined)continue;throw new VMError("STORAGE_ERROR","Output ownership cannot be inspected");}
      let parsed:unknown;try{parsed=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new VMError("STORAGE_ERROR","Output has a contender publishing ownership");}
      const owner=record(parsed,"output owner");exactKeys(owner,["version","pid"]);
      const pid=integer(owner["pid"],"output owner PID",1,0x7fff_ffff);
      if(owner["version"]!==1||!claim.startsWith(`${String(pid)}-`))throw new VMError("STORAGE_ERROR","Output ownership is malformed");
      throw new VMError("STORAGE_ERROR","Snapshot output already has an active publisher");
    }
    return await operation();
  }finally{
    const held=await file.stat();await file.close();
    const current=await lstat(path).catch(()=>undefined);
    if(current!==undefined&&current.dev===held.dev&&current.ino===held.ino)await rm(path,{force:true});
    await rmdir(directory).catch((error:unknown)=>{
      if(typeof error==="object"&&error!==null&&"code" in error&&(error.code==="ENOTEMPTY"||error.code==="ENOENT"))return;
      throw error;
    });
  }
}
