import { expect, it } from "vitest";
import { NativeValues } from "./values.js";
import { decodeNativeFrame, encodeNativeFrame, type NativeFrame } from "./codec.js";

for(const runtime of ["node","bun"] as const)for(const length of [0,1,17]){
  it(`${runtime} array factory ignores an application constructor for length ${length}`,()=>{
    const define=Object.defineProperty,original=Object.getOwnPropertyDescriptor(globalThis,"Array"),ArrayConstructor=Array;
    if(original===undefined)throw new Error("Missing Array descriptor");
    const values=new NativeValues(()=>undefined,()=>undefined,()=>undefined,0,()=>undefined,{claim:()=>undefined,retire:()=>undefined,runtime});
    let traps=0;const marker=new Error("application array intrinsic");define(globalThis,"Array",{configurable:true,writable:true,value:new Proxy(ArrayConstructor,{construct(){traps++;throw marker;}})});
    let result:ReturnType<NativeValues["dispatch"]>;
    try{result=values.dispatch("napi_create_array_with_length",[BigInt(length)],new Uint8Array());}
    finally{define(globalThis,"Array",original);}
    expect(result.status).toBe(0);expect(traps).toBe(0);
    const handle=result.args[0];if(handle===undefined)throw new Error("Missing array result");const value=values.get(handle);
    expect(ArrayConstructor.isArray(value)).toBe(true);expect(value).toHaveLength(length);values.dispose();
  });
}
for(const poison of ["constructor","from"] as const){
  it(`native frame decoding ignores application Array ${poison}`,()=>{
    const frame:NativeFrame={kind:3,sequence:1,scope:1n,environment:0n,operation:"napi_create_array_with_length",status:0,args:[17n],bytes:new Uint8Array()},encoded=encodeNativeFrame(frame);
    const define=Object.defineProperty,owner=poison==="constructor"?globalThis:Array,key=poison==="constructor"?"Array":"from",original=Object.getOwnPropertyDescriptor(owner,key),ArrayConstructor=Array;
    if(original===undefined)throw new Error("Missing array operation");let traps=0;const marker=new Error("application array intrinsic"),replacement=()=>{traps++;throw marker;};
    define(owner,key,{configurable:true,writable:true,value:poison==="constructor"?new Proxy(ArrayConstructor,{construct:replacement}):replacement});
    let decoded:NativeFrame;
    try{decoded=decodeNativeFrame(encoded.subarray(4));}finally{define(owner,key,original);}
    expect(decoded).toEqual(frame);expect(traps).toBe(0);
  });
}

for(const runtime of ["node","bun"] as const)for(const length of [0,17,4294967295]){
  it(`${runtime} array length ${length} ignores application Math.max`,()=>{
    const define=Object.defineProperty,original=Object.getOwnPropertyDescriptor(Math,"max");if(original===undefined)throw new Error("Missing max descriptor");
    const values=new NativeValues(()=>undefined,()=>undefined,()=>undefined,0,()=>undefined,{claim:()=>undefined,retire:()=>undefined,runtime});
    let traps=0;const marker=new Error("application array intrinsic");define(Math,"max",{configurable:true,writable:true,value:()=>{traps++;throw marker;}});
    let result:ReturnType<NativeValues["dispatch"]>;
    try{result=values.dispatch("napi_create_array_with_length",[BigInt(length)],new Uint8Array());}finally{define(Math,"max",original);}
    expect(result.status).toBe(0);expect(traps).toBe(0);const handle=result.args[0];if(handle===undefined)throw new Error("Missing array result");
    expect(values.get(handle)).toHaveLength(length===4294967295?0:length);values.dispose();
  });
}

it("native frame argument allocation ignores inherited iterator getters",()=>{
  const frame:NativeFrame={kind:3,sequence:1,scope:1n,environment:0n,operation:"napi_create_array_with_length",status:0,args:[17n],bytes:new Uint8Array()},encoded=encodeNativeFrame(frame);
  const owner=Object.prototype,key=Symbol.iterator,define=Object.defineProperty,original=Object.getOwnPropertyDescriptor(owner,key);let traps=0;
  define(owner,key,{configurable:true,get(){traps++;return undefined;}});let decoded:NativeFrame;
  try{decoded=decodeNativeFrame(encoded.subarray(4));}finally{if(original===undefined)Reflect.deleteProperty(owner,key);else define(owner,key,original);}
  expect(decoded).toEqual(frame);expect(traps).toBe(0);
});
