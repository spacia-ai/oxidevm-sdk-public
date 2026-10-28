import {sha256} from "@noble/hashes/sha2.js";
import {VMError} from "../errors.js";
import type {UserspaceRootfsBlob} from "../userspace-rootfs.js";
import {retainWorkspaceRead,type WorkspaceReadLease} from "./workspace-read.js";
import type {Backend} from "./rootfs-store-backend.js";
const FRAME=65536;
/** Verify an immutable OPFS snapshot before lending bounded frames to a native writer. */
export async function openCachedRootfsFile(backend:Backend,blob:UserspaceRootfsBlob,signal:AbortSignal,release:()=>void):Promise<WorkspaceReadLease> {
 try {
  active(signal);
  if(backend.kind!=="opfs")throw new VMError("FEATURE_NOT_AVAILABLE","Bounded rootfs reads require OPFS");
  const directory=await (await backend.root.getDirectoryHandle("userspace-rootfs")).getDirectoryHandle("blobs");
  const file=await (await directory.getFileHandle(blob.sha256)).getFile();
  if(file.size!==blob.bytes)throw damaged();
  const hash=sha256.create();
  for(let offset=0;offset<file.size;offset+=FRAME) {active(signal);hash.update(new Uint8Array(await file.slice(offset,offset+FRAME).arrayBuffer()));}
  const digest=[...hash.digest()].map(byte=>byte.toString(16).padStart(2,"0")).join("");
  if(digest!==blob.sha256)throw damaged();
  active(signal);
  return retainWorkspaceRead({generation:1,snapshot:{bytes:blob.bytes,read:async function*(signal){
   for(let offset=0;offset<file.size;offset+=FRAME) {active(signal);yield new Uint8Array(await file.slice(offset,offset+FRAME).arrayBuffer());}
  }}},signal,release,()=>{});
 } catch(error) {release();if(error instanceof VMError)throw error;throw damaged();}
}
function active(signal:AbortSignal):void {if(signal.aborted)throw new VMError("ABORTED","Rootfs file read cancelled");}
function damaged():VMError {return new VMError("STORAGE_ERROR","Verified immutable rootfs file is missing or damaged",{reason:"image-not-cached"});}
