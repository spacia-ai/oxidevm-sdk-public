import type {ProcessHandle,TerminalHandle} from "../../contracts.js";
import type {SnapshotProcess,SnapshotWaitOptions} from "../../snapshot-authoring.js";
import {authoringName,type AuthoringProcess} from "../../snapshot-authoring-receipt.js";
import {VMError} from "../../runtime/errors.js";

export class OperationSupervisor {
  readonly #pending=new Set<Promise<unknown>>();
  #failure:{readonly error:unknown}|undefined;
  track<T>(promise:Promise<T>):Promise<T> {
    this.#pending.add(promise);
    void promise.then(()=>this.#pending.delete(promise),(error:unknown)=>{this.#failure??={error};this.#pending.delete(promise);});
    return promise;
  }
  async settle():Promise<void> {
    while(this.#pending.size!==0)await Promise.allSettled(this.#pending);
    if(this.#failure!==undefined)throw this.#failure.error;
  }
}
interface OwnedProcess {
  readonly process:ProcessHandle|TerminalHandle;readonly name:string;
  readonly tails:Map<string,string>;readonly readers:ReadableStreamDefaultReader<Uint8Array>[];
  readonly drains:Promise<void>[];readonly wake:Set<()=>void>;
  expected:boolean;exited:boolean;droppedBytes:number;
}
const TAIL_BYTES=64*1024;
const encoder=new TextEncoder();
function tail(text:string):string {
  const bytes=encoder.encode(text);if(bytes.length<=TAIL_BYTES)return text;
  let start=bytes.length-TAIL_BYTES;while(start<bytes.length&&((bytes[start]??0)&0xc0)===0x80)start++;
  return new TextDecoder().decode(bytes.subarray(start));
}
export class ProcessSupervisor {
  readonly #processes=new Map<string,OwnedProcess|undefined>();
  readonly #signal:AbortSignal;readonly #timeout:number;
  readonly #operations:OperationSupervisor;
  readonly #failed=new AbortController();
  #failure:VMError|undefined;
  constructor(signal:AbortSignal,timeout:number,operations:OperationSupervisor){this.#signal=signal;this.#timeout=timeout;this.#operations=operations;}
  get signal():AbortSignal{return AbortSignal.any([this.#signal,this.#failed.signal]);}
  reserve(name:string):void {
    name=authoringName(name);if(this.#processes.has(name))throw new VMError("INVALID_ARGUMENT","Persistent process names must be unique");
    if(this.#processes.size>=64)throw new VMError("INVALID_ARGUMENT","Persistent process limit exceeded");
    this.#processes.set(name,undefined);
  }
  add(name:string,process:ProcessHandle|TerminalHandle):SnapshotProcess {
    if(!this.#processes.has(name))this.reserve(name);
    else if(this.#processes.get(name)!==undefined)throw new VMError("INVALID_ARGUMENT","Persistent process names must be unique");
    if(process.snapshotKey===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","Persistent process has no snapshot identity");
    const entry:OwnedProcess={process,name,tails:new Map(),readers:[],drains:[],wake:new Set(),expected:false,exited:false,droppedBytes:0};
    this.#processes.set(name,entry);
    if(process.kind==="process"){this.#drain(entry,"stdout",process.stdout);this.#drain(entry,"stderr",process.stderr);}
    else this.#drain(entry,"terminal",process.output);
    void process.exit.then(()=>{entry.exited=true;if(!entry.expected)this.#fail(name);this.#wake(entry);},()=>{entry.exited=true;this.#fail(name);this.#wake(entry);});
    const base={name,snapshotKey:process.snapshotKey,pid:process.pid,stdin:process.stdin,exit:process.exit,
      kill:(...args:Parameters<ProcessHandle["kill"]>)=>this.#operations.track((async()=>{
        entry.expected=true;
        try{await process.kill(...args);}catch(error){entry.expected=false;if(entry.exited)this.#fail(name);throw error;}
      })()),
      waitForOutput:(text:string,options?:SnapshotWaitOptions)=>this.#operations.track(this.#wait(entry,text,options))};
    return process.kind==="process"?{...base,kind:"process"}:{...base,kind:"terminal",
      resize:(size:Parameters<TerminalHandle["resize"]>[0])=>this.#operations.track(process.resize(size)),interrupt:()=>this.#operations.track(process.interrupt())};
  }
  required():readonly AuthoringProcess[] {
    if(this.#failure!==undefined)throw this.#failure;
    const result:AuthoringProcess[]=[];
    for(const [name,entry] of this.#processes) {
      if(entry===undefined)throw new VMError("PROTOCOL_ERROR","Persistent launch has not settled");
      if(entry.expected&&entry.exited)continue;
      if(entry.exited)throw this.#fail(name);
      const snapshotKey=entry.process.snapshotKey;if(snapshotKey===undefined)throw new VMError("PROTOCOL_ERROR","Persistent identity was lost");
      result.push({name,pid:entry.process.pid,snapshotKey,kind:entry.process.kind});
    }
    return result;
  }
  async close():Promise<void> {
    const drains:Promise<void>[]=[];
    for(const entry of this.#processes.values())if(entry!==undefined){
      for(const reader of entry.readers)await reader.cancel().catch(()=>{});
      drains.push(...entry.drains);
    }
    await Promise.allSettled(drains);
  }
  #fail(name:string):VMError {
    this.#failure??=new VMError("GUEST_CRASH","A required snapshot process exited",{reason:"snapshot-process-exited",process:name});
    this.#failed.abort(this.#failure);
    return this.#failure;
  }
  #wake(entry:OwnedProcess):void {for(const wake of entry.wake)wake();}
  #drain(entry:OwnedProcess,key:string,stream:ReadableStream<Uint8Array>):void {
    const reader=stream.getReader(),decoder=new TextDecoder();entry.readers.push(reader);
    const draining=(async()=>{
      try{
        for(;;){
          const next=await reader.read();if(next.done)break;
          const combined=(entry.tails.get(key)??"")+decoder.decode(next.value,{stream:true}),kept=tail(combined);
          entry.droppedBytes+=encoder.encode(combined).length-encoder.encode(kept).length;
          entry.tails.set(key,kept);this.#wake(entry);
        }
      }catch{if(!this.#signal.aborted)this.#fail(entry.name);}
      finally{reader.releaseLock();}
    })();entry.drains.push(draining);
  }
  async #wait(entry:OwnedProcess,text:string,options:SnapshotWaitOptions={}):Promise<void> {
    if(text.length===0||encoder.encode(text).length>TAIL_BYTES)throw new VMError("INVALID_ARGUMENT","Output match exceeds the bounded tail");
    const signal=AbortSignal.any([this.signal,...(options.signal===undefined?[]:[options.signal]),AbortSignal.timeout(options.timeoutMs??this.#timeout)]);
    const matches=()=>[...entry.tails.values()].some(tail=>tail.includes(text));
    if(matches())return;this.required();
    await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{entry.wake.delete(check);signal.removeEventListener("abort",aborted);};
      const check=()=>{if(matches()){cleanup();resolve();}else if(entry.exited){cleanup();reject(this.#failure??new VMError("GUEST_CRASH","Persistent process ended"));}};
      const aborted=()=>{cleanup();reject(this.#failure??new VMError("ABORTED","Output readiness was cancelled",{reason:"snapshot-readiness-timeout",droppedOutputBytes:entry.droppedBytes}));};
      entry.wake.add(check);signal.addEventListener("abort",aborted,{once:true});if(signal.aborted)aborted();else check();
    });
  }
}
