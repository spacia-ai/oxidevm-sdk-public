import {loadPinnedImage} from "./managed-image-pins.js";
import type {ManagedImageRef} from "./managed-disk-head.js";
import {verifyManagedImageManifest} from "../managed-image.js";
import type {ImageTrust} from "../image-provenance.js";
import type {CurrentSystemImage} from "../protocol/current-system-image.js";
import {sha256Hex} from "./snapshot-content.js";
import {decodeSHA256} from "../../values.js";
import {VMError} from "../errors.js";
/** The active disk ref locates its signed source; this lookup never opens or switches disks. */
export async function currentSystemImage(images:FileSystemDirectoryHandle,ref:ManagedImageRef,trusted?:ImageTrust,requested?:{readonly id:string;readonly version:string}):Promise<CurrentSystemImage> {
 const source=await loadPinnedImage(images,ref.identity);
 if(source===undefined||source.ref.id!==ref.id||source.ref.version!==ref.version)throw new VMError("STORAGE_NOT_FOUND","Active system image source is not retained");
 const manifest=source.manifest;
 if(trusted!==undefined)await verifyManagedImageManifest(manifest,trusted);
 return {id:manifest.id,version:manifest.version,runtimes:manifest.runtimes,...(trusted===undefined||manifest.schemaVersion!==9?{}:{identity:{id:manifest.id,version:manifest.version,mode:"system",cpuProfile:manifest.cpuProfile,keyId:trusted.keyId,signatureVerified:true,manifestSHA256:decodeSHA256(await sha256Hex(new TextEncoder().encode(source.manifestText)),"actual signed manifest")}}),...(manifest.workspaceBaseSha256===undefined?{}:{workspaceBaseSha256:manifest.workspaceBaseSha256}),...(requested===undefined||requested.id===manifest.id&&requested.version===manifest.version?{}:{update:{...requested}})};
}
