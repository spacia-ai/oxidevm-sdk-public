import {expect,it} from "vitest";
import {decodeUserspaceWorkspaceStart} from "./workspace-start.js";
it("preserves native retained UUIDs and legacy cold generation IDs without synthetic aliases",()=>{
 const input={state:"conflict-preserved",conflicts:[],omittedConflicts:0,preserved:{id:"11111111-2222-4333-8444-555555555555",reason:"base-unavailable"}};
 expect(decodeUserspaceWorkspaceStart(input).preserved).toEqual(input.preserved);
 expect(decodeUserspaceWorkspaceStart({...input,preserved:{...input.preserved,id:"123"}}).preserved?.id).toBe("123");
 for(const id of ["0","01","11111111-2222-0333-8444-555555555555","../other","random"])expect(()=>decodeUserspaceWorkspaceStart({...input,preserved:{...input.preserved,id}})).toThrow();
});
