import {randomUUID} from "node:crypto";
import {VMError} from "../runtime/errors.js";
import type {SnapshotPhase} from "../snapshot-authoring.js";
import type {SnapshotProgress} from "./snapshot-contracts.js";
import {abortIfRequested} from "./tools.js";
export interface SnapshotRun {readonly buildId:string;readonly signal:AbortSignal;emit(phase:SnapshotPhase,bytes?:{completedBytes:number;totalBytes:number}):void;remaining():number;failure(error:unknown):VMError;close():void}
export function createSnapshotRun(timeoutMs:number,signal?:AbortSignal,onProgress?:(progress:SnapshotProgress)=>void):SnapshotRun {
  const buildId=randomUUID(),controller=new AbortController(),expires=Date.now()+timeoutMs;
  const timer=setTimeout(()=>controller.abort(new VMError("ABORTED","Snapshot deadline expired",{reason:"snapshot-build-timeout"})),timeoutMs);
  const abort=()=>controller.abort(signal?.reason);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted===true)abort();
  let sequence=0,phase:SnapshotPhase="validate";
  return {buildId,signal:controller.signal,emit:(current,bytes)=>{phase=current;onProgress?.({buildId,sequence:++sequence,phase,...bytes});},
    remaining:()=>{abortIfRequested(controller.signal);return Math.max(1,expires-Date.now());},
    failure:error=>{
      if(error instanceof VMError)return new VMError(error.code,error.message,{phase,...error.detail});
      const cause=typeof error==="object"&&error!==null&&"code" in error&&typeof error.code==="string"&&["ENOSPC","EDQUOT","EIO","EACCES"].includes(error.code)?error.code:undefined;
      return new VMError(cause===undefined?"VM_FAULT":"STORAGE_ERROR","Snapshot operation failed",{phase,...(cause===undefined?{}:{cause})});
    },
    close:()=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);}};
}
