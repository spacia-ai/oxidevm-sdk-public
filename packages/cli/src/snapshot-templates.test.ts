import {mkdtemp,readdir,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {initializeSnapshot} from "./snapshot-templates.js";
it("default_init_creates_exactly_six_files_and_never_overwrites",async()=>{
  const root=await mkdtemp(join(tmpdir(),"oxidevm-snapshot-init-")),directory=join(root,"snapshots/ready");
  try{
    const options={name:"ready",signal:new AbortController().signal};
    const result=await initializeSnapshot(directory,options);expect(result.files).toHaveLength(6);expect(result.mode).toBe("userspace");
    expect((await readdir(directory)).sort()).toEqual([...result.files].sort());
    const before=await readFile(join(directory,"prepare.ts"),"utf8");
    await expect(initializeSnapshot(directory,options)).rejects.toThrow();
    expect(await readFile(join(directory,"prepare.ts"),"utf8")).toBe(before);
    expect(await readFile(join(directory,"verify.ts"),"utf8")).not.toContain("KEEP=");
  }finally{await rm(root,{recursive:true,force:true});}
});
