import {createServer,type IncomingMessage,type ServerResponse} from "node:http";
import {open,rm,type FileHandle} from "node:fs/promises";
import {randomBytes} from "node:crypto";
import {dirname,basename} from "node:path";
import {decodeSnapshotTransport,SNAPSHOT_UPLOAD_SLICE_BYTES,type SnapshotTransport,type SnapshotTransportIdentity} from "../snapshot-authoring-protocol.js";
import {VMError} from "../runtime/errors.js";
import {isolatedHeaders,serveStaticFile} from "./static-files.js";
import {readBundleFile,decodeBundleJSON} from "./bundle-files.js";
import {record,string} from "../runtime/decode.js";
export interface SnapshotServerOptions {
  readonly identity:SnapshotTransportIdentity;readonly configuration:unknown;readonly backupPath:string;
  readonly browserDir:string;readonly engineDir:string;readonly previewDir:string;
  readonly files:ReadonlyMap<string,string>;
  readonly onMessage?:(message:SnapshotTransport)=>void;readonly signal?:AbortSignal;
}
export interface SnapshotServer {readonly origin:string;readonly previewOrigin:string;readonly backupPath:string;readonly identity:SnapshotTransportIdentity;close():Promise<void>}
export function snapshotToken():string{return randomBytes(32).toString("hex");}
async function requestBytes(request:IncomingMessage,maximum:number):Promise<Uint8Array<ArrayBuffer>> {
  const parts:Uint8Array[]=[];let bytes=0;
  const source:AsyncIterable<unknown>=request;
  for await(const raw of source){
    const value:unknown=raw;
    if(!(value instanceof Uint8Array))throw new VMError("PROTOCOL_ERROR","Authoring request is not bytes");
    bytes+=value.length;if(bytes>maximum)throw new VMError("PROTOCOL_ERROR","Authoring request exceeds its bound");
    parts.push(value);
  }
  const result=new Uint8Array(bytes);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;
}
export async function startSnapshotServer(options:SnapshotServerOptions):Promise<SnapshotServer> {
  const configuration=JSON.stringify(options.configuration);
  if(Buffer.byteLength(configuration)>1024**2)throw new VMError("INVALID_ARGUMENT","Authoring configuration exceeds its bound");
  let origin="",port="",nextSequence=1,busy=false,upload:FileHandle|undefined,written=0,total:number|undefined,completed=false;
  const previewHosts=new Set<string>();
  const previewHeaders=record(decodeBundleJSON(await readBundleFile(options.previewDir,"headers.json",16*1024)),"preview headers");
  const retire=async()=>{await upload?.close();upload=undefined;if(!completed&&total!==undefined)await rm(options.backupPath,{force:true});};
  const acceptSequence=(sequence:number)=>{if(sequence!==nextSequence)throw new VMError("PROTOCOL_ERROR","Authoring sequence is invalid");};
  const acknowledge=(response:ServerResponse)=>{nextSequence++;response.setHeader("Content-Type","application/json");response.end('{"ok":true}');};
  async function post(request:IncomingMessage,response:ServerResponse,path:string):Promise<void> {
    if(request.headers.origin!==origin||busy||options.signal?.aborted===true)throw new VMError("PROTOCOL_ERROR","Authoring request is refused");
    busy=true;
    try{
      if(path==="/upload"){
        if(request.headers.authorization!==`Bearer ${options.identity.token}`||upload===undefined||total===undefined)throw new VMError("PROTOCOL_ERROR","Upload is not open");
        const sequence=Number(request.headers["x-oxidevm-sequence"]),offset=Number(request.headers["x-oxidevm-offset"]);
        acceptSequence(sequence);if(offset!==written)throw new VMError("PROTOCOL_ERROR","Upload offset is invalid");
        const data=await requestBytes(request,SNAPSHOT_UPLOAD_SLICE_BYTES);
        if(data.length===0||written+data.length>total)throw new VMError("PROTOCOL_ERROR","Upload length is invalid");
        let offsetInSlice=0;
        while(offsetInSlice<data.length){const result=await upload.write(data,offsetInSlice,data.length-offsetInSlice,written+offsetInSlice);if(result.bytesWritten===0)throw new VMError("STORAGE_ERROR","Upload made no write progress");offsetInSlice+=result.bytesWritten;}
        written+=data.length;acknowledge(response);return;
      }
      const input:unknown=JSON.parse(new TextDecoder().decode(await requestBytes(request,16*1024)));
      const message=decodeSnapshotTransport(input);acceptSequence(message.sequence);
      if(message.buildId!==options.identity.buildId||message.token!==options.identity.token)throw new VMError("PROTOCOL_ERROR","Authoring identity is invalid");
      if(message.type==="upload-begin"){
        if(total!==undefined)throw new VMError("PROTOCOL_ERROR","Upload was already begun");
        upload=await open(options.backupPath,"wx",0o600);total=message.bytes;
      }else if(message.type==="upload-end"){
        if(upload===undefined||total===undefined||written!==total)throw new VMError("PROTOCOL_ERROR","Upload is incomplete");
        if((await upload.stat()).size!==total)throw new VMError("STORAGE_ERROR","Uploaded file size changed");
        await upload.sync();await upload.close();upload=undefined;completed=true;
      }else options.onMessage?.(message);
      acknowledge(response);
    }finally{busy=false;}
  }
  async function handle(request:IncomingMessage,response:ServerResponse):Promise<void> {
    isolatedHeaders(response);
    const host=request.headers.host;
    const primary=host===`127.0.0.1:${port}`;
    const preview=typeof host==="string"&&new RegExp(`^[a-f0-9]{32}\\.preview\\.localhost:${port}$`,"u").test(host);
    if(!primary&&!preview){response.writeHead(404);response.end();return;}
    const url=new URL(request.url??"/",origin);
    if(primary&&request.method==="POST"&&(url.pathname==="/transport"||url.pathname==="/upload")){
      if(url.search!=="")throw new VMError("PROTOCOL_ERROR","Invalid authoring operation path");
      try{await post(request,response,url.pathname);}catch(error){if(upload!==undefined&&error instanceof VMError&&error.code==="STORAGE_ERROR")await retire();throw error;}return;
    }
    if(request.method!=="GET"&&request.method!=="HEAD")throw new VMError("PROTOCOL_ERROR","Unsupported authoring method");
    if(primary&&url.pathname==="/fixture.json"){
      if(url.search!=="")throw new VMError("PROTOCOL_ERROR","Invalid configuration path");
      response.setHeader("Content-Type","application/json");response.end(request.method==="HEAD"?undefined:configuration);return;
    }
    if(primary&&url.pathname==="/"){
      response.setHeader("Content-Type","text/html");
      response.end('<!doctype html><html><head><meta charset="UTF-8"><title>OxideVM snapshot authoring</title><script type="importmap">{"imports":{"@oxidevm/sdk":"/snapshot/sdk.js"}}</script></head><body><script type="module" src="/snapshot/client.js"></script></body></html>');return;
    }
    if(preview){
      if(url.pathname==="/__oxidevm/keeper.html"&&url.searchParams.get("parentOrigin")===origin&&url.searchParams.get("session")===url.hostname.split(".")[0]&&[...url.searchParams.keys()].length===2) {
        if(previewHosts.size>=64)throw new VMError("PROTOCOL_ERROR","Preview session bound exceeded");
        if(typeof host==="string")previewHosts.add(host);
      }
      if(typeof host!=="string"||!previewHosts.has(host)){response.writeHead(404);response.end();return;}
      for(const [name,value] of Object.entries(previewHeaders))response.setHeader(name,string(value,"preview header"));
      response.setHeader("Cross-Origin-Resource-Policy","cross-origin");response.setHeader("Cross-Origin-Opener-Policy","same-origin-allow-popups");response.setHeader("Service-Worker-Allowed","/");
      const path=url.pathname.startsWith("/__oxidevm/")?decodeURIComponent(url.pathname.slice("/__oxidevm/".length)):"index.html";
      await serveStaticFile(request,response,options.previewDir,path);return;
    }
    if(url.search!=="")throw new VMError("PROTOCOL_ERROR","Invalid asset query");
    const specific=options.files.get(url.pathname);
    if(specific!==undefined){await serveStaticFile(request,response,dirname(specific),basename(specific));return;}
    const route=url.pathname.startsWith("/oxidevm/runtime/")?{prefix:"/oxidevm/runtime/",root:options.engineDir}:url.pathname.startsWith("/snapshot/")?{prefix:"/snapshot/",root:options.browserDir}:undefined;
    if(route===undefined){response.writeHead(404);response.end();return;}
    await serveStaticFile(request,response,route.root,decodeURIComponent(url.pathname.slice(route.prefix.length)));
  }
  const server=createServer((request,response)=>{void handle(request,response).catch(()=>{if(!response.headersSent)response.writeHead(404);response.end();});});
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const address=server.address();
  if(address===null||typeof address==="string")throw new VMError("STORAGE_ERROR","Authoring loopback server did not open");
  port=String(address.port);origin=`http://127.0.0.1:${port}`;
  const abort=()=>{void retire().catch(()=>{});};options.signal?.addEventListener("abort",abort,{once:true});
  return {origin,previewOrigin:`http://preview.localhost:${port}`,backupPath:options.backupPath,identity:options.identity,close:async()=>{
    options.signal?.removeEventListener("abort",abort);
    server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error===undefined?resolve():reject(error)));await retire();
  }};
}
