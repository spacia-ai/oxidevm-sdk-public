import {lstat,readdir} from "node:fs/promises";
import {join} from "node:path";
import {imagePublicKeyBytes,type TrustedImageKey} from "../image.js";
import {decodeSHA256} from "../values.js";
import {VMError} from "../runtime/errors.js";
import {verifyShippedManifest,type ShippedManifest} from "../runtime/workers/snapshot-archive/shipped.js";
import {gunzipExact} from "../runtime/workers/snapshot-archive/gzip.js";
import {MAX_STORED_OVERHEAD_BYTES} from "../runtime/workers/snapshot-archive/manifest.js";
import {MAX_BACKUP_MANIFEST_BYTES} from "../runtime/workers/snapshot-archive/manifest.js";
import {rebuildChunk,type ShippedImageRange} from "../runtime/workers/snapshot-archive/shipped-transport.js";
import {SNAPSHOT_CHUNK_BYTES,USERSPACE_SNAPSHOT_SCHEMA} from "../runtime/workers/snapshot-manifest.js";
import {inspectImageFiles,type InspectedImageFiles} from "./bundle.js";
import {readBundleFile,localBundlePath} from "./bundle-files.js";
import {hash,hashFile} from "./files.js";
import {verifySnapshotIndex,MAX_SNAPSHOT_INDEX_BYTES,type SnapshotBundleIndex,type SnapshotArtifact} from "./snapshot-index.js";
import {decodeSnapshotTestReport,decodeSnapshotBuildEvidence} from "./snapshot-reports.js";
import {readAuthoringReceipt} from "../snapshot-authoring-receipt.js";
import {capturedSummary,inspectBackupFile} from "./snapshot-backup.js";
import type {InspectSnapshotOptions,SnapshotInspectResult} from "./snapshot-contracts.js";
import {abortIfRequested} from "./tools.js";
import {managedImageIdentityBytes} from "../runtime/managed-image.js";
import {snapshotReferenceSource} from "./snapshot-reference.js";
export function snapshotImageExpectation(image:InspectedImageFiles):{mode:"system"|"userspace";id:string;version:string;identity:string} {
  const manifest=image.read.manifest;
  return {mode:image.read.image.mode,id:manifest.id,version:manifest.version,identity:"entries" in manifest?manifest.rootTreeSha256:hash(managedImageIdentityBytes(image.read.manifestValue,new TextDecoder().decode(image.read.manifestBytes),manifest))};
}
export interface VerifiedSnapshotBundle {readonly index:SnapshotBundleIndex;readonly image:InspectedImageFiles;readonly shipped:ShippedManifest;readonly digest:string;readonly directory:string}
async function verifyFile(directory:string,artifact:SnapshotArtifact,signal?:AbortSignal):Promise<void> {
  const path=await localBundlePath(directory,artifact.url),metadata=await lstat(path);
  if(metadata.size!==artifact.bytes||await hashFile(path,signal)!==artifact.sha256)throw new VMError("PROTOCOL_ERROR","Snapshot artifact differs from its signed identity");
}
async function exactFiles(root:string,wanted:ReadonlySet<string>,prefix=""):Promise<void> {
  if(prefix.split("/").length>64)throw new VMError("PROTOCOL_ERROR","Snapshot tree exceeds its depth bound");
  for(const entry of await readdir(join(root,prefix),{withFileTypes:true})){
    const path=prefix+entry.name;
    if(entry.isDirectory()){
      if(![...wanted].some(file=>file.startsWith(`${path}/`)))throw new VMError("PROTOCOL_ERROR","Snapshot bundle contains an unreferenced directory");
      await exactFiles(root,wanted,`${path}/`);
    }
    else if(!entry.isFile()||!wanted.has(path))throw new VMError("PROTOCOL_ERROR","Snapshot bundle contains an unreferenced artifact");
  }
}
export async function readSnapshotBundle(directory:string,trust?:TrustedImageKey,signal?:AbortSignal):Promise<VerifiedSnapshotBundle> {
  abortIfRequested(signal);
  const bytes=await readBundleFile(directory,"snapshot.lock.json",MAX_SNAPSHOT_INDEX_BYTES,signal),index=verifySnapshotIndex(bytes,trust);
  const image=await inspectImageFiles(join(directory,"image"),{trust:index.image.trust,...(signal===undefined?{}:{signal})});
  if(image.read.image.mode!==index.mode||image.read.image.manifestSHA256!==index.image.manifestSHA256)throw new VMError("PROTOCOL_ERROR","A-signed image differs from the B-endorsed dependency");
  const imageArtifacts=index.artifacts.filter(artifact=>artifact.url.startsWith("image/"));
  if(imageArtifacts.length!==image.files.length)throw new VMError("PROTOCOL_ERROR","Image inventory is incomplete");
  for(const file of image.files){
    const listed=imageArtifacts.find(artifact=>artifact.url===`image/${file.relative}`);
    if(listed?.bytes!==file.bytes||listed.sha256!==file.sha256)throw new VMError("PROTOCOL_ERROR","Image inventory differs from its original closure");
  }
  const shipped=await readSnapshotState(directory,index,image,signal);
  for(const artifact of [index.verifier,index.reports.build,index.reports.test])await verifyFile(directory,artifact,signal);
  const report=decodeSnapshotTestReport(JSON.parse(new TextDecoder().decode(await readBundleFile(directory,index.reports.test.url,1024**2,signal))) as unknown);
  const evidence=decodeSnapshotBuildEvidence(JSON.parse(new TextDecoder().decode(await readBundleFile(directory,index.reports.build.url,1024**2,signal))) as unknown);
  if(evidence.verificationSHA256!==index.reports.test.sha256)throw new VMError("PROTOCOL_ERROR","Build evidence differs from the bound verification");
  if(report.bundleSHA256!==null||report.result!=="passed"||report.name!==index.name||report.mode!==index.mode||report.sdkVersion!==index.sdkVersion||report.engineReleaseId!==index.engineReleaseId||report.verifier.sha256!==index.verifier.sha256
    ||report.snapshot.id!==index.source.id||report.snapshotManifestSHA256!==index.snapshot.sha256||report.imageManifestSHA256!==index.image.manifestSHA256)throw new VMError("PROTOCOL_ERROR","Bound verification report differs from its bundle");
  const wanted=new Set(["snapshot.lock.json",`${index.name}.snapshot.ts`,index.snapshot.url,index.verifier.url,index.reports.build.url,index.reports.test.url,...index.artifacts.map(artifact=>artifact.url)]);
  await exactFiles(directory,wanted);
  if(new TextDecoder().decode(await readBundleFile(directory,`${index.name}.snapshot.ts`,64*1024,signal))!==snapshotReferenceSource(index))throw new VMError("PROTOCOL_ERROR","Generated SDK options differ from their signed source");
  return {index,image,shipped,digest:hash(bytes),directory};
}
export async function readSnapshotState(directory:string,index:SnapshotBundleIndex,image:InspectedImageFiles,signal?:AbortSignal):Promise<ShippedManifest> {
  const manifest=await readBundleFile(directory,index.snapshot.url,MAX_BACKUP_MANIFEST_BYTES,signal);
  if(manifest.length!==index.snapshot.bytes||hash(manifest)!==index.snapshot.sha256)throw new VMError("PROTOCOL_ERROR","Snapshot state digest differs");
  const shipped=await verifyShippedManifest(manifest,{name:index.name,trusted:{keyId:index.trust.keyId,publicKey:imagePublicKeyBytes(index.trust)},image:snapshotImageExpectation(image),nowUnixMs:Date.now()});
  if(shipped.snapshot.id!==index.source.id||shipped.snapshot.createdAt!==index.source.createdAt)throw new VMError("PROTOCOL_ERROR","Captured source identity differs");
  const summary=capturedSummary(shipped.snapshot);
  if(shipped.snapshot.schema===USERSPACE_SNAPSHOT_SCHEMA&&shipped.snapshot.rootfs.manifest.sha256!==index.image.manifestSHA256)throw new VMError("PROTOCOL_ERROR","Native state does not retain the original image manifest");
  if(index.compatibility.stateSchema!==shipped.snapshot.schema||index.compatibility.stateFormatVersion!==summary.stateFormatVersion
    ||shipped.snapshot.schema===USERSPACE_SNAPSHOT_SCHEMA&&index.compatibility.wasmAPI!==shipped.snapshot.compatibility.abiVersion)throw new VMError("PROTOCOL_ERROR","State compatibility differs from the captured archive");
  if(index.vm.memoryMiB!==summary.memoryMiB||("vcpus" in index.vm?index.vm.vcpus??1:1)!==summary.vcpus)throw new VMError("PROTOCOL_ERROR","Captured geometry differs from its admission");
  const chunks=index.artifacts.filter(artifact=>artifact.url.startsWith("snapshot/chunks/"));
  if(chunks.length!==shipped.objects.length)throw new VMError("PROTOCOL_ERROR","Snapshot object inventory differs");
  let download=manifest.length,receiptSHA256:string|null=null;
  for(const ref of shipped.objects){
    abortIfRequested(signal);const artifact=chunks.find(artifact=>artifact.url===`snapshot/chunks/${ref.sha256}.gz`);
    if(artifact===undefined||artifact.bytes>ref.bytes+MAX_STORED_OVERHEAD_BYTES)throw new VMError("PROTOCOL_ERROR","Snapshot chunk is missing or exceeds its bound");
    await verifyFile(directory,artifact,signal);
    const decoded=await gunzipExact(await readBundleFile(directory,artifact.url,artifact.bytes,signal),ref.bytes);
    if(hash(decoded)!==ref.sha256)throw new VMError("PROTOCOL_ERROR","Snapshot decoded object differs");
    if(ref.sha256===shipped.snapshot.host?.appData?.sha256&&readAuthoringReceipt(decoded)!==undefined)receiptSHA256=hash(decoded);
    download+=artifact.bytes;
  }
  if(download!==index.snapshot.downloadBytes)throw new VMError("PROTOCOL_ERROR","Snapshot download geometry differs");
  if(shipped.transport!==undefined)await verifyTransportedPayloads(directory,shipped,image,signal);
  if(receiptSHA256!==index.receiptSHA256)throw new VMError("PROTOCOL_ERROR","Authoring receipt differs from its signed identity");
  return shipped;
}
/** Rebuilds every payload chunk of a start that leaves image files out, as an installer will. */
async function verifyTransportedPayloads(directory:string,shipped:ShippedManifest,image:InspectedImageFiles,signal?:AbortSignal):Promise<void> {
  const transport=shipped.transport;
  if(transport===undefined||shipped.snapshot.schema!==USERSPACE_SNAPSHOT_SCHEMA)return;
  const literal=new Map<number,Uint8Array>();
  const literalChunk=async(index:number):Promise<Uint8Array>=>{
    const cached=literal.get(index);if(cached!==undefined)return cached;
    const ref=transport.literal.chunks[index];if(ref===undefined)throw new VMError("PROTOCOL_ERROR","Snapshot literal stream is short");
    const bytes=await gunzipExact(await readBundleFile(directory,`snapshot/chunks/${ref.sha256}.gz`,ref.bytes+MAX_STORED_OVERHEAD_BYTES,signal),ref.bytes);
    literal.clear();literal.set(index,bytes);return bytes;
  };
  const readLiteral=async(offset:number,length:number):Promise<Uint8Array>=>{
    const output=new Uint8Array(length);
    for(let done=0;done<length;){
      const at=offset+done,chunk=await literalChunk(Math.floor(at/SNAPSHOT_CHUNK_BYTES)),from=at%SNAPSHOT_CHUNK_BYTES,piece=chunk.subarray(from,Math.min(chunk.length,from+length-done));
      if(piece.length===0)throw new VMError("PROTOCOL_ERROR","Snapshot literal stream is short");
      output.set(piece,done);done+=piece.length;
    }
    return output;
  };
  let cached:{readonly sha256:string;readonly bytes:Uint8Array}|undefined;
  const readImage=async(range:ShippedImageRange,offset:number,length:number):Promise<Uint8Array>=>{
    if(cached?.sha256!==range.sha256){
      const file=image.files.find(candidate=>candidate.sha256===range.sha256&&candidate.bytes===range.bytes&&candidate.relative.startsWith("blobs/"));
      if(file===undefined)throw new VMError("PROTOCOL_ERROR","Snapshot names an image file the image does not hold");
      cached={sha256:range.sha256,bytes:await readBundleFile(join(directory,"image"),file.relative,file.bytes,signal)};
    }
    return cached.bytes.subarray(offset,offset+length);
  };
  for(const chunk of shipped.snapshot.payloads.chunks){
    abortIfRequested(signal);
    if(hash(await rebuildChunk(chunk,transport,readLiteral,readImage))!==chunk.sha256)throw new VMError("PROTOCOL_ERROR","Snapshot payload does not rebuild from its image files");
  }
}
export async function inspectSnapshot(path:string,options:InspectSnapshotOptions={}):Promise<SnapshotInspectResult> {
  const info=await lstat(path);
  if(info.isSymbolicLink())throw new VMError("INVALID_ARGUMENT","Snapshot input must not be a symlink");
  if(info.isFile()){
    const backup=await inspectBackupFile(path,options.signal);
    return {kind:"backup",integrity:"verified",snapshot:capturedSummary(backup.manifest),fileBytes:backup.bytes,authentication:{kind:"unsigned"}};
  }
  const bundle=await readSnapshotBundle(path,options.trust,options.signal),index=bundle.index;
  const indexBytes=(await lstat(join(path,"snapshot.lock.json"))).size,referenceBytes=new TextEncoder().encode(snapshotReferenceSource(index)).length;
  return {kind:"bundle",integrity:"verified",snapshot:capturedSummary(bundle.shipped.snapshot),name:index.name,bundleSHA256:decodeSHA256(bundle.digest,"bundle digest"),
    snapshotManifestSHA256:index.snapshot.sha256,imageManifestSHA256:decodeSHA256(index.image.manifestSHA256,"image digest"),sdkVersion:index.sdkVersion,engineReleaseId:index.engineReleaseId,
    verifierSHA256:index.verifier.sha256,artifactCount:index.artifacts.length+6,artifactBytes:index.artifacts.reduce((sum,artifact)=>sum+artifact.bytes,0)+index.snapshot.bytes+index.verifier.bytes+index.reports.build.bytes+index.reports.test.bytes+indexBytes+referenceBytes,
    distribution:{status:"development-only"},authentication:options.trust===undefined?{kind:"unverified"}:{kind:"verified",keyId:options.trust.keyId}};
}
