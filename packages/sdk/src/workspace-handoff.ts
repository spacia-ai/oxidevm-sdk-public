import type {WorkspaceHandoffOptions,WorkspaceHandoffResult} from "./contracts.js";
import {abortIfRequested} from "./engine-assets.js";
import {exactKeys,integer,record} from "./runtime/decode.js";
import {VMError} from "./runtime/errors.js";
import {validateWorkspaceId} from "./runtime/workspace-path.js";
import {decodePublicRuntime} from "./vm-options.js";
/** Asks the holder to save and release a workspace on the selected runtime's storage origin. */
export async function requestWorkspaceHandoff(workspaceId:string,options:WorkspaceHandoffOptions={}):Promise<WorkspaceHandoffResult> {
  const input=record(options,"workspace handoff options");
  try {exactKeys(input,[],["runtime","signal","timeoutMs"]);validateWorkspaceId(workspaceId);
    if(input["timeoutMs"]!==undefined) integer(input["timeoutMs"],"handoff timeout",1,600_000);
  } catch(error) {if(error instanceof VMError&&error.code==="PROTOCOL_ERROR") throw new VMError("INVALID_ARGUMENT",error.message);throw error;}
  if(options.signal!==undefined&&!(options.signal instanceof AbortSignal)) throw new VMError("INVALID_ARGUMENT","handoff signal must be an AbortSignal");
  abortIfRequested(options.signal);
  const runtime=decodePublicRuntime(options.runtime);
  if(runtime.hosting==="frame") {
    const {requestFrameHandoff}=await import("./frame/client/handoff.js");
    return requestFrameHandoff(runtime.origin,workspaceId,options);
  }
  const owner=await import("./runtime/workspace-handoff.js");
  return owner.requestWorkspaceHandoff(workspaceId,options);
}
