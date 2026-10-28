import type {WorkspaceHandoffResult,WorkspaceMovedAway} from "../../contracts.js";
import {boolean,exactKeys,record} from "../../runtime/decode.js";
import {decodeSerializedError,deserializeError,serializeUnknownError,VMError} from "../../runtime/errors.js";
export function decodeHandoffResult(value:unknown):WorkspaceHandoffResult {
  if(value!=="released"&&value!=="no-response") throw new VMError("PROTOCOL_ERROR","workspace handoff result is invalid");
  return value;
}
export function encodeMovedAway(value:WorkspaceMovedAway):unknown {
  return {saved:value.saved,...(value.error===undefined?{}:{error:serializeUnknownError(value.error)})};
}
export function decodeMovedAway(value:unknown):WorkspaceMovedAway {
  const input=record(value,"workspace moved away");exactKeys(input,["saved"],["error"]);
  return {saved:boolean(input["saved"],"workspace saved"),...(input["error"]===undefined?{}:{error:deserializeError(decodeSerializedError(input["error"]))})};
}
