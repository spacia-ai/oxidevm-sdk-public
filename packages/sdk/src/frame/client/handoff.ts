import type {WorkspaceHandoffOptions,WorkspaceHandoffResult} from "../../contracts.js";
import {VMError} from "../../runtime/errors.js";
import {decodeHandoffResult} from "../protocol/handoff.js";
import {FrameChannel} from "./channel.js";
import {mountRuntimeFrame} from "./iframe.js";
export async function requestFrameHandoff(origin:string,workspaceId:string,options:WorkspaceHandoffOptions):Promise<WorkspaceHandoffResult> {
  if(!globalThis.crossOriginIsolated) throw new VMError("FEATURE_NOT_AVAILABLE","workspace handoff needs a cross-origin isolated runtime frame",{reason:"browser-unsupported",requirement:"cross-origin-isolation"});
  const frame=await mountRuntimeFrame(origin,options.signal);
  try {return await handoffOverPort(frame.port,workspaceId,options);} finally {frame.remove();}
}
export async function handoffOverPort(port:MessagePort,workspaceId:string,options:Pick<WorkspaceHandoffOptions,"timeoutMs"|"signal">={}):Promise<WorkspaceHandoffResult> {
  const channel=new FrameChannel(port);
  try {return await channel.request({type:"workspace-handoff",workspaceId,...(options.timeoutMs===undefined?{}:{timeoutMs:options.timeoutMs})},{decode:decodeHandoffResult,signal:options.signal});}
  finally {channel.close();}
}
