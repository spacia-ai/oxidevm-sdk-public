import {decodeBytes} from "./decoders.js";
import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeAssistanceBinding, type AssistanceBinding } from "./assistance.js";
import { publicationCredit } from "./workspace-publication.js";
import type { AssistanceCredit } from "./assistance-credit.js";

export type WorkspaceReadKind = "snapshot" | "delta" | "dependencies";
export interface WorkspaceReadIdentity extends AssistanceBinding { readonly transfer: number }
export interface WorkspaceReadRequest { readonly workspaceBaseSha256: string; readonly credit: AssistanceCredit;readonly selection?:{readonly kind:"retained";readonly id:string;readonly allowDifferentBase?:true}|{readonly kind:"rootfs";readonly path:string;readonly sha256:string;readonly bytes:number;readonly snapshotId?:string}|{readonly kind:"workspace-base-file";readonly path:string;readonly sha256:string;readonly bytes:number} }
export interface WorkspaceReadSelection<Stream> {
  readonly generation: number;
  readonly workspaceBaseSha256?:string;
  readonly snapshot?: Stream;
  readonly delta?: Stream;
  readonly dependencies?: { readonly generation: string; readonly inputsSha256: string; readonly tree: Stream };
}

export function decodeWorkspaceReadRequest(value: unknown): WorkspaceReadRequest {
  const input = record(value, "workspace read");
  exactKeys(input, ["workspaceBaseSha256", "credit"],["selection"]);
  const raw=input["selection"]===undefined?undefined:record(input["selection"],"workspace selection");
  let selection:WorkspaceReadRequest["selection"];
  if(raw!==undefined) {
    if(raw["kind"]==="retained") {exactKeys(raw,["kind","id"],["allowDifferentBase"]);if(raw["allowDifferentBase"]!==undefined&&raw["allowDifferentBase"]!==true)throw new VMError("PROTOCOL_ERROR","Different workspace base admission is invalid");const id=string(raw["id"],"retained generation");if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))throw new VMError("PROTOCOL_ERROR","Retained workspace selection is invalid");selection={kind:"retained",id,...(raw["allowDifferentBase"]===true?{allowDifferentBase:true as const}:{})};}
    else if(raw["kind"]==="rootfs"||raw["kind"]==="workspace-base-file") {
      exactKeys(raw,["kind","path","sha256","bytes"],raw["kind"]==="rootfs"?["snapshotId"]:[]);const path=string(raw["path"],"rootfs file path");
      if(!path.startsWith("/")||path.length>4096||path.includes("\0")||path.split("/").some(part=>part===".."||part==="."))throw new VMError("PROTOCOL_ERROR","Rootfs read path is invalid");
      const snapshotId=raw["snapshotId"]===undefined?undefined:string(raw["snapshotId"],"rootfs checkpoint source");
      if(snapshotId!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(snapshotId))throw new VMError("PROTOCOL_ERROR","Rootfs checkpoint source is invalid");
      const file={path,sha256:hash(raw["sha256"]),bytes:integer(raw["bytes"],"rootfs file bytes",0,8*1024**3)};
      selection=raw["kind"]==="rootfs"?{kind:"rootfs",...file,...(snapshotId===undefined?{}:{snapshotId})}:{kind:"workspace-base-file",...file};
    } else throw new VMError("PROTOCOL_ERROR","Workspace selection kind is invalid");
  }
  return { workspaceBaseSha256: hash(input["workspaceBaseSha256"]), credit: publicationCredit(input["credit"], "grant"),...(selection===undefined?{}:{selection}) };

}
export function decodeWorkspaceReadIdentity(value: unknown): WorkspaceReadIdentity {
  const input = record(value, "workspace read identity");
  exactKeys(input, ["session", "generation", "transfer"]);
  return { ...decodeAssistanceBinding({ session: input["session"], generation: input["generation"] }),
    transfer: integer(input["transfer"], "workspace read transfer", 1, 0xffff_ffff) };
}
export function decodeWorkspaceReadKind(value: unknown): WorkspaceReadKind {
  if (value !== "snapshot" && value !== "delta" && value !== "dependencies") throw new VMError("PROTOCOL_ERROR", "Invalid workspace read source");
  return value;
}
export function decodeWorkspaceReadSelection(value: unknown): WorkspaceReadSelection<number> | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "workspace read selection");
  exactKeys(input, ["generation"], ["snapshot", "delta", "dependencies", "workspaceBaseSha256"]);
  if (input["snapshot"] === undefined && input["delta"] === undefined) throw new VMError("PROTOCOL_ERROR", "Workspace read selection contains no data");
  const size = (value: unknown) => integer(value, "workspace stream bytes", 0, 1024 ** 4);
  let dependencies: WorkspaceReadSelection<number>["dependencies"];
  if (input["dependencies"] !== undefined) {
    const selected = record(input["dependencies"], "workspace dependencies");
    exactKeys(selected, ["generation", "inputsSha256", "tree"]);
    dependencies = { generation: hash(selected["generation"]), inputsSha256: hash(selected["inputsSha256"]), tree: size(selected["tree"]) };
  }
  return { generation: integer(input["generation"], "workspace generation", 1),
    ...(input["workspaceBaseSha256"]===undefined?{}:{workspaceBaseSha256:hash(input["workspaceBaseSha256"])}),
    ...(input["snapshot"] === undefined ? {} : { snapshot: size(input["snapshot"]) }),
    ...(input["delta"] === undefined ? {} : { delta: size(input["delta"]) }),
    ...(dependencies === undefined ? {} : { dependencies }) };
}
function hash(value: unknown): string {
  const result = string(value, "workspace SHA-256");
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new VMError("PROTOCOL_ERROR", "Invalid workspace SHA-256");
  return result;
}

export function decodeWorkspaceBaseMetadata(value:unknown):{readonly metadata:Uint8Array}|undefined {
 if(value===undefined)return undefined;
 const input=record(value,"workspace base metadata");exactKeys(input,["metadata"]);const metadata=decodeBytes(input["metadata"]);
 if(metadata.length>128*1024*1024)throw new VMError("PROTOCOL_ERROR","Workspace base metadata is too large");
 return {metadata};
}
