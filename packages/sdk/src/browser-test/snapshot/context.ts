import type {ExecSpec,ExecResult,PipeSpawnSpec,TerminalSpawnSpec,VM,PreviewHandle} from "../../contracts.js";
import type {SnapshotContext,SnapshotData,SnapshotPhase,SnapshotPreparationContext,SnapshotProcess,SnapshotTimeouts,SnapshotVerificationContext,SnapshotWaitOptions} from "../../snapshot-authoring.js";
import {encodeAuthoringReceipt,type AuthoringReceipt} from "../../snapshot-authoring-receipt.js";
import {integer} from "../../runtime/decode.js";
import {VMError} from "../../runtime/errors.js";
import {active,boundedOperation,poll,waitPort} from "./readiness.js";
import {OperationSupervisor,ProcessSupervisor} from "./processes.js";
export interface SnapshotAuthoringRun {
  readonly signal:AbortSignal;readonly timeouts:Required<SnapshotTimeouts>;
  onPhase(phase:SnapshotPhase):void;log(level:"info"|"warn",message:string):void;
  requestPreview(request:{url:string;timeoutMs:number},signal:AbortSignal):Promise<{status:number;body:string;transportError:boolean}>;
}
interface Helpers {readonly context:SnapshotContext;close():Promise<void>}
export async function runCommand(vm:Pick<VM,"exec">,input:ExecSpec & {timeoutMs?:number;expectedExitCode?:number},signal:AbortSignal,timeout:number):Promise<ExecResult> {
  const {timeoutMs,expectedExitCode,...spec}=input;
  const expected=integer(expectedExitCode??0,"expected exit code",0,255);
  return boundedOperation(signal,timeout,{...(timeoutMs===undefined?{}:{timeoutMs}),...(spec.signal===undefined?{}:{signal:spec.signal})},async signal=>{
    const result=await vm.exec({...spec,signal});
    if(result.exit.kind!=="exited"||result.exit.code!==expected)throw new VMError("GUEST_CRASH","A finite snapshot command failed its exit expectation",{reason:"snapshot-command-failed",expectedExitCode:expected});
    return result;
  },"snapshot-command-timeout");
}
function helpers(vm:VM,run:SnapshotAuthoringRun,operations:OperationSupervisor,processes:ProcessSupervisor):Helpers {
  const previews=new Map<number,Promise<PreviewHandle>>(),signal=processes.signal;
  const ready=<T>(options:SnapshotWaitOptions,operation:(signal:AbortSignal)=>Promise<T>)=>operations.track(boundedOperation(signal,run.timeouts.readyMs,options,operation));
  const context:SnapshotContext={vm,signal,
    run:spec=>operations.track(runCommand(vm,spec,signal,run.timeouts.commandMs)),
    waitForPort:(port,options={})=>ready(options,signal=>waitPort(vm,port,signal)),
    waitUntil:(_label,predicate,options={})=>ready(options,signal=>poll(async()=>{processes.required();return predicate();},signal)),
    waitForHTTP:options=>ready(options,async signal=>{
      await waitPort(vm,options.port,signal);
      let exposing=previews.get(options.port);
      if(exposing===undefined){exposing=vm.exposePort(options.port,{signal});previews.set(options.port,exposing);}
      const preview=await exposing,path=options.path??"/";
      if(!path.startsWith("/")||path.startsWith("//")||path.includes("\\")||path.includes("#"))throw new VMError("INVALID_ARGUMENT","HTTP readiness path must remain on its preview origin");
      const url=new URL(path,preview.url);
      if(url.origin!==preview.url.origin||url.pathname.startsWith("/__oxidevm/"))throw new VMError("INVALID_ARGUMENT","HTTP readiness must address the guest application");
      const expected=integer(options.status??200,"HTTP readiness status",100,599);
      let result:{status:number;body:string;transportError:boolean}|undefined;
      await poll(async()=>{
        processes.required();
        try{result=await run.requestPreview({url:url.href,timeoutMs:options.timeoutMs??run.timeouts.readyMs},signal);}
        catch(error){active(signal);if(error instanceof VMError&&error.code==="INVALID_ARGUMENT")throw error;return false;}
        return !result.transportError&&result.status===expected&&(options.bodyIncludes===undefined||result.body.includes(options.bodyIncludes));
      },signal);
      if(result===undefined)throw new VMError("PROTOCOL_ERROR","HTTP readiness supplied no response");
      return {status:result.status,body:result.body};
    }),
    log:(level:unknown,message:unknown)=>{if(level!=="info"&&level!=="warn"||typeof message!=="string"||new TextEncoder().encode(message).length>4096)throw new VMError("INVALID_ARGUMENT","Author log is invalid");run.log(level,message);},
  };
  return {context,close:async()=>{await Promise.allSettled([...previews.values()].map(async pending=>(await pending).close()));}};
}
export interface SnapshotPreparationSession {
  readonly context:SnapshotPreparationContext;
  settle(data:SnapshotData|Awaited<Promise<void>>):Promise<AuthoringReceipt>;
  guardCapture<T>(capture:()=>Promise<T>):Promise<T>;
  close():Promise<void>;
}
export function createPreparationSession(vm:VM,run:SnapshotAuthoringRun):SnapshotPreparationSession {
  const operations=new OperationSupervisor(),processes=new ProcessSupervisor(run.signal,run.timeouts.readyMs,operations),common=helpers(vm,run,operations,processes);
  function start(name:string,spec:PipeSpawnSpec):Promise<Extract<SnapshotProcess,{kind:"process"}>>;
  function start(name:string,spec:TerminalSpawnSpec):Promise<Extract<SnapshotProcess,{kind:"terminal"}>>;
  function start(name:string,spec:PipeSpawnSpec|TerminalSpawnSpec):Promise<SnapshotProcess> {
    processes.reserve(name);
    return operations.track((async()=>{
      const signal=AbortSignal.any([processes.signal,...(spec.signal===undefined?[]:[spec.signal])]);
      const process=spec.terminal===undefined?await vm.spawn({...spec,signal}):await vm.spawn({...spec,signal});
      return processes.add(name,process);
    })());
  }
  return {
    context:{...common.context,start},
    settle:async data=>{
      await operations.settle();active(processes.signal);
      const receipt:AuthoringReceipt={format:"oxidevm-snapshot-authoring",schemaVersion:1,data:data??null,processes:processes.required()};
      await vm.snapshots.setAppData(encodeAuthoringReceipt(receipt));return receipt;
    },
    guardCapture:async capture=>{processes.required();const result=await capture();processes.required();return result;},
    close:async()=>{await common.close();await processes.close();},
  };
}
export function createVerificationSession(vm:VM,receipt:AuthoringReceipt|undefined,run:SnapshotAuthoringRun):{
  readonly context:SnapshotVerificationContext;attachAll():Promise<void>;settle():Promise<void>;close():Promise<void>;
} {
  const operations=new OperationSupervisor(),processes=new ProcessSupervisor(run.signal,run.timeouts.readyMs,operations),common=helpers(vm,run,operations,processes);
  const attached=new Map<string,Promise<SnapshotProcess>>();
  const attach=(name:string):Promise<SnapshotProcess>=>{
    const existing=attached.get(name);if(existing!==undefined)return existing;
    const opening=operations.track((async()=>{
      const original=receipt?.processes.find(process=>process.name===name);
      if(original===undefined||vm.start.kind!=="resumed")throw new VMError("INVALID_ARGUMENT","No original restored process has this name");
      const matches=vm.start.terminals.filter(descriptor=>descriptor.source==="process"&&descriptor.key===original.snapshotKey);
      const descriptor=matches[0];if(matches.length!==1||descriptor?.source!=="process")throw new VMError("GUEST_CRASH","Original process descriptor was not restored",{reason:"snapshot-verify-failed",process:name});
      const handle=await descriptor.attach({signal:processes.signal});
      if(handle.pid!==original.pid||handle.snapshotKey!==original.snapshotKey||handle.kind!==original.kind)throw new VMError("GUEST_CRASH","Original process identity changed",{reason:"snapshot-verify-failed",process:name});
      return processes.add(name,handle);
    })());attached.set(name,opening);return opening;
  };
  return {context:{...common.context,data:receipt?.data,attach},
    attachAll:async()=>{for(const original of receipt?.processes??[])await attach(original.name);},
    settle:async()=>{await operations.settle();processes.required();},
    close:async()=>{await common.close();await processes.close();}};
}
