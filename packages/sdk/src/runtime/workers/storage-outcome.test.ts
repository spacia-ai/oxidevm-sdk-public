import {expect,it} from "vitest";
import {storageOutcome} from "./storage-outcome.js";
import {VMError} from "../errors.js";
for(const type of ["select-userspace-files","initial-start-retire"] as const)it(`returns ${type} outcome when cancellation arrives with its commit`,async()=>{
 let cancelled=false;const active=()=>{if(cancelled)throw new VMError("ABORTED","cancelled");};
 const result=await storageOutcome(type,async()=>{cancelled=true;await Promise.resolve();return {sourceId:"selected"};},active);
 expect(result).toEqual({sourceId:"selected"});
});
it("rejects cancelled reads and refuses a selection before its operation begins",async()=>{
 let called=false;
 const cancelled=()=>{throw new VMError("ABORTED","cancelled");};
 await expect(storageOutcome("select-userspace-files",async()=>{called=true;await Promise.resolve();},cancelled)).rejects.toMatchObject({code:"ABORTED"});
 expect(called).toBe(false);
 let aborted=false;
 await expect(storageOutcome("read-file",async()=>{aborted=true;await Promise.resolve();return new Uint8Array();},()=>{if(aborted)cancelled();})).rejects.toMatchObject({code:"ABORTED"});
});
