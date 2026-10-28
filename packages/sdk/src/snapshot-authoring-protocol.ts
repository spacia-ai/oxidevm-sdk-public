import {exactKeys,integer,record,string} from "./runtime/decode.js";
import {VMError} from "./runtime/errors.js";
import type {SnapshotPhase} from "./snapshot-authoring.js";
export const SNAPSHOT_AUTHORING_PROTOCOL_VERSION=1;
export const SNAPSHOT_UPLOAD_SLICE_BYTES=1024**2;
export interface SnapshotTransportIdentity {readonly version:1;readonly buildId:string;readonly token:string}
export type SnapshotTransport=SnapshotTransportIdentity & {readonly sequence:number} & (
  | {readonly type:"progress";readonly phase:SnapshotPhase;readonly completedBytes?:number;readonly totalBytes?:number}
  | {readonly type:"log";readonly level:"info"|"warn";readonly message:string}
  | {readonly type:"upload-begin";readonly bytes:number}
  | {readonly type:"upload-end"}
);
export interface SnapshotPreviewRequest {readonly url:string;readonly timeoutMs:number}
export interface SnapshotPreviewResponse {readonly status:number;readonly body:string;readonly transportError:boolean}
const PHASES:readonly SnapshotPhase[]=["validate","compile","start","stage","prepare","ready","capture","export","package","verify","publish","done"];
const FAILURE_REASONS=["snapshot-recipe-invalid","snapshot-input-unsafe","snapshot-process-exited","snapshot-command-failed","snapshot-readiness-timeout","snapshot-command-exit","snapshot-command-timeout","snapshot-ready-timeout","snapshot-capture-timeout","snapshot-build-timeout","snapshot-verify-failed","snapshot-unexpected-cold-boot","snapshot-browser-unavailable","snapshot-preparation-failed","snapshot-publication-incomplete","snapshot-initial-conflict"] as const;
export type SnapshotFailureReason=typeof FAILURE_REASONS[number];
export function isSnapshotFailureReason(value:unknown):value is SnapshotFailureReason {return FAILURE_REASONS.some(reason=>reason===value);}
export function decodeSnapshotPhase(value:unknown):SnapshotPhase {
  const phase=PHASES.find(phase=>phase===value);if(phase===undefined)invalid();return phase;
}
export function decodeSnapshotTransport(value:unknown):SnapshotTransport {
  const input=record(value,"authoring transport");
  const type=input["type"],required=["version","buildId","token","sequence","type"];
  const fields=type==="progress"?["phase"]:type==="log"?["level","message"]:type==="upload-begin"?["bytes"]:type==="upload-end"?[]:undefined;
  if(fields===undefined)invalid();exactKeys(input,[...required,...fields],type==="progress"?["completedBytes","totalBytes"]:[]);
  if(input["version"]!==1)invalid();
  const buildId=string(input["buildId"],"build identity"),token=string(input["token"],"transport token");
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(buildId)||!/^[a-f0-9]{64}$/u.test(token))invalid();
  const common={version:1 as const,buildId,token,sequence:integer(input["sequence"],"transport sequence",1)};
  if(type==="upload-begin")return {...common,type,bytes:integer(input["bytes"],"backup length",1,16*1024**3)};
  if(type==="upload-end")return {...common,type};
  if(type==="log"){
    const level=input["level"],message=string(input["message"],"author log");if(level!=="info"&&level!=="warn"||new TextEncoder().encode(message).length>4096)invalid();
    return {...common,type,level,message};
  }
  const completedBytes=input["completedBytes"],totalBytes=input["totalBytes"];
  if((completedBytes===undefined)!==(totalBytes===undefined))invalid();
  if(completedBytes===undefined)return {...common,type:"progress",phase:decodeSnapshotPhase(input["phase"])};
  const completed=integer(completedBytes,"completed bytes",0),total=integer(totalBytes,"total bytes",completed);
  return {...common,type:"progress",phase:decodeSnapshotPhase(input["phase"]),completedBytes:completed,totalBytes:total};
}
export function decodeSnapshotPreviewRequest(value:unknown):SnapshotPreviewRequest {
  const request=record(value,"preview request");exactKeys(request,["url","timeoutMs"]);
  const url=string(request["url"],"preview URL");
  if(url.length>8192)invalid();
  return {url,timeoutMs:integer(request["timeoutMs"],"preview timeout",1,2_147_483_647)};
}
export function decodeSnapshotPreviewResponse(value:unknown):SnapshotPreviewResponse {
  const response=record(value,"preview response");exactKeys(response,["status","body","transportError"]);
  const body=string(response["body"],"preview body"),transportError=response["transportError"];
  if(typeof transportError!=="boolean"||new TextEncoder().encode(body).length>1024**2)invalid();
  return {status:integer(response["status"],"preview status",100,599),body,transportError};
}
function invalid():never {throw new VMError("PROTOCOL_ERROR","Snapshot authoring message is invalid");}
