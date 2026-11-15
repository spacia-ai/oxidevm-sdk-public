import {dirname,resolve} from "node:path";
import {buildSnapshot,packSnapshot,testSnapshot,inspectSnapshot,loadSnapshotRecipe,readImageTrust} from "@oxvm/sdk/image-builder";
import {initializeSnapshot} from "./snapshot-templates.js";
import { setting } from "./environment.js";
import { defaultSnapshotRecipe } from "./project-files.js";
import type {SnapshotProgress} from "@oxvm/sdk/image-builder";
import type {CLIInvocation} from "./arguments.js";
import type {CLIEnvironment} from "./run.js";
import type {CliReport} from "./contracts.js";
export type SnapshotCLIInvocation=Extract<CLIInvocation,{command:"snapshot init"|"snapshot build"|"snapshot pack"|"snapshot test"|"snapshot inspect"}>;
export async function runSnapshotCommand(invocation:SnapshotCLIInvocation,io:CLIEnvironment):Promise<CliReport> {
  const path=(value:string)=>resolve(io.directory,value),command=invocation.command;
  const onProgress=(progress:SnapshotProgress)=>{io.stderr(invocation.json?`${JSON.stringify(progress)}\n`:`${progress.phase}\n`);};
  switch(command){
    case "snapshot init":{
      const trust=invocation.imageTrust??setting(io.environment, "IMAGE_TRUST_FILE");
      return {schemaVersion:3,kind:"result",command,result:await initializeSnapshot(path(invocation.directory),{name:invocation.name,signal:io.signal,
        ...(invocation.mode===undefined?{}:{mode:invocation.mode}),...(invocation.image===undefined?{}:{imageDir:path(invocation.image)}),...(trust===undefined?{}:{imageTrust:await readImageTrust(path(trust))})})};
    }
    case "snapshot inspect":return {schemaVersion:3,kind:"result",command,result:await inspectSnapshot(path(invocation.artifact),{signal:io.signal,...(invocation.trust===undefined?{}:{trust:await readImageTrust(path(invocation.trust))})})};
    case "snapshot test":return {schemaVersion:3,kind:"result",command,result:await testSnapshot(path(invocation.bundle),{trust:await readImageTrust(path(invocation.trust)),signal:io.signal,onProgress,
      ...(invocation.verify===undefined?{}:{verifyModule:path(invocation.verify)}),...(invocation.browser===undefined?{}:{browser:invocation.browser}),...(invocation.timeoutMs===undefined?{}:{timeoutMs:invocation.timeoutMs}),...(invocation.engineDir===undefined?{}:{engineDir:path(invocation.engineDir)})})};
    case "snapshot build":case "snapshot pack":{
      const recipePath = invocation.recipe === undefined ? await defaultSnapshotRecipe(io.directory) ?? path("oxvm.snapshot.ts") : path(invocation.recipe);
      const recipe=await loadSnapshotRecipe(recipePath);
      const trustPath=invocation.imageTrust===undefined?(recipe.imageTrust===undefined?setting(io.environment, "IMAGE_TRUST_FILE"):resolve(dirname(recipePath),recipe.imageTrust)):path(invocation.imageTrust);
      const options={recipeDir:dirname(recipePath),signingKeyFile:path(invocation.signingKey),signal:io.signal,onProgress,
        ...(trustPath===undefined?{}:{imageTrust:await readImageTrust(path(trustPath))}),...(invocation.out===undefined?{}:{outDir:path(invocation.out)}),...(invocation.baseUrl===undefined?{}:{publicBaseUrl:invocation.baseUrl}),
        ...(invocation.browser===undefined?{}:{browser:invocation.browser}),...(invocation.timeoutMs===undefined?{}:{timeoutMs:invocation.timeoutMs}),...(invocation.engineDir===undefined?{}:{engineDir:path(invocation.engineDir)})};
      const result=invocation.command==="snapshot build"?await buildSnapshot(recipe,options):await packSnapshot(path(invocation.backup),recipe,options);
      return {schemaVersion:3,kind:"result",command,result};
    }
  }
}
