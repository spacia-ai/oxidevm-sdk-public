import {decodeManagedRuntimes,type ManagedRuntimes} from "../managed-runtimes.js";
import {decodeImageInfo} from "../../image.js";
import type {PreparedImageIdentity} from "./storage.js";
import {exactKeys,record,string} from "../decode.js";
import {decodeSHA256} from "../../values.js";
import {VMError} from "../errors.js";
export interface CurrentSystemImage {readonly id:string;readonly version:string;readonly runtimes:ManagedRuntimes;readonly identity?:PreparedImageIdentity;readonly workspaceBaseSha256?:string;readonly update?:{readonly id:string;readonly version:string}}
export function decodeCurrentSystemImage(value:unknown):CurrentSystemImage {
 const input=record(value,"current system image");exactKeys(input,["id","version","runtimes"],["identity","workspaceBaseSha256","update"]);
 const id=string(input["id"],"current image ID"),version=string(input["version"],"current image version");
 const identity=input["identity"]===undefined?undefined:decodeImageInfo(input["identity"]);
 if(identity!==undefined&&(identity.mode!=="system"||identity.id!==id||identity.version!==version))throw new VMError("PROTOCOL_ERROR","Current image proof differs from its active disk");
 const update=input["update"]===undefined?undefined:record(input["update"],"current image update");if(update!==undefined)exactKeys(update,["id","version"]);
 return {id,version,runtimes:decodeManagedRuntimes(input["runtimes"]),...(identity===undefined?{}:{identity}),...(input["workspaceBaseSha256"]===undefined?{}:{workspaceBaseSha256:decodeSHA256(input["workspaceBaseSha256"],"current workspace base")}),...(update===undefined?{}:{update:{id:string(update["id"],"update image ID"),version:string(update["version"],"update image version")}})};
}
