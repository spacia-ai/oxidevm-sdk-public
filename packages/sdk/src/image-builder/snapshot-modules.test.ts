import {mkdtemp,rm,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {resolveSnapshotRecipe} from "./snapshot-recipe.js";
import {compileSnapshotModules} from "./snapshot-modules.js";
it("browser_module_rejects_node_builtins_and_keeps_one_external_sdk_import",async()=>{
  const root=await mkdtemp(join(tmpdir(),"oxidevm-author-module-"));
  try{
    await writeFile(join(root,"prepare.ts"),'import {defineImage} from "@oxidevm/sdk"; export default async function () { return typeof defineImage; }');
    await writeFile(join(root,"verify.ts"),"export default async function () {}");
    const resolved=await resolveSnapshotRecipe({name:"ready",mode:"userspace",image:"default",workload:{module:"prepare.ts"},verify:{module:"verify.ts"}},{recipeDir:root,signingKeyFile:"sign.pem"});
    const modules=await compileSnapshotModules(resolved,join(root,"compiled"));
    expect(await readFile(modules.preparation.artifact.path,"utf8")).toContain('from "@oxidevm/sdk"');
    await writeFile(join(root,"prepare.ts"),'import {readFile} from "node:fs/promises"; export default readFile;');
    await expect(compileSnapshotModules(resolved,join(root,"bad"))).rejects.toThrow();
  }finally{await rm(root,{recursive:true,force:true});}
});
