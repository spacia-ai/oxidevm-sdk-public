import type {ListeningPort,VM} from "../../contracts.js";
import type {SnapshotWaitOptions} from "../../snapshot-authoring.js";
import {integer} from "../../runtime/decode.js";
import {VMError} from "../../runtime/errors.js";
import type {SnapshotFailureReason} from "../../snapshot-authoring-protocol.js";
export async function boundedOperation<T>(outer:AbortSignal,defaultTimeout:number,options:SnapshotWaitOptions,operation:(signal:AbortSignal)=>Promise<T>,reason:SnapshotFailureReason="snapshot-readiness-timeout"):Promise<T> {
  const timeout=integer(options.timeoutMs??defaultTimeout,"helper timeout",1,2_147_483_647),deadline=new AbortController();
  const timer=setTimeout(()=>deadline.abort(new VMError("ABORTED","Snapshot helper deadline expired",{reason})),timeout);
  const signal=AbortSignal.any([outer,deadline.signal,...(options.signal===undefined?[]:[options.signal])]);
  const interrupted=Promise.withResolvers<never>(),aborted=()=>interrupted.reject(signal.reason instanceof VMError?signal.reason:new VMError("ABORTED","Snapshot helper was cancelled"));
  try{
    active(signal);signal.addEventListener("abort",aborted,{once:true});
    return await Promise.race([operation(signal),interrupted.promise]);
  }finally{clearTimeout(timer);signal.removeEventListener("abort",aborted);}
}
export function active(signal:AbortSignal):void {
  if(signal.aborted)throw signal.reason instanceof VMError?signal.reason:new VMError("ABORTED","Snapshot helper was cancelled");
}
export async function poll(predicate:()=>boolean|Promise<boolean>,signal:AbortSignal):Promise<void> {
  for(;;){
    active(signal);const result:unknown=await predicate();
    if(typeof result!=="boolean")throw new VMError("INVALID_ARGUMENT","Readiness predicate must return a boolean");
    if(result)return;await pause(signal);
  }
}
/**
 * Captures once the guest's file operations have settled. The engine refuses to begin a checkpoint
 * while one is in flight (begin rejected with "not-quiesced"), which is momentary on a machine that
 * has just started its services; every other failure, and the caller's deadline, still end it.
 */
export async function captureWhenQuiesced<T>(capture:()=>Promise<T>,signal:AbortSignal):Promise<T> {
  for(let wait=250;;wait=Math.min(wait*2,2_000)){
    active(signal);
    try{return await capture();}
    catch(error){if(!notQuiesced(error))throw error;}
    await pause(signal,wait);
  }
}
function notQuiesced(error:unknown):boolean {
  if(!(error instanceof VMError)||error.code!=="PROTOCOL_ERROR"||error.detail?.["reason"]!=="checkpoint-begin-rejected")return false;
  const causes=error.detail["nativeCauses"];
  return Array.isArray(causes)&&causes.includes("not-quiesced");
}
function pause(signal:AbortSignal,milliseconds=250):Promise<void> {
  return new Promise((resolve,reject)=>{
    const aborted=()=>{clearTimeout(timer);signal.removeEventListener("abort",aborted);reject(signal.reason instanceof VMError?signal.reason:new VMError("ABORTED","Readiness was cancelled"));};
    const timer=setTimeout(()=>{signal.removeEventListener("abort",aborted);resolve();},milliseconds);
    signal.addEventListener("abort",aborted,{once:true});if(signal.aborted)aborted();
  });
}
export async function waitPort(vm:Pick<VM,"listeningPorts"|"watchListeningPorts">,port:number,signal:AbortSignal):Promise<ListeningPort> {
  integer(port,"guest port",1,65535);active(signal);
  const watching=new AbortController(),watched=AbortSignal.any([signal,watching.signal]);
  const found=Promise.withResolvers<ListeningPort>();
  const update=(ports:readonly ListeningPort[])=>{const listening=ports.find(candidate=>candidate.port===port);if(listening!==undefined)found.resolve(listening);};
  const abort=()=>found.reject(signal.reason instanceof VMError?signal.reason:new VMError("ABORTED","Port readiness was cancelled"));
  signal.addEventListener("abort",abort,{once:true});
  const observer=vm.watchListeningPorts(update,{signal:watched});
  void observer.catch((error:unknown)=>{if(!watching.signal.aborted)found.reject(error);});
  try{update(await vm.listeningPorts({signal}));if(signal.aborted)abort();return await found.promise;}
  finally{watching.abort();signal.removeEventListener("abort",abort);await observer.catch((error:unknown)=>{if(!watching.signal.aborted)throw error;});}
}
