import {expect,it} from "vitest";
import {createAsyncContext} from "./async-context.js";
import {createNodeAsyncHooks} from "./node-async-hooks.js";
import {NodeProcess} from "./node-process.js";
import {createNodeUtil} from "./node-util.js";
import {createWarningPrinter} from "./node-warnings.js";

it("delivers the deprecated binding warning once through the process scheduler and warning owner",()=>{
 const queued:(()=>void)[]=[],warnings:unknown[]=[],output:string[]=[],process=new NodeProcess(()=>{throw new Error("Unexpected exit");},"24.18.1",undefined,callback=>queued.push(callback));
 Object.defineProperty(process,"argv0",{value:"/usr/bin/node"});process.on("warning",warning=>warnings.push(warning));process.on("warning",createWarningPrinter(process,text=>output.push(text),()=>42));
 const context=createAsyncContext(),util=createNodeUtil(process),hooks=createNodeAsyncHooks(context,util),resource=new hooks.AsyncResource("owned",{requireManualDestroy:true}),bound=resource.bind((value:unknown)=>value),replacement={};
 expect(warnings).toEqual([]);expect(queued).toEqual([]);
 const first:unknown=Reflect.get(bound,"asyncResource");expect(first).toBe(resource);expect(Reflect.get(bound,"asyncResource")).toBe(resource);
 Reflect.set(bound,"asyncResource",replacement);expect(Reflect.get(bound,"asyncResource")).toBe(replacement);expect(bound(19)).toBe(19);
 const other=resource.bind(()=>23);expect(Reflect.get(other,"asyncResource")).toBe(resource);
 expect(queued).toHaveLength(1);expect(warnings).toEqual([]);queued.shift()?.();
 expect(warnings).toHaveLength(1);expect(warnings[0]).toMatchObject({name:"DeprecationWarning",code:"DEP0172",message:"The asyncResource property on bound functions is deprecated"});
 expect(output).toEqual(["(node:42) [DEP0172] DeprecationWarning: The asyncResource property on bound functions is deprecated\n(Use `node --trace-deprecation ...` to show where the warning was created)\n"]);
 resource.emitDestroy();context.resources.dispose();
});

it("preserves configured warning suppression without changing binding metadata or callback behavior",()=>{
 const process=new NodeProcess(()=>{throw new Error("Unexpected exit");},"24.18.1"),warnings:unknown[]=[];process.noDeprecation=true;process.on("warning",warning=>warnings.push(warning));
 const context=createAsyncContext(),hooks=createNodeAsyncHooks(context,createNodeUtil(process)),resource=new hooks.AsyncResource("owned",{requireManualDestroy:true}),bound=resource.bind(()=>29);
 expect(Reflect.get(bound,"asyncResource")).toBe(resource);expect(bound()).toBe(29);expect(warnings).toEqual([]);resource.emitDestroy();context.resources.dispose();
});
