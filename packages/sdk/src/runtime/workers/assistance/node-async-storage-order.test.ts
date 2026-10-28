import { deprecate, format, inspect } from "node:util";
import {expect,it} from "vitest";
import {createAsyncContext} from "./async-context.js";
import {createNodeAsyncHooks} from "./node-async-hooks.js";
it("exposes caller storage to before and after hooks and captured storage to the callback",()=>{
 const context=createAsyncContext(),hooks=createNodeAsyncHooks(context, { deprecate, format, inspect }),storage=new hooks.AsyncLocalStorage<string>(),events:unknown[][]=[],resource=storage.run("captured",()=>new hooks.AsyncResource("owned",{requireManualDestroy:true}));
 const hook=hooks.createHook({before(){events.push(["before",storage.getStore()]);},after(){events.push(["after",storage.getStore()]);}}).enable();
 storage.run("caller",()=>resource.runInAsyncScope(()=>events.push(["callback",storage.getStore()])));hook.disable();resource.emitDestroy();context.resources.dispose();
 expect(events).toEqual([["before","caller"],["callback","captured"],["after","caller"]]);expect(storage.getStore()).toBeUndefined();
});
