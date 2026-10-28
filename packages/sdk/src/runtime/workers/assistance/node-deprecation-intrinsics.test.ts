import {expect,it} from "vitest";
import {createNodeUtil} from "./node-util.js";
for(const key of ["get","apply"]as const)for(const throwing of [false,true])it("deprecation delivery ignores application Reflect."+key+" getter throwing="+String(throwing),()=>{
 const define=Object.defineProperty,original=Object.getOwnPropertyDescriptor(Reflect,key),warnings:unknown[][]=[],util=createNodeUtil({noDeprecation:false,emitWarning(...args:unknown[]){warnings.push(args);}});let effects=0,value:unknown,failure:unknown;
 if(original===undefined)throw new Error("Missing Reflect intrinsic");
 const fallback:unknown=original.value;
 try{define(Reflect,key,{configurable:true,get():unknown{effects++;if(throwing)throw new Error("Application intrinsic getter");return fallback;}});try{const bound=util.deprecate((value:unknown)=>value,"deprecated property","DEP0172",{modifyPrototype:false});value=bound(19);bound(23);}catch(error){failure=error;}}
 finally{define(Reflect,key,original);}
 expect(failure).toBeUndefined();expect(effects).toBe(0);expect(value).toBe(19);expect(warnings.map(row=>row.slice(0,3))).toEqual([["deprecated property","DeprecationWarning","DEP0172"]]);
});
