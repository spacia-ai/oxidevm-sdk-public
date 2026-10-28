import {exactKeys,integer,record,string} from "./runtime/decode.js";
import {VMError} from "./runtime/errors.js";
import type {SnapshotData} from "./snapshot-authoring.js";
export interface AuthoringProcess {readonly name:string;readonly pid:number;readonly snapshotKey:string;readonly kind:"process"|"terminal"}
export interface AuthoringReceipt {readonly format:"oxidevm-snapshot-authoring";readonly schemaVersion:1;readonly data:SnapshotData;readonly processes:readonly AuthoringProcess[]}
export function isAuthoringName(value:unknown):value is string {return typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value);}
export function authoringName(value:unknown):string {
  if(!isAuthoringName(value))invalid();return value;
}
export function snapshotData(value:unknown):SnapshotData {
  const seen=new Set<object>();let nodes=0,totalBytes=0;
  const charge=(text:string)=>{totalBytes+=new TextEncoder().encode(text).length;if(totalBytes>1024**2)invalid();};
  const decode=(value:unknown,depth:number):SnapshotData=>{
    if(++nodes>65_536||depth>64)invalid();
    if(value===null||typeof value==="boolean"||typeof value==="string"){charge(String(value));return value;}
    if(typeof value==="number"){if(!Number.isFinite(value))invalid();charge(String(value));return value;}
    if(typeof value!=="object"||seen.has(value))invalid();
    seen.add(value);
    try{
      if(Array.isArray(value))return Array.from<unknown>(value).map(child=>decode(child,depth+1));
      const prototype:unknown=Object.getPrototypeOf(value);
      if(prototype!==null&&prototype!==Object.prototype||Object.getOwnPropertySymbols(value).length!==0)invalid();
      const source=record(value,"author data"),output:Record<string,SnapshotData>={};
      for(const [key,child] of Object.entries(source)){
        if(key.length>8192)invalid();
        charge(key);
        Object.defineProperty(output,key,{value:decode(child,depth+1),enumerable:true,writable:false});
      }
      return output;
    }finally{seen.delete(value);}
  };
  return decode(value,0);
}
export function decodeAuthoringReceipt(value:unknown):AuthoringReceipt {
  const receipt=record(value,"authoring receipt");exactKeys(receipt,["format","schemaVersion","data","processes"]);
  if(receipt["format"]!=="oxidevm-snapshot-authoring"||receipt["schemaVersion"]!==1||!Array.isArray(receipt["processes"])||receipt["processes"].length>64)invalid();
  const names=new Set<string>(),keys=new Set<string>();
  const processes=Array.from<unknown>(receipt["processes"]).map((value):AuthoringProcess=>{
    const process=record(value,"authoring process");exactKeys(process,["name","pid","snapshotKey","kind"]);
    const name=authoringName(process["name"]),snapshotKey=string(process["snapshotKey"],"process key"),kind=process["kind"];
    if(snapshotKey.length===0||snapshotKey.length>256||kind!=="process"&&kind!=="terminal"||names.has(name)||keys.has(snapshotKey))invalid();
    names.add(name);keys.add(snapshotKey);
    return {name,pid:integer(process["pid"],"original PID",1,0x7fff_ffff),snapshotKey,kind};
  });
  return {format:"oxidevm-snapshot-authoring",schemaVersion:1,data:snapshotData(receipt["data"]),processes};
}
export function encodeAuthoringReceipt(receipt:AuthoringReceipt):Uint8Array<ArrayBuffer> {
  const bytes=new TextEncoder().encode(JSON.stringify(decodeAuthoringReceipt(receipt)));if(bytes.length>1024**2)invalid();return bytes;
}
export function readAuthoringReceipt(bytes:Uint8Array|null):AuthoringReceipt|undefined {
  if(bytes===null)return undefined;
  if(bytes.length>1024**2)invalid();
  let value:unknown;
  try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{return undefined;}
  if(typeof value!=="object"||value===null||!("format" in value)||value.format!=="oxidevm-snapshot-authoring")return undefined;
  return decodeAuthoringReceipt(value);
}
function invalid():never {throw new VMError("INVALID_ARGUMENT","Snapshot authoring receipt is invalid",{reason:"snapshot-recipe-invalid"});}
