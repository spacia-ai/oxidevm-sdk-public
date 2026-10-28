import {exactKeys,record} from "../decode.js";
import {VMError} from "../errors.js";
import {decodeShippedInstallIdentity,type ShippedInstallIdentity} from "./shipped-source.js";
export type InitialStartState = {readonly kind:"empty"} | {readonly kind:"pending";readonly source:ShippedInstallIdentity} | {readonly kind:"existing"};
export function decodeInitialStartState(value:unknown):InitialStartState {
  const state=record(value,"initial start state");
  if(state["kind"] === "pending") {exactKeys(state,["kind","source"]);return {kind:"pending",source:decodeShippedInstallIdentity(state["source"])};}
  exactKeys(state,["kind"]);
  if(state["kind"] !== "empty" && state["kind"] !== "existing") throw new VMError("PROTOCOL_ERROR","initial start state is invalid");
  return {kind:state["kind"]};
}
