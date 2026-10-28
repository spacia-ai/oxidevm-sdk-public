import {mkdtemp,readFile,writeFile,mkdir,rm,readdir} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {expect,it} from "vitest";
import {atomicBundle,recoverBundlePublication} from "./atomic.js";
it("failed_publication_preserves_previous_bundle",async()=>{
  const root=await mkdtemp(join(tmpdir(),"oxidevm-atomic-")),out=join(root,"dist");
  try{
    await atomicBundle(out,async stage=>{await writeFile(join(stage,"manifest.json"),"old");});
    await expect(atomicBundle(out,async stage=>{await writeFile(join(stage,"manifest.json"),"new");throw new Error("failed verification");})).rejects.toThrow();
    expect(await readFile(join(out,"manifest.json"),"utf8")).toBe("old");
  }finally{await rm(root,{recursive:true,force:true});}
});
it("recovery_selects_complete_old_output_after_interrupted_rename",async()=>{
  const root=await mkdtemp(join(tmpdir(),"oxidevm-atomic-")),out=join(root,"dist");
  const suffix="123e4567-e89b-42d3-a456-426614174000",backup=join(root,`dist.previous-${suffix}`);
  try{
    await mkdir(out);await writeFile(join(out,"manifest.json"),"new");
    await mkdir(backup);await writeFile(join(backup,"manifest.json"),"old");
    await writeFile(`${out}.publication.json`,JSON.stringify({version:1,temporary:`dist.building-${suffix}`,backup:`dist.previous-${suffix}`,hadPrevious:true,phase:"prepared"}));
    await recoverBundlePublication(out);
    expect(await readFile(join(out,"manifest.json"),"utf8")).toBe("old");
    expect(await readdir(root)).toEqual(["dist"]);
  }finally{await rm(root,{recursive:true,force:true});}
});
