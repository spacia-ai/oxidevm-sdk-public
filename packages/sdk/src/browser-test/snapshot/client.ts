import {VMError,type VM,type SnapshotInfo} from "./sdk.js";
import type {SnapshotPhase,SnapshotTimeouts} from "../../snapshot-authoring.js";
import {exactKeys,integer,record,string} from "../../runtime/decode.js";
import {decodeSnapshotRef} from "../../runtime/protocol/snapshots.js";
import {decodeSnapshotPreviewResponse,isSnapshotFailureReason,type SnapshotTransportIdentity,type SnapshotPreviewRequest} from "../../snapshot-authoring-protocol.js";
import {encodeAuthoringReceipt,readAuthoringReceipt,isAuthoringName} from "../../snapshot-authoring-receipt.js";
import {createPreparationSession,createVerificationSession,type SnapshotAuthoringRun} from "./context.js";
import {createTransport,digest} from "./transport.js";
import {assertSnapshotBrowserSupport,openSnapshotVM} from "./configuration.js";
import {authorModule,moduleURL,prepareWorkload} from "./prepare.js";
import {boundedOperation,captureWhenQuiesced} from "./readiness.js";
import {checkpointFailureSummary} from "../../runtime/protocol/checkpoint-failure.js";
import type {SnapshotCheck} from "../../image-builder/snapshot-contracts.js";
declare global {interface Window {oxidevmSnapshotPreview(request:SnapshotPreviewRequest):Promise<unknown>}}
const output=document.createElement("pre");output.id="oxidevm-snapshot";document.body.append(output);
let vm:VM|undefined,closeSession:(()=>Promise<void>)|undefined,phase:SnapshotPhase="validate",failureCheck:SnapshotCheck="browser-features";
const signal=new AbortController().signal;
async function run():Promise<unknown> {
  const raw:unknown=await (await fetch("/fixture.json",{cache:"no-store"})).json();
  const config=record(raw,"snapshot configuration");
  exactKeys(config,["version","action","identity","mode","name","label","image","vm","timeouts","files","workload","verify"],["shipped","expectedSnapshot","receiptSHA256"]);
  if(config["version"]!==1||config["action"]!=="prepare"&&config["action"]!=="verify")throw new VMError("PROTOCOL_ERROR","Snapshot action is invalid");
  const action=config["action"],mode=config["mode"];if(mode!=="system"&&mode!=="userspace")throw new VMError("PROTOCOL_ERROR","Snapshot mode is invalid");
  const identity=record(config["identity"],"authoring identity");exactKeys(identity,["version","buildId","token"]);
  if(identity["version"]!==1)throw new VMError("PROTOCOL_ERROR","Authoring identity is invalid");
  const transportIdentity:SnapshotTransportIdentity={version:1,buildId:string(identity["buildId"],"build id"),token:string(identity["token"],"build token")};
  const transport=createTransport(transportIdentity);
  const timeoutValue=record(config["timeouts"],"authoring timeouts");exactKeys(timeoutValue,["buildMs","commandMs","readyMs","captureMs","verifyMs"]);
  const timeouts:Required<SnapshotTimeouts>={buildMs:integer(timeoutValue["buildMs"],"build deadline",1,2_147_483_647),
    commandMs:integer(timeoutValue["commandMs"],"command deadline",1,2_147_483_647),readyMs:integer(timeoutValue["readyMs"],"ready deadline",1,2_147_483_647),
    captureMs:integer(timeoutValue["captureMs"],"capture deadline",1,2_147_483_647),verifyMs:integer(timeoutValue["verifyMs"],"verification deadline",1,2_147_483_647)};
  const authoring:SnapshotAuthoringRun={signal,timeouts,
    onPhase:value=>{phase=value;void transport.post({type:"progress",phase:value});},
    log:(level,message)=>{void transport.post({type:"log",level,message});},
    requestPreview:async(request,signal)=>{if(signal.aborted)throw new VMError("ABORTED","HTTP verification was cancelled");return decodeSnapshotPreviewResponse(await window.oxidevmSnapshotPreview(request));}};
  assertSnapshotBrowserSupport();
  authoring.onPhase(action==="prepare"?"start":"verify");
  // Opening and capturing a preparation VM is no verification check; only a verification resume is.
  if(action==="verify")failureCheck="shipped-resume";
  const current=await openSnapshotVM(config,mode,action,signal);vm=current;
  await current.snapshots.autoSave.configure({enabled:false});
  if(action==="verify"){
    const expected=decodeSnapshotRef(config["expectedSnapshot"]);
    if(current.start.kind!=="resumed"||current.start.snapshot.kind!=="shipped"||current.start.snapshot.ref.id!==expected.id)throw new VMError("GUEST_CRASH","Prepared snapshot did not resume",{reason:"snapshot-unexpected-cold-boot"});
    failureCheck="authoring-receipt";const receipt=readAuthoringReceipt(current.start.appData);
    const expectedReceipt=config["receiptSHA256"];
    if(expectedReceipt!==null&&expectedReceipt!==undefined&&(current.start.appData===null||await digest(current.start.appData.slice())!==expectedReceipt))throw new VMError("GUEST_CRASH","Restored authoring receipt differs from captured state",{reason:"snapshot-verify-failed"});
    const session=createVerificationSession(current,receipt,authoring);closeSession=()=>session.close();
    failureCheck="original-processes";await session.attachAll();failureCheck="custom-verification";
    const verifier:unknown=await import(moduleURL(config["verify"]));
    const result:unknown=await authorModule(verifier)(session.context);
    if(result!==undefined)throw new VMError("GUEST_CRASH","Verification must complete without a return value",{reason:"snapshot-verify-failed"});
    await session.settle();await transport.settle();
    return {kind:"verified",snapshot:expected,receipt:receipt!==undefined,originalProcesses:receipt?.processes.length??0};
  }
  const preparation=createPreparationSession(current,authoring);closeSession=()=>preparation.close();
  const data=await prepareWorkload(config,current,preparation.context,authoring);
  const receipt=await preparation.settle(data);authoring.onPhase("ready");authoring.onPhase("capture");
  const snapshot=await boundedOperation(preparation.context.signal,timeouts.captureMs,{},async signal=>{
    const snapshot=await preparation.guardCapture(()=>captureWhenQuiesced(()=>vmCapture(current,string(config["label"],"snapshot label"),signal),signal));
    authoring.onPhase("export");
    const exported=await current.snapshots.export(snapshot.ref,{signal});
    if(exported.kind!=="file")throw new VMError("PROTOCOL_ERROR","Snapshot export did not return its staged File");
    await transport.upload(exported.file,signal);
    return snapshot;
  },"snapshot-capture-timeout");await transport.settle();
  return {kind:"prepared",snapshot:snapshot.ref,receiptSHA256:await digest(encodeAuthoringReceipt(receipt)),imageManifestSHA256:current.image.manifestSHA256};
}
function vmCapture(owner:VM|undefined,label:string,signal:AbortSignal):Promise<SnapshotInfo> {
  if(owner===undefined)throw new VMError("PROTOCOL_ERROR","Source VM is unavailable");return owner.snapshots.capture({label,signal});
}
void run().then(result=>{output.textContent=JSON.stringify({ok:true,result});},(error:unknown)=>{
  const code=error instanceof VMError?error.code:"VM_FAULT";
  const reason=error instanceof VMError?error.detail?.["reason"]:undefined;
  const process=error instanceof VMError?error.detail?.["process"]:undefined;
  const checkpoint=error instanceof VMError?checkpointFailureSummary(error.detail):undefined;
  // SDK messages are fixed text; an author module's own error may carry author data and stays generic.
  const message=error instanceof VMError?error.message:"Snapshot browser action failed";
  output.textContent=JSON.stringify({ok:false,error:{code,message,phase,check:failureCheck,...(isSnapshotFailureReason(reason)?{reason}:{}),...(isAuthoringName(process)?{process}:{}),...(checkpoint===undefined?{}:{checkpoint})}});
}).finally(async()=>{
  try{await closeSession?.();await vm?.dispose();}
  catch{output.textContent=JSON.stringify({ok:false,error:{code:"STORAGE_ERROR",message:"Snapshot browser cleanup failed",phase,check:failureCheck}});}
  output.dataset["done"]="true";
}).catch(()=>{output.textContent=JSON.stringify({ok:false,error:{code:"VM_FAULT",message:"Snapshot browser cleanup failed",phase,check:failureCheck}});output.dataset["done"]="true";});
