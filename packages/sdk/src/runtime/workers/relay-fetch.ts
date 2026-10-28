import { exactKeys, integer, record, string } from "../decode.js";
import { relayError } from "../relay-errors.js";
export interface RelayFetchOptions {
  readonly maximumBytes: number; readonly allowedOrigins: readonly string[];
  readonly accept: "application/json" | "application/vnd.npm.install-v1+json" | "application/octet-stream";
}
export interface RelayFetchHeaders {readonly status:number; readonly headers:Readonly<Record<string,string>>}
export function relayFetchPayload(target:string,options:RelayFetchOptions):Uint8Array<ArrayBuffer> {
  const url=new URL(target);
  if(url.protocol!=="https:"||url.username!==""||url.password!==""||url.hash!==""||url.href.length>4096||!options.allowedOrigins.includes(url.origin)||options.allowedOrigins.length===0||options.allowedOrigins.length>16||!Number.isSafeInteger(options.maximumBytes)||options.maximumBytes<0||options.maximumBytes>512*1024*1024)throw relayError("destination-denied");
  const bytes=new TextEncoder().encode(JSON.stringify({url:url.href,...options}));
  if(bytes.length>65536)throw relayError("quota-exceeded");return bytes;
}
export function decodeRelayFetchHeaders(bytes:Uint8Array):RelayFetchHeaders {
  if(bytes.length>32768)throw relayError("protocol-error");
  const value:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  const input=record(value,"relay response headers");exactKeys(input,["status","headers"]);
  const status=integer(input["status"],"HTTP status",200,599);
  const headers=record(input["headers"],"response headers");let size=0;
  const entries=Object.entries(headers).map(([key,value])=>{
    const text=string(value,"header value");size+=key.length+text.length;
    if(!["content-type","cache-control","etag","last-modified"].includes(key)||/[\r\n\0]/.test(text)||text.length>4096||size>16384)throw relayError("protocol-error");
    return [key,text] satisfies readonly [string,string];
  });return {status,headers:Object.fromEntries(entries)};
}
