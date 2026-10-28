import {decodeSHA256} from "../../values.js";
import {record,string} from "../decode.js";
import {decodeUserspaceRootfsManifest,verifyUserspaceRootfsManifest,MAX_ROOTFS_METADATA_BYTES,type TrustedRootfsKey} from "../userspace-rootfs.js";
import {managedImageUrl} from "../managed-image.js";
import type {PreparedImageIdentity} from "../protocol/storage.js";
import {VMError} from "../errors.js";
import type {RootfsNetworkClient} from "./rootfs-network-channel.js";
import {opfsDirectory,read,write,sha256,type Backend,type Scope} from "./rootfs-store-backend.js";

/** Only metadata is fetched; failure must not prevent starting the already verified image. */
export async function requestedRootfsImage(backend:Backend,network:RootfsNetworkClient,
  request:{readonly href:string;readonly trusted:TrustedRootfsKey;readonly digest?:string},signal?:AbortSignal):Promise<{readonly id:string;readonly version:string}|undefined> {
 updateActive(signal);
 if(request.digest!==undefined) {
  const cached=await cachedRootfsImage(backend,request.href,request.trusted,request.digest);
  if(cached!==undefined)return cached;
 }
 try {
  const bounded=AbortSignal.any([AbortSignal.timeout(2_000),...(signal===undefined?[]:[signal])]);
  const url=managedImageUrl(request.href),bytes=await network.fetchManifest(url,bounded),actual=await sha256(bytes);
  if(request.digest!==undefined&&actual!==request.digest)throw new VMError("PROTOCOL_ERROR","Offered rootfs differs from its manifest pin");
  const manifest=decodeUserspaceRootfsManifest(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as unknown,url);
  await verifyUserspaceRootfsManifest(manifest,request.trusted);
  bounded.throwIfAborted();
  await write(backend,"manifests",`${actual}.json`,bytes);
  return {id:manifest.id,version:manifest.version};
 } catch {
  updateActive(signal);
  return undefined;
 }
}
function updateActive(signal?:AbortSignal):void {
 if(signal?.aborted===true)throw new VMError("ABORTED","Image update inspection was cancelled");
}

/** An update offer is signed cached metadata, never a URL-derived guess or a network fetch. */
export async function cachedRootfsImage(backend:Backend,href:string,trusted:TrustedRootfsKey,digest?:string):Promise<PreparedImageIdentity|undefined> {
 try {
  const url=managedImageUrl(href);let bytes=digest===undefined?undefined:await readRootfsCache(backend,"manifests",`${digest}.json`,MAX_ROOTFS_METADATA_BYTES);
  if(bytes===undefined) {
   const markerBytes=await readRootfsCache(backend,"root","active.json",8192);if(markerBytes===undefined)return undefined;
   const marker=record(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(markerBytes)) as unknown,"cached rootfs marker");
   if(string(marker["manifestUrl"],"cached manifest URL")!==url.href)return undefined;
   const file=string(marker["file"],"cached manifest file");if(file.includes("/")||file.includes("\\")||file.includes("\0"))return undefined;
   bytes=await readRootfsCache(backend,"manifests",file,MAX_ROOTFS_METADATA_BYTES);
  }
  if(bytes===undefined)return undefined;const actual=await sha256(bytes);if(digest!==undefined&&actual!==digest)return undefined;
  const manifest=decodeUserspaceRootfsManifest(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as unknown,url);
  if(manifest.schemaVersion<5)return undefined;
  await verifyUserspaceRootfsManifest(manifest,trusted);
  return {id:manifest.id,version:manifest.version,mode:"userspace",manifestSHA256:decodeSHA256(actual,"cached signed manifest"),cpuProfile:manifest.cpuProfile,keyId:trusted.keyId,signatureVerified:true};
 } catch {return undefined;}
}
export async function readRootfsCache(backend:Backend,scope:Scope,name:string,maximum:number):Promise<Uint8Array<ArrayBuffer>|undefined> {
 if(backend.kind==="opfs") {
  try {const file=await (await (await opfsDirectory(backend.root,scope,false)).getFileHandle(name)).getFile();return file.size>maximum?undefined:new Uint8Array(await file.arrayBuffer());}catch{return undefined;}
 }
 const bytes=await read(backend,scope,name);return bytes!==undefined&&bytes.byteLength<=maximum?bytes:undefined;
}
