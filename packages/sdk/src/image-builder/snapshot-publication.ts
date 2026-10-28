import {writeFile,mkdir} from "node:fs/promises";
import {join} from "node:path";
import {sign,type KeyObject} from "node:crypto";
import type {TrustedImageKey} from "../image.js";
import {imagePublicKeyBytes} from "../image.js";
import {decodeSHA256} from "../values.js";
import {PROTOCOL_VERSION} from "../runtime/protocol/common.js";
import {FRAME_PROTOCOL_VERSION} from "../frame/protocol/version.js";
import {SNAPSHOT_CHANNEL_VERSION} from "../runtime/protocol/snapshot-channel-version.js";
import {publishShippedTo} from "../runtime/workers/snapshot-archive/shipped-publish.js";
import {verifyShippedManifest} from "../runtime/workers/snapshot-archive/shipped.js";
import {USERSPACE_SNAPSHOT_SCHEMA,type SnapshotManifest} from "../runtime/workers/snapshot-manifest.js";
import {VMError} from "../runtime/errors.js";
import {readAuthoringReceipt} from "../snapshot-authoring-receipt.js";
import {inspectBackupFile,backupFileStream,capturedSummary} from "./snapshot-backup.js";
import {snapshotImageExpectation} from "./snapshot-bundle.js";
import type {InspectedImageFiles} from "./bundle.js";
import {hash,hashFile,copyVerified} from "./files.js";
import {localBundlePath,readBundleFile} from "./bundle-files.js";
import type {ResolvedSnapshotRecipe} from "./snapshot-recipe.js";
import type {CompiledSnapshotArtifact} from "./snapshot-modules.js";
import {decodeSnapshotIndex,encodeSnapshotIndex,type SnapshotArtifact,type SnapshotBundleIndex} from "./snapshot-index.js";
import {snapshotReferenceSource} from "./snapshot-reference.js";
import {getSDKRelease} from "./project.js";
import {atomicBundle} from "./atomic.js";
import {decodeSnapshotTestReport} from "./snapshot-reports.js";
import type {SnapshotTestReport,SnapshotBuildResult} from "./snapshot-contracts.js";
import {abortIfRequested} from "./tools.js";
export interface SnapshotPackageInput {
  readonly backupPath:string;readonly staging:string;readonly recipe:ResolvedSnapshotRecipe;
  readonly verifiedImage:InspectedImageFiles;readonly verifier:CompiledSnapshotArtifact;
  readonly signer:{readonly key:KeyObject;readonly trust:TrustedImageKey};readonly signal?:AbortSignal;
  readonly operation:"build"|"pack";readonly preparationSHA256?:string;
}
export interface StagedSnapshotBundle {
  readonly input:SnapshotPackageInput;readonly manifest:SnapshotManifest;
  readonly unsignedIndex:SnapshotBundleIndex;readonly backupSHA256:string;
}
function artifact(url:string,bytes:number,sha256:string):SnapshotArtifact {return {url,bytes,sha256:decodeSHA256(sha256,"artifact hash")};}
/** A Userspace image's files by hash, so the shipped start can leave out the ones its machine had loaded. */
function imageFilesOf(image:InspectedImageFiles):{readonly imageFiles?:ReadonlyMap<string,number>} {
  const manifest=image.read.manifest;
  return "entries" in manifest?{imageFiles:new Map(manifest.blobs.map(blob=>[blob.sha256,blob.bytes]))}:{};
}
export async function writeSnapshotState(input:SnapshotPackageInput):Promise<StagedSnapshotBundle> {
  const {manifest}=await inspectBackupFile(input.backupPath,input.signal),summary=capturedSummary(manifest),recipe=input.recipe;
  if(summary.mode!==recipe.mode||recipe.vm?.memoryMiB!==undefined&&recipe.vm.memoryMiB!==summary.memoryMiB
    ||recipe.mode==="system"&&recipe.vm?.vcpus!==undefined&&recipe.vm.vcpus!==summary.vcpus)throw new VMError("INVALID_ARGUMENT","Explicit snapshot geometry conflicts with the captured state");
  const artifacts:SnapshotArtifact[]=[];
  await mkdir(join(input.staging,"snapshot/chunks"),{recursive:true});await mkdir(join(input.staging,"verification"),{recursive:true});
  for(const file of input.verifiedImage.files){
    const path=`image/${file.relative}`;
    await copyVerified(await localBundlePath(input.verifiedImage.read.bundle,file.relative),join(input.staging,path),file,input.signal);
    artifacts.push(artifact(path,file.bytes,file.sha256));
  }
  const original=input.verifiedImage.read.image;
  const backup=await backupFileStream(input.backupPath,input.signal);
  const publication=await publishShippedTo(backup.stream,{name:recipe.name,label:recipe.label,image:snapshotImageExpectation(input.verifiedImage),
    signer:{keyId:input.signer.trust.keyId,publicKey:imagePublicKeyBytes(input.signer.trust),sign:bytes=>Promise.resolve(sign(null,bytes,input.signer.key).toString("base64url"))},
    nowUnixMs:Date.now(),maxDownloadBytes:recipe.maxDownloadBytes,...imageFilesOf(input.verifiedImage)},async(name,bytes)=>{
      const path=`snapshot/${name}`;await writeFile(join(input.staging,path),bytes,{flag:"wx"});artifacts.push(artifact(path,bytes.length,hash(bytes)));
    });
  await writeFile(join(input.staging,"snapshot/manifest.json"),publication.manifest,{flag:"wx"});
  const signed=await verifyShippedManifest(publication.manifest,{name:recipe.name,trusted:{keyId:input.signer.trust.keyId,publicKey:imagePublicKeyBytes(input.signer.trust)},
    image:snapshotImageExpectation(input.verifiedImage),nowUnixMs:Date.now()});
  let receiptSHA256:string|null=null;
  if(signed.snapshot.host?.appData!==undefined){
    const ref=signed.snapshot.host.appData;
    const {gunzipExact}=await import("../runtime/workers/snapshot-archive/gzip.js");
    const bytes=await gunzipExact(await readBundleFile(input.staging,`snapshot/chunks/${ref.sha256}.gz`,ref.bytes+64*1024,input.signal),ref.bytes);
    if(readAuthoringReceipt(bytes)!==undefined)receiptSHA256=hash(bytes);
  }
  await copyVerified(input.verifier.path,join(input.staging,"verification/verify.mjs"),input.verifier,input.signal);
  const network=recipe.vm?.network??{mode:"local" as const};
  const vm=recipe.mode==="system"?{memoryMiB:summary.memoryMiB,vcpus:summary.vcpus,network}
    :{memoryMiB:summary.memoryMiB,limits:recipe.vm?.limits??{maxProcesses:"entries" in input.verifiedImage.read.manifest?input.verifiedImage.read.manifest.resources?.maxProcesses??32:32},
      initialUser:recipe.vm?.initialUser??"user",rootPersistence:recipe.vm?.rootPersistence??"ephemeral",network};
  const release=getSDKRelease(),placeholder=artifact("reports/test.json",0,"0".repeat(64));
  const unsignedIndex=decodeSnapshotIndex({format:"oxidevm-snapshot-bundle",schemaVersion:2,name:recipe.name,mode:recipe.mode,publicBaseUrl:recipe.publicBaseUrl,
    source:{id:manifest.id,createdAt:manifest.createdAt},snapshot:{url:"snapshot/manifest.json",bytes:publication.manifest.length,sha256:hash(publication.manifest),downloadBytes:publication.manifest.length+publication.chunkBytes},
    image:{mode:original.mode,manifestUrl:original.manifestUrl,manifestSHA256:original.manifestSHA256,trust:original.trust},vm,
    compatibility:{stateSchema:manifest.schema,stateFormatVersion:summary.stateFormatVersion,wasmAPI:manifest.schema===USERSPACE_SNAPSHOT_SCHEMA?manifest.compatibility.abiVersion:release.engine.identities.coreApi,workerProtocol:PROTOCOL_VERSION,frameProtocol:FRAME_PROTOCOL_VERSION,storageChannel:SNAPSHOT_CHANNEL_VERSION},
    sdkVersion:release.sdkVersion,engineReleaseId:release.engineRelease.replace(/^sha256:/u,""),verifier:artifact("verification/verify.mjs",input.verifier.bytes,input.verifier.sha256),receiptSHA256,
    artifacts,reports:{build:{...placeholder,url:"reports/build.json"},test:placeholder},distribution:{status:"development-only"},trust:input.signer.trust,signing:{keyId:input.signer.trust.keyId,signature:""}});
  return {input,manifest:signed.snapshot,unsignedIndex,backupSHA256:await hashFile(input.backupPath,input.signal)};
}
export async function finalizeSnapshotBundle(staged:StagedSnapshotBundle,report:SnapshotTestReport,signal?:AbortSignal):Promise<SnapshotBuildResult> {
  report=decodeSnapshotTestReport(report);
  if(report.result!=="passed"||report.bundleSHA256!==null||report.snapshot.id!==staged.manifest.id||report.snapshotManifestSHA256!==staged.unsignedIndex.snapshot.sha256){
    const failed=report.checks.find(check=>check.status==="failed");
    throw new VMError("GUEST_CRASH",`Snapshot verification did not pass${failed?.status==="failed"?`: ${failed.message}`:""}`,{reason:"snapshot-verify-failed",
      ...(failed?.status==="failed"?{check:failed.check,browserMessage:failed.message}:{})});
  }
  const testBytes=new TextEncoder().encode(JSON.stringify(report)),buildBytes=new TextEncoder().encode(JSON.stringify({
    format:"oxidevm-snapshot-build",schemaVersion:1,bundleSHA256:null,operation:staged.input.operation,backupSHA256:staged.backupSHA256,
    preparationSHA256:staged.input.preparationSHA256??null,files:staged.input.operation==="pack"?[]:staged.input.recipe.stagedFiles.map(file=>({to:file.to,bytes:file.bytes,sha256:file.sha256})),verificationSHA256:hash(testBytes),
  }));
  abortIfRequested(signal);await mkdir(join(staged.input.staging,"reports"),{recursive:true});
  await writeFile(join(staged.input.staging,"reports/test.json"),testBytes,{flag:"wx"});await writeFile(join(staged.input.staging,"reports/build.json"),buildBytes,{flag:"wx"});
  const index={...staged.unsignedIndex,reports:{test:artifact("reports/test.json",testBytes.length,hash(testBytes)),build:artifact("reports/build.json",buildBytes.length,hash(buildBytes))}};
  const bytes=encodeSnapshotIndex(index,staged.input.signer.key);
  await writeFile(join(staged.input.staging,"snapshot.lock.json"),bytes,{flag:"wx"});
  await writeFile(join(staged.input.staging,`${index.name}.snapshot.ts`),snapshotReferenceSource(index),{flag:"wx"});
  const out=staged.input.recipe.outDir;
  return {name:index.name,mode:index.mode,bundlePath:out,referencePath:join(out,`${index.name}.snapshot.ts`),bundleSHA256:decodeSHA256(hash(bytes),"bundle digest"),
    snapshotManifestSHA256:index.snapshot.sha256,imageManifestSHA256:decodeSHA256(index.image.manifestSHA256,"image hash"),snapshot:{id:index.source.id,kind:"shipped"},sdkVersion:index.sdkVersion,engineReleaseId:index.engineReleaseId,
    verification:{status:"passed",browser:report.browser.name,browserVersion:report.browser.version,resume:"shipped"},distribution:{status:"development-only"}};
}
export function withSnapshotPublication<T>(out:string,signal:AbortSignal|undefined,publish:(staging:string)=>Promise<T>):Promise<T> {return atomicBundle(out,publish,signal);}
