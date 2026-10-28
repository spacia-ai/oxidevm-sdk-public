import {sign,verify,createPublicKey,type KeyObject} from "node:crypto";
import {exactKeys,integer,record,string} from "../runtime/decode.js";
import {VMError} from "../runtime/errors.js";
import {defineImage,decodeTrustedImageKey,type ImageLocation,type TrustedImageKey} from "../image.js";
import {decodeSHA256,type SHA256,type RuntimeMode} from "../values.js";
import {decodeSnapshotRef,type SnapshotRef} from "../runtime/protocol/snapshots.js";
import {USERSPACE_SNAPSHOT_SCHEMA} from "../runtime/workers/snapshot-manifest.js";
import {decodeShippedName} from "../runtime/managed-start.js";
import {decodeSnapshotRecipe} from "./snapshot-recipe.js";
import type {SnapshotRecipe} from "./snapshot-contracts.js";
import {decodeBundleJSON} from "./bundle-files.js";
export interface SnapshotArtifact {readonly url:string;readonly bytes:number;readonly sha256:SHA256}
export interface SnapshotBundleIndex {
  readonly format:"oxidevm-snapshot-bundle";readonly schemaVersion:2;readonly name:string;readonly mode:RuntimeMode;
  readonly publicBaseUrl:string;
  readonly source:SnapshotRef;readonly snapshot:SnapshotArtifact & {readonly downloadBytes:number};
  readonly image:ImageLocation<RuntimeMode>;readonly vm:NonNullable<SnapshotRecipe["vm"]>;
  readonly compatibility:{readonly stateSchema:2|typeof USERSPACE_SNAPSHOT_SCHEMA;readonly stateFormatVersion:number;readonly wasmAPI:number;readonly workerProtocol:number;readonly frameProtocol:number;readonly storageChannel:number};
  readonly sdkVersion:string;readonly engineReleaseId:SHA256;readonly verifier:SnapshotArtifact;
  readonly receiptSHA256:SHA256|null;readonly artifacts:readonly SnapshotArtifact[];
  readonly reports:{readonly build:SnapshotArtifact;readonly test:SnapshotArtifact};
  readonly distribution:{readonly status:"development-only"};readonly trust:TrustedImageKey;
  readonly signing:{readonly keyId:string;readonly signature:string};
}
export const MAX_SNAPSHOT_INDEX_BYTES=4*1024**2;
export function snapshotArtifactPath(value:unknown):string {
  const path=string(value,"snapshot artifact URL");
  if(path.length===0||path.length>4096||path.startsWith("/")||path.includes("\\")||path.includes("%")||path.includes("?")||path.includes("#")||path.includes(":")||path.split("/").some(part=>part===""||part==="."||part===".."))invalid();
  return path;
}
export function decodeSnapshotArtifact(value:unknown):SnapshotArtifact {
  const artifact=record(value,"snapshot artifact");exactKeys(artifact,["url","bytes","sha256"]);
  return {url:snapshotArtifactPath(artifact["url"]),bytes:integer(artifact["bytes"],"artifact bytes",0,16*1024**3),sha256:decodeSHA256(artifact["sha256"],"artifact digest")};
}
export function decodeSnapshotIndex(value:unknown):SnapshotBundleIndex {
  const index=record(value,"snapshot bundle index");
  exactKeys(index,["format","schemaVersion","name","mode","publicBaseUrl","source","snapshot","image","vm","compatibility","sdkVersion","engineReleaseId","verifier","receiptSHA256","artifacts","reports","distribution","trust","signing"]);
  const mode=index["mode"],name=decodeShippedName(index["name"]);
  if(index["format"]!=="oxidevm-snapshot-bundle"||index["schemaVersion"]!==2||name===undefined||mode!=="system"&&mode!=="userspace")invalid();
  const state=record(index["snapshot"],"snapshot state");exactKeys(state,["url","bytes","sha256","downloadBytes"]);
  const snapshot={...decodeSnapshotArtifact({url:state["url"],bytes:state["bytes"],sha256:state["sha256"]}),downloadBytes:integer(state["downloadBytes"],"download bytes",integer(state["bytes"],"manifest bytes",1,4*1024**2+1024),16*1024**3)};
  if(snapshot.url!=="snapshot/manifest.json")invalid();
  const location=record(index["image"],"original image");exactKeys(location,["mode","manifestUrl","manifestSHA256","trust"]);
  if(location["mode"]!==mode)invalid();
  const ref=defineImage({mode,manifestUrl:string(location["manifestUrl"],"original image URL"),manifestSHA256:string(location["manifestSHA256"],"image digest"),trust:decodeTrustedImageKey(location["trust"])});
  const image:ImageLocation<RuntimeMode>={mode:ref.mode,manifestUrl:ref.manifestUrl,manifestSHA256:ref.manifestSHA256,trust:ref.trust};
  const recipe=decodeSnapshotRecipe({name,mode,image:"default",workload:{module:"prepare.ts"},verify:{module:"verify.ts"},vm:index["vm"],publicBaseUrl:index["publicBaseUrl"]});
  const vm=recipe.vm;if(vm===undefined||vm.memoryMiB===undefined)invalid();
  const identity=record(index["compatibility"],"snapshot compatibility");
  exactKeys(identity,["stateSchema","stateFormatVersion","wasmAPI","workerProtocol","frameProtocol","storageChannel"]);
  const stateSchema=mode==="system"?2:USERSPACE_SNAPSHOT_SCHEMA;if(identity["stateSchema"]!==stateSchema)invalid();
  const reports=record(index["reports"],"bound reports");exactKeys(reports,["build","test"]);
  const distribution=record(index["distribution"],"snapshot distribution");exactKeys(distribution,["status"]);if(distribution["status"]!=="development-only")invalid();
  const signing=record(index["signing"],"snapshot signing");exactKeys(signing,["keyId","signature"]);
  const trust=decodeTrustedImageKey(index["trust"]),keyId=string(signing["keyId"],"signing key id"),signature=string(signing["signature"],"signature");
  if(keyId!==trust.keyId||signature!==""&&!/^[A-Za-z0-9_-]{86}$/u.test(signature))invalid();
  if(!Array.isArray(index["artifacts"])||index["artifacts"].length>65_536)invalid();
  const artifacts=Array.from<unknown>(index["artifacts"]).map(decodeSnapshotArtifact),paths=new Set<string>();
  for(const artifact of artifacts){if(!artifact.url.startsWith("image/")&& !artifact.url.startsWith("snapshot/chunks/")||paths.has(artifact.url))invalid();paths.add(artifact.url);}
  const verifier=decodeSnapshotArtifact(index["verifier"]),build=decodeSnapshotArtifact(reports["build"]),test=decodeSnapshotArtifact(reports["test"]);
  if(verifier.url!=="verification/verify.mjs"||verifier.bytes>16*1024**2||build.url!=="reports/build.json"||test.url!=="reports/test.json"||build.bytes>1024**2||test.bytes>1024**2)invalid();
  return {format:"oxidevm-snapshot-bundle",schemaVersion:2,name,mode,publicBaseUrl:recipe.publicBaseUrl??"/",source:decodeSnapshotRef(index["source"]),snapshot,image,vm,
    compatibility:{stateSchema,stateFormatVersion:integer(identity["stateFormatVersion"],"state format",1),wasmAPI:integer(identity["wasmAPI"],"Wasm API",1),
      workerProtocol:integer(identity["workerProtocol"],"worker protocol",1),frameProtocol:integer(identity["frameProtocol"],"frame protocol",1),storageChannel:integer(identity["storageChannel"],"storage channel",1)},
    sdkVersion:string(index["sdkVersion"],"SDK version"),engineReleaseId:decodeSHA256(index["engineReleaseId"],"engine release"),verifier,
    receiptSHA256:index["receiptSHA256"]===null?null:decodeSHA256(index["receiptSHA256"],"receipt digest"),artifacts,
    reports:{build,test},distribution:{status:"development-only"},trust,signing:{keyId,signature}};
}
function encoded(index:SnapshotBundleIndex):Uint8Array<ArrayBuffer> {
  const bytes=new TextEncoder().encode(JSON.stringify(index));if(bytes.length>MAX_SNAPSHOT_INDEX_BYTES)invalid();return bytes;
}
export function encodeSnapshotIndex(index:SnapshotBundleIndex,key:KeyObject):Uint8Array<ArrayBuffer> {
  const body=decodeSnapshotIndex({...index,signing:{keyId:index.trust.keyId,signature:""}});
  const signature=sign(null,encoded(body),key).toString("base64url");
  return encoded({...body,signing:{...body.signing,signature}});
}
export function verifySnapshotIndex(bytes:Uint8Array<ArrayBuffer>,anchor?:TrustedImageKey):SnapshotBundleIndex {
  if(bytes.length>MAX_SNAPSHOT_INDEX_BYTES)invalid();
  const index=decodeSnapshotIndex(decodeBundleJSON(bytes)),trust=anchor===undefined?index.trust:decodeTrustedImageKey(anchor);
  if(trust.keyId!==index.signing.keyId||trust.publicKey!==index.trust.publicKey||index.signing.signature==="")throw new VMError("PERMISSION_DENIED","Snapshot bundle trust differs from its author");
  const key=createPublicKey({key:Buffer.from(trust.publicKey,"base64"),format:"der",type:"spki"});
  if(!verify(null,encoded({...index,signing:{...index.signing,signature:""}}),key,Buffer.from(index.signing.signature,"base64url")))throw new VMError("PERMISSION_DENIED","Snapshot bundle signature is invalid");
  return index;
}
function invalid():never {throw new VMError("PROTOCOL_ERROR","Snapshot bundle index is invalid");}
