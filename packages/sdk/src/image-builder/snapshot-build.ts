import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {VMError} from "../runtime/errors.js";
import type {SnapshotRecipe,BuildSnapshotOptions,SnapshotBuildResult} from "./snapshot-contracts.js";
import {decodeSnapshotRecipe,resolveSnapshotRecipe,resolveSnapshotImage,SNAPSHOT_DEFAULT_TIMEOUTS,snapshotTimer,type ResolvedSnapshotRecipe} from "./snapshot-recipe.js";
import {compileSnapshotModules,type CompiledSnapshotModules} from "./snapshot-modules.js";
import {loadSigningKey} from "./keys.js";
import {createSnapshotRun,type SnapshotRun} from "./snapshot-run.js";
import {runSnapshotAction} from "./snapshot-browser-action.js";
import {snapshotPreparationFailure} from "./snapshot-browser-result.js";
import type {InspectedImageFiles} from "./bundle.js";
import {inspectBackupFile} from "./snapshot-backup.js";
import {withSnapshotPublication} from "./snapshot-publication.js";
import {publishPreparedSnapshot} from "./snapshot-pack.js";
interface SnapshotCaptureInput {readonly recipe:ResolvedSnapshotRecipe;readonly image:InspectedImageFiles;readonly modules:CompiledSnapshotModules;readonly backupPath:string;readonly options:BuildSnapshotOptions;readonly run:SnapshotRun}
async function captureBrowserSnapshot(input:SnapshotCaptureInput):Promise<void> {
  const {recipe,modules,run}=input,preparationURL=modules.preparation.kind==="module"?"/author/prepare.mjs":"/author/prepare.sh",files=new Map<string,string>([[preparationURL,modules.preparation.artifact.path],["/author/verify.mjs",modules.verification.path]]);
  const staged=recipe.stagedFiles.map((file,index)=>{const url=`/inputs/${String(index)}`;files.set(url,file.from);return {url,to:file.to,bytes:file.bytes,sha256:file.sha256};});
  const outcome=await runSnapshotAction({action:"prepare",image:input.image,imageDirectory:input.image.read.bundle,browser:recipe.browser,files,backupPath:input.backupPath,
    ...(input.options.engineDir===undefined?{}:{engineDir:input.options.engineDir}),timeoutMs:run.remaining(),run,
    configuration:{mode:recipe.mode,name:recipe.name,label:recipe.label,vm:recipe.vm??{},timeouts:recipe.timeouts,files:staged,
      workload:{kind:modules.preparation.kind,url:preparationURL},verify:"/author/verify.mjs"}});
  if(!outcome.result.ok)throw snapshotPreparationFailure(outcome.result.error);
  const result=outcome.result.result;
  if(result.kind!=="prepared"||result.imageManifestSHA256!==input.image.read.image.manifestSHA256)throw new VMError("PROTOCOL_ERROR","Preparation returned a different image identity");
  const backup=await inspectBackupFile(input.backupPath,run.signal);
  if(backup.manifest.id!==result.snapshot.id||backup.manifest.createdAt!==result.snapshot.createdAt||backup.manifest.host?.appData?.sha256!==result.receiptSHA256)throw new VMError("PROTOCOL_ERROR","Uploaded capture differs from the preparation result");
}
export async function buildSnapshot(input:SnapshotRecipe,options:BuildSnapshotOptions):Promise<SnapshotBuildResult> {
  const recipeValue=decodeSnapshotRecipe(input),run=createSnapshotRun(snapshotTimer(options.timeoutMs??recipeValue.timeouts?.buildMs??SNAPSHOT_DEFAULT_TIMEOUTS.buildMs,"build timeout"),options.signal,options.onProgress);
  let scratch:string|undefined;
  try{
    scratch=await mkdtemp(join(tmpdir(),"oxidevm-snapshot-build-"));
    run.emit("validate");const recipe=await resolveSnapshotRecipe(recipeValue,{...options,signal:run.signal}),signer=await loadSigningKey(recipe.signingKeyFile),image=await resolveSnapshotImage(recipe,options.imageTrust,run.signal);
    run.emit("compile");const modules=await compileSnapshotModules(recipe,join(scratch,"modules"),run.signal),backupPath=join(scratch,"capture.oxvm");
    const result=await withSnapshotPublication(recipe.outDir,run.signal,async staging=>{
      // Source ownership ends before the fresh verifier opens, within one destination lock.
      await captureBrowserSnapshot({recipe,image,modules,backupPath,options,run});
      return publishPreparedSnapshot({backupPath,staging,recipe,verifiedImage:image,verifier:modules.verification,signer,
        operation:"build",preparationSHA256:modules.preparation.artifact.sha256,signal:run.signal},options,run);
    });
    run.emit("done");return result;
  }catch(error){throw run.failure(error);}
  finally{run.close();if(scratch!==undefined)await rm(scratch,{recursive:true,force:true});}
}
