import {mkdtemp,mkdir,readdir,readFile,writeFile,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {withOutputLock} from "./output-lock.js";
it("does_not_follow_an_output_ownership_directory_symlink",async()=>{
  const root=await mkdtemp(join(tmpdir(),"oxidevm-lock-boundary-")),out=join(root,"dist"),other=join(root,"other");
  try{
    await mkdir(other);await symlink(other,`${out}.owners`);
    await expect(withOutputLock(out,()=>Promise.resolve())).rejects.toMatchObject({code:"STORAGE_ERROR"});
    expect(await readdir(other)).toEqual([]);
  }finally{await rm(root,{recursive:true,force:true});}
});
it("cleanup_does_not_remove_a_replacement_inode",async()=>{
  const root=await mkdtemp(join(tmpdir(),"oxidevm-lock-inode-")),out=join(root,"dist");let replacement="";
  try{
    await withOutputLock(out,async()=>{
      const name=(await readdir(`${out}.owners`))[0];if(name===undefined)throw new Error("Missing owner claim");
      replacement=join(`${out}.owners`,name);await rm(replacement);await writeFile(replacement,"replacement owner");
    });
    expect(await readFile(replacement,"utf8")).toBe("replacement owner");
  }finally{await rm(root,{recursive:true,force:true});}
});
