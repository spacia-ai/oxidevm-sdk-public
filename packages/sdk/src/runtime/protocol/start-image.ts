import {managedImageUrl} from "../managed-image.js";
//! Verified retained image selection before a runtime takes its workspace lease.
import { decodeImageInfo } from "../../image.js";
import type { ManagedResume } from "../snapshot-types.js";
import type { RuntimeMode } from "../../values.js";
import { decodeSHA256 } from "../../values.js";
import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeSnapshotRef } from "./snapshots.js";
import type { PreparedImageIdentity } from "./storage.js";

export interface InspectStartImageRequest {
  readonly workspaceId:string; readonly mode:RuntimeMode; readonly resume:ManagedResume;
  readonly manifestUrl:string; readonly manifestSHA256:string;
  readonly trustedKeyId:string; readonly trustedPublicKey:Uint8Array;
}
export interface PreparedStartImage {
  readonly image:PreparedImageIdentity; readonly manifestUrl:string; readonly memoryMiB:number;
  readonly vcpus?:1|2|3|4; readonly maxProcesses?:number;
  readonly update?:{readonly id:string;readonly version:string};
}
export function decodeManagedResume(value:unknown):ManagedResume {
  if(value==="none"||value==="latest"||value==="pre-resume"||value==="fresh-image"||value==="update-image") return value;
  return decodeSnapshotRef(value);
}
export function decodePreparedStartImage(value:unknown):PreparedStartImage|null {
  if(value===null) return null;
  const input=record(value,"retained start image");
  exactKeys(input,["image","manifestUrl","memoryMiB"],["vcpus","maxProcesses","update"]);
  const image=decodeImageInfo(input["image"]);
  const vcpus=input["vcpus"];
  if(vcpus!==undefined&&vcpus!==1&&vcpus!==2&&vcpus!==3&&vcpus!==4) throw new VMError("PROTOCOL_ERROR","retained image vCPUs are invalid");
  if(image.mode==="userspace"&&vcpus!==undefined||image.mode==="system"&&input["maxProcesses"]!==undefined) throw new VMError("PROTOCOL_ERROR","retained defaults do not match mode");
  const update=input["update"]===undefined?undefined:record(input["update"],"retained image update");
  if(update!==undefined) exactKeys(update,["id","version"]);
  return {image,manifestUrl:managedImageUrl(string(input["manifestUrl"],"retained manifest URL")).href,memoryMiB:integer(input["memoryMiB"],"retained image memory",64,3072),
    ...(vcpus===undefined?{}:{vcpus}),...(input["maxProcesses"]===undefined?{}:{maxProcesses:integer(input["maxProcesses"],"retained process limit",1,64)}),
    ...(update===undefined?{}:{update:{id:string(update["id"],"update image id"),version:string(update["version"],"update image version")}})};
}
export function decodeInspectStartImageFields(input:Readonly<Record<string,unknown>>):InspectStartImageRequest {
  const mode=input["mode"],key=input["trustedPublicKey"];
  if(mode!=="system"&&mode!=="userspace"||!(key instanceof Uint8Array)||key.byteLength!==32) throw new VMError("PROTOCOL_ERROR","retained image trust or mode is invalid");
  return {workspaceId:string(input["workspaceId"],"workspaceId"),mode,resume:decodeManagedResume(input["resume"]),manifestUrl:managedImageUrl(string(input["manifestUrl"],"manifestUrl")).href,manifestSHA256:decodeSHA256(input["manifestSHA256"],"manifestSHA256"),trustedKeyId:boundedKeyId(input["trustedKeyId"]),trustedPublicKey:key.slice()};
}

function boundedKeyId(value:unknown):string {
 const key=string(value,"trustedKeyId");if(key.length===0||key.length>128||key.includes("\0")) throw new VMError("PROTOCOL_ERROR","retained trust key ID is invalid");return key;
}
