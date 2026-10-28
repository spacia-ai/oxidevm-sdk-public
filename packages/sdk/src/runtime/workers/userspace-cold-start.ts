import {VMError} from "../errors.js";
import type {UserspaceWorkspaceStart} from "../protocol/workspace-start.js";
import type {UserspaceCold, NativeWorkspaceReconciled, CandidateWorkspaceExport} from "./userspace-checkpoint.js";
import {stageCandidateWorkspace} from "./userspace-snapshot-workspace.js";
import type {SnapshotStorageClient} from "./snapshot-channel.js";

type Candidate = Pick<UserspaceCold,"beginReconcile"|"exportWorkspace"|"complete"|"abort">;
export interface NativeColdRuntime {
 readonly workspaceBaseSha256:string;
 beginCold(signal:AbortSignal):Promise<Candidate>;
 reconcileCold(candidate:Candidate,sourceId:string,signal:AbortSignal):Promise<NativeWorkspaceReconciled>;
 coldPublished():void;
 coldFailed():Promise<void>;
}

/** A cold candidate has no running processes to roll back. Its sole heap is either
 * published after the durable pair, or discarded and fenced until a fresh mount. */
export async function startNativeCold(runtime:NativeColdRuntime,storage:Pick<SnapshotStorageClient,"request">,
 sourceId:string,signal:AbortSignal):Promise<UserspaceWorkspaceStart> {
 let candidate:Candidate|undefined,exported:CandidateWorkspaceExport|undefined,acknowledged=false;
 try {
  candidate=await runtime.beginCold(signal);
  const result=await runtime.reconcileCold(candidate,sourceId,signal);
  exported=candidate.exportWorkspace();
  await stageCandidateWorkspace(storage,exported,runtime.workspaceBaseSha256,result.workspaceDetails.preserved?.id,signal,sourceId);
  await storage.request({type:"publish-native-cold",sourceId},[],signal);
  // Publication is the committed outcome. Late cancellation cannot revoke it.
  exported.complete(true);acknowledged=true;
  candidate.complete();runtime.coldPublished();
  try {await storage.request({type:"complete-native-cold",sourceId});}
  catch { /* Published files/runtime are authoritative; collection may retire the remaining pins. */ }
  return result.workspaceDetails;
 } catch(error) {
  let cleanupFailed=false;
  try {if(!acknowledged)exported?.complete(false);candidate?.abort();} catch {cleanupFailed=true;}
  try {await storage.request({type:"abort"});} catch {cleanupFailed=true;}
  try {await runtime.coldFailed();} catch {cleanupFailed=true;}
  if(cleanupFailed)throw new VMError("STORAGE_ERROR","Cold workspace retirement is uncertain",{cleanupFailed:true});
  throw error;
 }
}
