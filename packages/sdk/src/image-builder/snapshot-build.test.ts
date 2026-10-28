import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it,vi} from "vitest";
import {buildSnapshot} from "./snapshot-build.js";
import {buildImage} from "./build.js";
import {generateImageKey} from "./keys.js";
import {withOutputLock} from "./output-lock.js";
import * as browser from "./snapshot-browser-action.js";
it("build_validates_recipe_before_browser_or_output",async()=>{
  await expect(buildSnapshot({name:"ready",mode:"userspace",image:"default",workload:{module:"prepare.ts"},verify:{module:"verify.ts"},vm:{memoryMiB:1}},{recipeDir:".",signingKeyFile:"absent.pem"})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
});
it("owns_the_output_before_opening_a_source_browser",async()=>{
  const root=await mkdtemp(join(tmpdir(),"oxidevm-build-ownership-"));
  const launch=vi.spyOn(browser,"runSnapshotAction").mockRejectedValue(new Error("Source browser must not open"));
  try{
    await mkdir(join(root,"root"));await writeFile(join(root,"root/file"),"image input");
    await writeFile(join(root,"prepare.ts"),"export default async function() {}");
    await writeFile(join(root,"verify.ts"),"export default async function() {}");
    const key=await generateImageKey(join(root,"key.pem"));
    await buildImage({id:"owned",version:"1",mode:"userspace",source:{kind:"directory",path:"root"},smokeTest:{command:"/bin/true",expectedExitCode:0}}, {recipeDir:root,signingKeyFile:key.privateKeyPath,outDir:"image"});
    await withOutputLock(join(root,"dist"),async()=>{
      await expect(buildSnapshot({name:"ready",mode:"userspace",image:"image",workload:{module:"prepare.ts"},verify:{module:"verify.ts"}}, {recipeDir:root,signingKeyFile:key.privateKeyPath,imageTrust:key.trust})).rejects.toMatchObject({code:"STORAGE_ERROR"});
    });
    expect(launch).not.toHaveBeenCalled();
  }finally{launch.mockRestore();await rm(root,{recursive:true,force:true});}
});
