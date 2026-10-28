import {expect,it} from "vitest";
import {createSnapshotRun} from "./snapshot-run.js";
it("keeps_the_owned_phase_and_safe_filesystem_cause_without_private_payloads",()=>{
  const run=createSnapshotRun(1000);
  try{
    run.emit("package");
    const failure=run.failure(Object.assign(new Error("private filename and payload"),{code:"ENOSPC",path:"private"}));
    expect(failure).toMatchObject({code:"STORAGE_ERROR",detail:{phase:"package",cause:"ENOSPC"}});
    expect(JSON.stringify(failure)).not.toContain("private");
  }finally{run.close();}
});
