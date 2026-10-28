import {mkdtemp,rm,lstat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {VMError} from "../runtime/errors.js";
import type {SnapshotRecipe,BuildSnapshotOptions,SnapshotBuildResult} from "./snapshot-contracts.js";
import {decodeSnapshotRecipe,resolveSnapshotRecipe,resolveSnapshotImage,SNAPSHOT_DEFAULT_TIMEOUTS,snapshotTimer} from "./snapshot-recipe.js";
import {compileSnapshotModule} from "./snapshot-modules.js";
import {loadSigningKey} from "./keys.js";
import {canonicalOutputPath,containsPath} from "./output-path.js";
import {createSnapshotRun,type SnapshotRun} from "./snapshot-run.js";
import {writeSnapshotState,finalizeSnapshotBundle,withSnapshotPublication,type SnapshotPackageInput} from "./snapshot-publication.js";
import {verifyStagedSnapshot} from "./snapshot-test.js";
export async function publishPreparedSnapshot(input:SnapshotPackageInput,options:BuildSnapshotOptions,run:SnapshotRun):Promise<SnapshotBuildResult> {
  run.emit("package");const staged=await writeSnapshotState(input);
  const report=await verifyStagedSnapshot(staged,{trust:input.signer.trust,browser:input.recipe.browser,signal:run.signal,...(options.engineDir===undefined?{}:{engineDir:options.engineDir})},run);
  if(report.result!=="passed")throw new VMError("GUEST_CRASH","Snapshot restoration verification failed",{phase:"verify",reason:"snapshot-verify-failed"});
  run.emit("publish");return finalizeSnapshotBundle(staged,report,run.signal);
}
export async function packSnapshot(backupPath:string,input:SnapshotRecipe,options:BuildSnapshotOptions):Promise<SnapshotBuildResult> {
  const recipeValue=decodeSnapshotRecipe(input),run=createSnapshotRun(snapshotTimer(options.timeoutMs??recipeValue.timeouts?.buildMs??SNAPSHOT_DEFAULT_TIMEOUTS.buildMs,"build timeout"),options.signal,options.onProgress);
  let scratch:string|undefined;
  try{
    scratch=await mkdtemp(join(tmpdir(),"oxidevm-snapshot-pack-"));
    run.emit("validate");const recipe=await resolveSnapshotRecipe(recipeValue,{...options,signal:run.signal},"pack");
    const backup=await canonicalOutputPath(resolve(backupPath)),metadata=await lstat(backup),key=await lstat(recipe.signingKeyFile);
    if(containsPath(recipe.outDir,backup)||metadata.dev===key.dev&&metadata.ino===key.ino)throw new VMError("INVALID_ARGUMENT","Backup overlaps output or signing key");
    const signer=await loadSigningKey(recipe.signingKeyFile),image=await resolveSnapshotImage(recipe,options.imageTrust,run.signal);
    run.emit("compile");const verifier=await compileSnapshotModule(recipe.verificationPath,recipe.recipeDir,join(scratch,"verify.mjs"),run.signal);
    const result=await withSnapshotPublication(recipe.outDir,run.signal,staging=>publishPreparedSnapshot({backupPath:backup,staging,recipe,verifiedImage:image,verifier,signer,operation:"pack",signal:run.signal},options,run));
    run.emit("done");return result;
  }catch(error){throw run.failure(error);}
  finally{run.close();if(scratch!==undefined)await rm(scratch,{recursive:true,force:true});}
}
