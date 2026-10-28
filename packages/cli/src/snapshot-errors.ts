import {VMError} from "@oxidevm/sdk";
import {isSnapshotProcessName} from "@oxidevm/sdk/image-builder";
const phases=["validate","compile","start","stage","prepare","ready","capture","export","package","verify","publish","done"];
const checks=["bundle-signature","image-integrity","snapshot-integrity","browser-features","shipped-resume","authoring-receipt","original-processes","custom-verification"];
const reasons=["snapshot-recipe-invalid","snapshot-input-unsafe","snapshot-process-exited","snapshot-command-failed","snapshot-readiness-timeout","snapshot-command-exit","snapshot-command-timeout","snapshot-ready-timeout","snapshot-capture-timeout","snapshot-build-timeout","snapshot-verify-failed","snapshot-unexpected-cold-boot","snapshot-browser-unavailable","snapshot-preparation-failed","snapshot-publication-incomplete","snapshot-initial-conflict"];
export function snapshotFailureDetail(error:unknown):Readonly<Record<string,unknown>>|undefined {
  if(!(error instanceof VMError)||error.detail===undefined)return undefined;
  const phase=error.detail["phase"],reason=error.detail["reason"],cause=error.detail["cause"],process=error.detail["process"],check=error.detail["check"],browserMessage=error.detail["browserMessage"];
  return {...(typeof phase==="string"&&phases.includes(phase)?{phase}:{}),...(typeof reason==="string"&&reasons.includes(reason)?{reason}:{}),
    ...(typeof check==="string"&&checks.includes(check)?{check}:{}),
    ...(typeof cause==="string"&&["ENOSPC","EDQUOT","EIO","EACCES"].includes(cause)?{cause}:{}),
    ...(isSnapshotProcessName(process)?{process}:{}),
    ...(safeCheckpoint(error.detail["checkpoint"])?{checkpoint:error.detail["checkpoint"]}:{}),
    // The SDK normalizes the browser's own SDK error message to one printable line.
    ...(typeof browserMessage==="string"&&/^[\x20-\x7e…]{1,500}$/u.test(browserMessage)?{browserMessage}:{})};
}
/** The SDK's decoded checkpoint refusal: closed lowercase names and native cause names only. */
function safeCheckpoint(value:unknown):value is {readonly phase:string;readonly domain:string;readonly owner?:string;readonly causes:readonly string[]} {
  if(typeof value!=="object"||value===null)return false;
  const keys=Object.keys(value),name=/^[a-z][a-z-]{0,31}$/u,cause=/^[A-Za-z0-9][A-Za-z0-9-]{0,47}$/u;
  const phase:unknown=Reflect.get(value,"phase"),domain:unknown=Reflect.get(value,"domain"),owner:unknown=Reflect.get(value,"owner"),causes:unknown=Reflect.get(value,"causes");
  return keys.every(key=>["phase","domain","owner","causes"].includes(key))&&typeof phase==="string"&&name.test(phase)&&typeof domain==="string"&&name.test(domain)
    &&(owner===undefined||typeof owner==="string"&&name.test(owner))&&Array.isArray(causes)&&causes.length<=9&&causes.every((item:unknown)=>typeof item==="string"&&cause.test(item));
}
function checkpointText(value:unknown):string[] {
  if(!safeCheckpoint(value))return [];
  return [`checkpoint ${value.phase} ${value.domain}${value.owner===undefined?"":`/${value.owner}`}${value.causes.length===0?"":` ${value.causes.join("/")}`}`];
}
/** Text output: the fixed summary, the safe context, then the browser's SDK message. */
export function snapshotFailureText(code:string,detail:Readonly<Record<string,unknown>>|undefined):string {
  const context=[...(["phase","reason","check","process","cause"] as const).flatMap(key=>typeof detail?.[key]==="string"?[`${key} ${detail[key]}`]:[]),...checkpointText(detail?.["checkpoint"])];
  const browserMessage=detail?.["browserMessage"];
  return `${code}: Snapshot command failed${context.length===0?"":` (${context.join(", ")})`}${typeof browserMessage==="string"?`: ${browserMessage}`:""}\n`;
}
export function cancellationExit(signal:AbortSignal):130|143 {
  const reason:unknown=signal.reason;
  return typeof reason==="object"&&reason!==null&&"kind" in reason&&reason.kind==="signal"&&"signal" in reason&&reason.signal==="SIGTERM"?143:130;
}
