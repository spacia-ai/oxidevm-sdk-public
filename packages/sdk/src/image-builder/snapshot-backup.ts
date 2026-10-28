import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {VMError} from "../runtime/errors.js";
import {abortIfRequested} from "./tools.js";
import {readBackup} from "../runtime/workers/snapshot-archive/reader.js";
import {USERSPACE_SNAPSHOT_SCHEMA,type SnapshotManifest} from "../runtime/workers/snapshot-manifest.js";
import type {SnapshotCapturedSummary} from "./snapshot-contracts.js";
export async function backupFileStream(path:string,signal?:AbortSignal):Promise<{stream:ReadableStream<Uint8Array>;bytes:number}> {
  abortIfRequested(signal);
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  const before=await file.stat();let offset=0,closed=false;
  const close=async()=>{if(!closed){closed=true;await file.close();}};
  if(!before.isFile()||before.size>16*1024**3){await close();throw new VMError("INVALID_ARGUMENT","Backup must be a bounded regular file");}
  const stream=new ReadableStream<Uint8Array>({
    async pull(controller){
      try{
        abortIfRequested(signal);
        const bytes=new Uint8Array(Math.min(1024**2,before.size-offset)),read=await file.read(bytes,0,bytes.length,offset);
        offset+=read.bytesRead;
        if(read.bytesRead!==0){controller.enqueue(bytes.slice(0,read.bytesRead));return;}
        const after=await file.stat();
        if(offset!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new VMError("PROTOCOL_ERROR","Backup changed during streaming");
        await close();controller.close();
      }catch(error){await close();controller.error(error);}
    },cancel:close,
  },{highWaterMark:0});
  return {stream,bytes:before.size};
}
export function capturedSummary(manifest:SnapshotManifest):SnapshotCapturedSummary {
  return {id:manifest.id,mode:manifest.schema===USERSPACE_SNAPSHOT_SCHEMA?"userspace":"system",kind:manifest.kind,capturedAtUnixMs:manifest.capturedAtUnixMs,
    memoryMiB:(manifest.schema===USERSPACE_SNAPSHOT_SCHEMA?manifest.compatibility.memoryBytes:manifest.machine.memoryBytes)/1024**2,vcpus:manifest.schema===USERSPACE_SNAPSHOT_SCHEMA?1:manifest.machine.vcpus,
    stateFormatVersion:manifest.schema===USERSPACE_SNAPSHOT_SCHEMA?manifest.compatibility.version:2};
}
export async function inspectBackupFile(path:string,signal?:AbortSignal):Promise<{manifest:SnapshotManifest;bytes:number}> {
  const file=await backupFileStream(path,signal);let manifest:SnapshotManifest|undefined;
  for await(const entry of readBackup(file.stream,{nowUnixMs:Date.now()})){abortIfRequested(signal);if(entry.kind==="manifest")manifest=entry.manifest.snapshot;}
  if(manifest===undefined)throw new VMError("PROTOCOL_ERROR","Backup has no captured state");
  return {manifest,bytes:file.bytes};
}
