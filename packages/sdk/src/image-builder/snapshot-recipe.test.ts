import {mkdtemp,rm,writeFile,symlink,link} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it} from "vitest";
import {decodeSnapshotRecipe,resolveSnapshotRecipe} from "./snapshot-recipe.js";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"oxidevm snapshot "));roots.push(root);
  await writeFile(join(root,"prepare.ts"),"export default async function () { return null; }");
  await writeFile(join(root,"verify.ts"),"export default async function () {}");
  return root;
}
const recipe={name:"ready",mode:"userspace",image:"default",workload:{module:"prepare.ts"},verify:{module:"verify.ts"}} as const;
it("keeps native snapshot authoring available for explicit root profiles",()=>{
  expect(decodeSnapshotRecipe({...recipe,vm:{initialUser:"root",rootPersistence:"persistent"}}))
    .toMatchObject({mode:"userspace",vm:{initialUser:"root",rootPersistence:"persistent"}});
});
it("recipe_defaults_and_flag_precedence",async()=>{
  const root=await fixture();
  const resolved=await resolveSnapshotRecipe(recipe,{recipeDir:root,signingKeyFile:"sign.pem"});
  expect(resolved.timeouts).toEqual({buildMs:10_800_000,commandMs:900_000,readyMs:900_000,captureMs:1_800_000,verifyMs:1_800_000});
  expect(resolved.maxDownloadBytes).toBe(2*1024**3);
  expect(resolved.browser).toBe("chromium");expect(resolved.label).toBe("ready");
  expect((await resolveSnapshotRecipe({...recipe,browser:"firefox"},{recipeDir:root,signingKeyFile:"sign.pem",browser:"webkit",timeoutMs:1})).browser).toBe("webkit");
});
it("rejects_unknown_or_foreign_mode_fields_and_ambiguous_workloads",()=>{
  for(const value of [{...recipe,other:true},{...recipe,vm:{vcpus:1}},{...recipe,workload:{module:"a.ts",shell:"a.sh"}},{...recipe,timeouts:{buildMs:2_147_483_648}}]){
    expect(()=>decodeSnapshotRecipe(value)).toThrow();
  }
});
it("rejects_symlink_escape_duplicate_guest_paths_and_key_input",async()=>{
  const root=await fixture();await writeFile(join(root,"sign.pem"),"private");
  await symlink(join(root,"sign.pem"),join(root,"link.txt"));
  await link(join(root,"sign.pem"),join(root,"hardlink.txt"));
  for(const files of [[{from:"link.txt",to:"/workspace/key"}],[{from:"hardlink.txt",to:"/workspace/key"}],[{from:"sign.pem",to:"/workspace/key"}],[{from:"prepare.ts",to:"/workspace/a"},{from:"verify.ts",to:"/workspace/a/b"}]]){
    await expect(resolveSnapshotRecipe({...recipe,files},{recipeDir:root,signingKeyFile:"sign.pem"})).rejects.toThrow();
  }
  await expect(resolveSnapshotRecipe(recipe,{recipeDir:root,signingKeyFile:"sign.pem",outDir:"."})).rejects.toThrow();
});
it("stages_regular_files_under_unambiguous_workspace_paths",async()=>{
  const root=await fixture();
  const resolved=await resolveSnapshotRecipe({...recipe,files:[{from:"prepare.ts",to:"/workspace/project/file.ts"}]},{recipeDir:root,signingKeyFile:"sign.pem"});
  expect(resolved.stagedFiles[0]?.to).toBe("/workspace/project/file.ts");
  expect(resolved.stagedFiles[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
});
