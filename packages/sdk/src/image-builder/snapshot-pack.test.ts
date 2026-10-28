import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {resolveSnapshotRecipe} from "./snapshot-recipe.js";
it("pack_never_requires_prepare_or_staged_files",async()=>{
  const root=await mkdtemp(join(tmpdir(),"oxidevm-pack-policy-"));
  try{
    await writeFile(join(root,"verify.ts"),"export default async function() {}");
    const recipe=await resolveSnapshotRecipe({name:"ready",mode:"userspace",image:"default",workload:{module:"absent.ts"},files:[{from:"absent.txt",to:"/workspace/absent"}],verify:{module:"verify.ts"}},{recipeDir:root,signingKeyFile:"key.pem"},"pack");
    expect(recipe.stagedFiles).toEqual([]);
  }finally{await rm(root,{recursive:true,force:true});}
});
