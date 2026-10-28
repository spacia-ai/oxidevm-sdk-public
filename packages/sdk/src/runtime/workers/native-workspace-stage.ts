import {normalizeStorageError,serializeUnknownError} from "../errors.js";
import type {WorkspacePublication,WorkspacePublicationResult} from "../protocol/workspace-publication.js";
import type {PreparedNativeFiles} from "./snapshot-userspace-files.js";
import {receivePublication} from "./workspace-publication.js";
/** Retire every producer before replying. The running pair changes only at later native publish. */
export async function stageNativeWorkspace(files:()=>PreparedNativeFiles,input:WorkspacePublication,signal:AbortSignal):Promise<WorkspacePublicationResult> {
 let opened:Awaited<ReturnType<typeof receivePublication>>|undefined;
 let outcome:WorkspacePublicationResult["outcome"];
 try {
  opened=await receivePublication(input,signal);
  const generation=await files().stageWorkspace(input.workspaceBaseSha256,opened.streams,signal);
  outcome={kind:"committed",generation};
 }catch(error){outcome={kind:"failed",error:serializeUnknownError(normalizeStorageError(error))};}
 try {
  if(opened===undefined)return {retired:false,outcome};
  await opened.retire();return {retired:true,credit:{...input.credit,kind:"return"},outcome};
 }catch(error){const failure=serializeUnknownError(normalizeStorageError(error));return {retired:false,outcome:{kind:"failed",error:{...failure,detail:{...failure.detail,cleanupFailed:true}}}};}
}
