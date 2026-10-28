import { deprecate, format, inspect } from "node:util";
import {expect,it} from "vitest";
import {createAsyncContext} from "../assistance/async-context.js";
import {createNodeAsyncHooks} from "../assistance/node-async-hooks.js";
import {NativeAsyncContexts} from "./async-contexts.js";
function poisoned<T>(owner:object,key:PropertyKey,throwing:boolean,fallback:unknown,action:()=>T){
 const define=Object.defineProperty,remove=Reflect.deleteProperty,original=Object.getOwnPropertyDescriptor(owner,key);let effects=0,result:T|undefined,failure:unknown;
 try{define(owner,key,{configurable:true,get():unknown{effects++;if(throwing)throw new Error("Application primitive getter");return original===undefined?fallback:original.value;}});try{result=action();}catch(error){failure=error;}}
 finally{if(original===undefined)remove(owner,key);else define(owner,key,original);}return{result,failure,effects};
}
for(const throwing of [false,true])for(const target of ["callback","prototype"]as const)it("bound async context ignores "+target+" apply getter throwing="+String(throwing),()=>{
 const apply=Reflect.apply,context=createAsyncContext(),store=new context.AsyncLocalStorage<string>(),callback=function(this:{marker:number},value:number){return{value:this.marker+value,store:store.getStore()};};
 const bound=store.run("captured",()=>context.AsyncLocalStorage.bind(callback)),owner=target==="callback"?callback:Function.prototype;
 const fallback: unknown = Reflect.get(Function.prototype, "apply");
 const observed=poisoned(owner,"apply",throwing,fallback,()=>store.run("caller",()=>apply(bound,{marker:11},[17])));
 context.resources.dispose();expect(observed.failure).toBeUndefined();expect(observed.effects).toBe(0);expect(observed.result).toEqual({value:28,store:"captured"});expect(store.getStore()).toBeUndefined();
});
for(const throwing of [false,true])for(const name of ["init","before","after"]as const)it("empty async hooks ignore inherited "+name+" getter throwing="+String(throwing),()=>{
 const context=createAsyncContext(),contexts=new NativeAsyncContexts(17n<<32n,context),environment=(17n<<32n)|1n,callbacks:unknown=Object.create(null),hook=context.resources.createHook(callbacks).enable();
 const observed=poisoned(Object.prototype,name,throwing,undefined,()=>{const id=contexts.create(environment,{},"owned");try{return contexts.make(environment,id,{},()=>19);}finally{contexts.destroy(environment,id);}});
 contexts.dispose();hook.disable();context.resources.dispose();expect(observed.failure).toBeUndefined();expect(observed.effects).toBe(0);expect(observed.result).toBe(19);
});
for(const throwing of [false,true])for(const selection of ["reflect-apply","reflect-get","defineProperty"]as const)it("Node async resource ignores "+selection+" getter throwing="+String(throwing),()=>{
 const apply=Reflect.apply,context=createAsyncContext(),hooks=createNodeAsyncHooks(context, { deprecate, format, inspect }),store=new context.AsyncLocalStorage<string>(),owner=selection==="defineProperty"?Object:Reflect,key=selection==="defineProperty"?"defineProperty":selection==="reflect-apply"?"apply":"get";
 const observed=poisoned(owner,key,throwing,undefined,()=>{const resource=store.run("captured",()=>new hooks.AsyncResource("owned",{requireManualDestroy:true}));try{const bound=resource.bind(function(this:{marker:number},value:number){return{value:this.marker+value,store:store.getStore()};});return store.run("caller",()=>apply(bound,{marker:11},[17]));}finally{resource.emitDestroy();}});
 context.resources.dispose();expect(observed.failure).toBeUndefined();expect(observed.effects).toBe(0);expect(observed.result).toEqual({value:28,store:"captured"});expect(store.getStore()).toBeUndefined();
});
