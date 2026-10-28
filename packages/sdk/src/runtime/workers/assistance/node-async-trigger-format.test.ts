import { deprecate, format, inspect } from "node:util";
import {expect,it} from "vitest";
import {createAsyncContext} from "./async-context.js";
import {createNodeAsyncHooks} from "./node-async-hooks.js";
for(const [name,value,message]of [["bigint",7n,"7n"],["symbol",Symbol.for("bad"),"Symbol(bad)"],["null",null,"null"],["object",{},"{}"],["array",[],"[]"],["properties",{a:1},"{ a: 1 }"],["function",function named(){},"function named(){}"],["boolean",false,"false"]]as const)it("uses the pinned trigger error formatting for "+name,()=>{
 const context=createAsyncContext(),hooks=createNodeAsyncHooks(context, { deprecate, format, inspect });let failure:unknown;try{new hooks.AsyncResource("owned",{triggerAsyncId:value});}catch(error){failure=error;}context.resources.dispose();expect(failure).toMatchObject({name:"RangeError",code:"ERR_INVALID_ASYNC_ID",message:"Invalid triggerAsyncId value: "+(typeof value==="function"?String(value):message)});
});
