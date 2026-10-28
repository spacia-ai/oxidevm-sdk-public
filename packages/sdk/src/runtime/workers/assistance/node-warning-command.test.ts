import {expect,it} from "vitest";
import {NodeProcess} from "./node-process.js";
import {createWarningPrinter} from "./node-warnings.js";
for(const [argv0,command]of [[undefined,"node"],["","node"],["/usr/bin/node","node"],["/opt/custom-runtime.exe","custom-runtime"]]as const)it("prints the admitted warning command for argv0="+String(argv0),()=>{
 const process=new NodeProcess(()=>{throw new Error("Unexpected exit");},"24.18.1"),output:string[]=[];Object.defineProperty(process,"argv0",{value:argv0,configurable:true});
 const print=createWarningPrinter(process,text=>output.push(text),()=>42);print(Object.assign(new Error("deprecated property"),{name:"DeprecationWarning",code:"DEP0172"}));
 expect(output).toEqual(["(node:42) [DEP0172] DeprecationWarning: deprecated property\n(Use `"+command+" --trace-deprecation ...` to show where the warning was created)\n"]);
});
