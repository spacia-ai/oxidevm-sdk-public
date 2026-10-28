import {exactKeys,integer,record,string} from "../runtime/decode.js";
import {decodeSnapshotRef,type SnapshotRef} from "../runtime/protocol/snapshots.js";
import {decodeSHA256,type SHA256} from "../values.js";
import {decodeSerializedError,VMError,type VMErrorCode} from "../runtime/errors.js";
import {decodeSnapshotPhase,isSnapshotFailureReason,type SnapshotFailureReason} from "../snapshot-authoring-protocol.js";
import type {SnapshotPhase} from "../snapshot-authoring.js";
import type {SnapshotCheck,SnapshotCheckResult} from "./snapshot-contracts.js";
import {SNAPSHOT_CHECKS} from "./snapshot-reports.js";
import {isAuthoringName} from "../snapshot-authoring-receipt.js";
import {decodeCheckpointFailureSummary,type CheckpointFailureSummary} from "../runtime/protocol/checkpoint-failure.js";
export type SnapshotBrowserResult=
  | {readonly ok:true;readonly result:{readonly kind:"prepared";readonly snapshot:SnapshotRef;readonly receiptSHA256:SHA256;readonly imageManifestSHA256:SHA256}}
  | {readonly ok:true;readonly result:{readonly kind:"verified";readonly snapshot:SnapshotRef;readonly receipt:boolean;readonly originalProcesses:number}}
  | {readonly ok:false;readonly error:SnapshotBrowserFailure};
/** The browser's failure; `message` is the SDK error message, normalized to one bounded line. */
export interface SnapshotBrowserFailure {readonly code:VMErrorCode;readonly message:string;readonly phase:SnapshotPhase;readonly check:SnapshotCheck;readonly reason?:SnapshotFailureReason;readonly process?:string;
  /** Why the engine refused to begin the checkpoint of the capture, when it did. */
  readonly checkpoint?:CheckpointFailureSummary}
const MESSAGE_LIMIT=500;
export function decodeSnapshotBrowserResult(value:unknown):SnapshotBrowserResult {
  const input=record(value,"snapshot browser result");exactKeys(input,["ok"],input["ok"]===true?["result"]:["error"]);
  if(input["ok"]===false){
    const error=record(input["error"],"snapshot browser error");exactKeys(error,["code","message","phase","check"],["reason","process","checkpoint"]);
    const message=browserMessage(string(error["message"],"browser error message"));
    const check=SNAPSHOT_CHECKS.find(check=>check===error["check"]);if(check===undefined)invalid();
    const reason=error["reason"];
    const process=error["process"];
    if(reason!==undefined&&!isSnapshotFailureReason(reason)||process!==undefined&&!isAuthoringName(process))invalid();
    const checkpoint=error["checkpoint"]===undefined?undefined:decodeCheckpointFailureSummary(error["checkpoint"]);
    return {ok:false,error:{code:decodeSerializedError({code:error["code"],message:"Snapshot browser action failed"}).code,message,phase:decodeSnapshotPhase(error["phase"]),check,...(reason===undefined?{}:{reason}),...(process===undefined?{}:{process}),...(checkpoint===undefined?{}:{checkpoint})}};
  }
  if(input["ok"]!==true)invalid();
  const result=record(input["result"],"snapshot browser success"),snapshot=decodeSnapshotRef(result["snapshot"]);
  if(result["kind"]==="prepared"){
    exactKeys(result,["kind","snapshot","receiptSHA256","imageManifestSHA256"]);
    return {ok:true,result:{kind:"prepared",snapshot,receiptSHA256:decodeSHA256(result["receiptSHA256"],"receipt hash"),imageManifestSHA256:decodeSHA256(result["imageManifestSHA256"],"image hash")}};
  }
  exactKeys(result,["kind","snapshot","receipt","originalProcesses"]);
  if(result["kind"]!=="verified"||typeof result["receipt"]!=="boolean")invalid();
  const originalProcesses=integer(result["originalProcesses"],"original process count",0,65_536);
  if(!result["receipt"]&&originalProcesses!==0)invalid();
  return {ok:true,result:{kind:"verified",snapshot,receipt:result["receipt"],originalProcesses}};
}
export function snapshotVerificationChecks(result:SnapshotBrowserResult):readonly SnapshotCheckResult[] {
  if(result.ok&&result.result.kind!=="verified")invalid();
  return SNAPSHOT_CHECKS.map(check=>{
    if(!result.ok){
      const failedAt=SNAPSHOT_CHECKS.indexOf(result.error.check);
      return SNAPSHOT_CHECKS.indexOf(check)<failedAt?{check,status:"passed"}:{check,status:"failed",message:check===result.error.check?result.error.message:"Verification did not reach this check"};
    }
    if(result.result.kind==="verified"&&!result.result.receipt&&(check==="authoring-receipt"||check==="original-processes"))return {check,status:"not-applicable",reason:"receipt-absent"};
    return {check,status:"passed"};
  });
}
/** A failed preparation; its verification check is not meaningful before a prepared snapshot exists. */
export function snapshotPreparationFailure(error:SnapshotBrowserFailure):VMError {
  return new VMError(error.code,`Snapshot preparation did not complete: ${error.message}`,{phase:error.phase,reason:error.reason??"snapshot-preparation-failed",
    ...(error.process===undefined?{}:{process:error.process}),...(error.checkpoint===undefined?{}:{checkpoint:error.checkpoint}),browserMessage:error.message});
}
function browserMessage(value:string):string {
  const line=value.replace(/\s+/gu," ").replace(/[^\x20-\x7e]/gu,"?").trim();
  return line===""?"Snapshot browser action failed":line.length>MESSAGE_LIMIT?`${line.slice(0,MESSAGE_LIMIT-1)}…`:line;
}
function invalid():never {throw new VMError("PROTOCOL_ERROR","Snapshot browser returned an invalid result");}
