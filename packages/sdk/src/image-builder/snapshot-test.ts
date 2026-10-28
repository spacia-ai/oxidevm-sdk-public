import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {VMError} from "../runtime/errors.js";
import {decodeSHA256} from "../values.js";
import {decodeTrustedImageKey} from "../image.js";
import type {TestSnapshotOptions,SnapshotTestReport} from "./snapshot-contracts.js";
import {snapshotBrowser,snapshotTimer,SNAPSHOT_DEFAULT_TIMEOUTS} from "./snapshot-recipe.js";
import {readSnapshotBundle,readSnapshotState} from "./snapshot-bundle.js";
import {decodeSnapshotTestReport} from "./snapshot-reports.js";
import {getSDKRelease} from "./project.js";
import type {SnapshotBundleIndex} from "./snapshot-index.js";
import type {InspectedImageFiles} from "./bundle.js";
import {inspectImageFiles} from "./bundle.js";
import type {StagedSnapshotBundle} from "./snapshot-publication.js";
import {compileSnapshotModule,type CompiledSnapshotArtifact} from "./snapshot-modules.js";
import {createSnapshotRun,type SnapshotRun} from "./snapshot-run.js";
import {runSnapshotAction} from "./snapshot-browser-action.js";
import {snapshotVerificationChecks} from "./snapshot-browser-result.js";
import {localBundlePath} from "./bundle-files.js";
import {PROTOCOL_VERSION} from "../runtime/protocol/common.js";
import {FRAME_PROTOCOL_VERSION} from "../frame/protocol/version.js";
import {SNAPSHOT_CHANNEL_VERSION} from "../runtime/protocol/snapshot-channel-version.js";
function compatible(index:SnapshotBundleIndex):void {
  const release=getSDKRelease();
  if(index.sdkVersion!==release.sdkVersion||index.engineReleaseId!==release.engineRelease.replace(/^sha256:/u,"")||index.compatibility.workerProtocol!==PROTOCOL_VERSION
    ||index.compatibility.frameProtocol!==FRAME_PROTOCOL_VERSION||index.compatibility.storageChannel!==SNAPSHOT_CHANNEL_VERSION)throw new VMError("FEATURE_NOT_AVAILABLE","Snapshot bundle requires its recorded SDK and engine versions");
}
async function verify(directory:string,index:SnapshotBundleIndex,image:InspectedImageFiles,options:TestSnapshotOptions,run:SnapshotRun,timeoutMs:number,override?:CompiledSnapshotArtifact):Promise<SnapshotTestReport> {
  compatible(index);run.emit("verify");
  const files=new Map<string,string>(),verifier=override??{path:await localBundlePath(directory,index.verifier.url),...index.verifier};
  files.set("/author/verify.mjs",verifier.path);
  files.set("/prepared/manifest.json",await localBundlePath(directory,index.snapshot.url));
  for(const artifact of index.artifacts.filter(file=>file.url.startsWith("snapshot/chunks/")))files.set(`/prepared/chunks/${artifact.url.slice("snapshot/chunks/".length)}`,await localBundlePath(directory,artifact.url));
  const outcome=await runSnapshotAction({action:"verify",image,imageDirectory:join(directory,"image"),browser:snapshotBrowser(options.browser??"chromium"),files,
    backupPath:join(directory,"unused-verification-upload.oxvm"),...(options.engineDir===undefined?{}:{engineDir:options.engineDir}),timeoutMs,run,
    configuration:{mode:index.mode,name:index.name,label:index.name,vm:index.vm,timeouts:{...SNAPSHOT_DEFAULT_TIMEOUTS,verifyMs:timeoutMs},files:[],workload:{kind:"module",url:"/author/verify.mjs"},verify:"/author/verify.mjs",
      shipped:{mode:index.mode,name:index.name,manifestUrl:"/prepared/manifest.json",manifestSHA256:index.snapshot.sha256,manifestBytes:index.snapshot.bytes,downloadBytes:index.snapshot.downloadBytes,imageManifestSHA256:index.image.manifestSHA256,trust:index.trust},
      expectedSnapshot:index.source,receiptSHA256:index.receiptSHA256}});
  if(outcome.result.ok&&(outcome.result.result.kind!=="verified"||outcome.result.result.snapshot.id!==index.source.id))throw new VMError("PROTOCOL_ERROR","Browser verification returned a different source snapshot");
  if(!outcome.result.ok&&outcome.result.error.code==="FEATURE_NOT_AVAILABLE")throw new VMError("FEATURE_NOT_AVAILABLE","Snapshot browser capabilities are unavailable",{phase:"verify",reason:outcome.result.error.reason??"snapshot-browser-unavailable"});
  return decodeSnapshotTestReport({schemaVersion:1,result:outcome.result.ok?"passed":"failed",name:index.name,mode:index.mode,bundleSHA256:null,snapshotManifestSHA256:index.snapshot.sha256,imageManifestSHA256:index.image.manifestSHA256,
    snapshot:{id:index.source.id,kind:"shipped"},sdkVersion:index.sdkVersion,engineReleaseId:index.engineReleaseId,browser:outcome.browser,verifier:{source:override===undefined?"bundled":"override",sha256:verifier.sha256},checks:snapshotVerificationChecks(outcome.result)});
}
export async function testSnapshot(bundleDir:string,options:TestSnapshotOptions):Promise<SnapshotTestReport> {
  const trust=decodeTrustedImageKey(options.trust);
  const timeout=snapshotTimer(options.timeoutMs??SNAPSHOT_DEFAULT_TIMEOUTS.verifyMs,"verification timeout"),run=createSnapshotRun(timeout,options.signal,options.onProgress);
  let scratch:string|undefined;
  try{
    scratch=await mkdtemp(join(tmpdir(),"oxidevm-snapshot-verifier-"));
    run.emit("validate");const bundle=await readSnapshotBundle(resolve(bundleDir),trust,run.signal);compatible(bundle.index);
    const override=options.verifyModule===undefined?undefined:await compileSnapshotModule(resolve(options.verifyModule),dirname(resolve(options.verifyModule)),join(scratch,"verify.mjs"),run.signal);
    const report=await verify(bundle.directory,bundle.index,bundle.image,options,run,timeout,override);
    run.emit("done");return {...report,bundleSHA256:decodeSHA256(bundle.digest,"bundle digest")};
  }catch(error){throw run.failure(error);}
  finally{run.close();if(scratch!==undefined)await rm(scratch,{recursive:true,force:true});}
}
export async function verifyStagedSnapshot(staged:StagedSnapshotBundle,options:TestSnapshotOptions,run:SnapshotRun):Promise<SnapshotTestReport> {
  const directory=staged.input.staging,index=staged.unsignedIndex;
  const image=await inspectImageFiles(join(directory,"image"),{trust:index.image.trust,signal:run.signal});
  await readSnapshotState(directory,index,image,run.signal);
  return verify(directory,index,image,options,run,staged.input.recipe.timeouts.verifyMs);
}
