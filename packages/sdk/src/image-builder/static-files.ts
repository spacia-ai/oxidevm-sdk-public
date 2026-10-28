import {constants} from "node:fs";
import {open} from "node:fs/promises";
import type {IncomingMessage,ServerResponse} from "node:http";
import {pipeline} from "node:stream/promises";
import {localBundlePath} from "./bundle-files.js";
const MEDIA=new Map([["js","text/javascript"],["mjs","text/javascript"],["wasm","application/wasm"],["json","application/json"],["html","text/html"],["css","text/css"],["map","application/json"]]);
export function isolatedHeaders(response:ServerResponse):void {
  for(const [name,value] of Object.entries({"Cross-Origin-Opener-Policy":"same-origin","Cross-Origin-Embedder-Policy":"require-corp","Cross-Origin-Resource-Policy":"same-origin","X-Content-Type-Options":"nosniff","Cache-Control":"no-store"}))response.setHeader(name,value);
}
export async function serveStaticFile(request:IncomingMessage,response:ServerResponse,root:string,path:string):Promise<void> {
  const file=await open(await localBundlePath(root,path),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const metadata=await file.stat();
    response.setHeader("Content-Type",MEDIA.get(path.split(".").at(-1)??"")??"application/octet-stream");
    response.setHeader("Content-Length",metadata.size);
    if(request.method==="HEAD"){response.end();return;}
    await pipeline(file.createReadStream({autoClose:false}),response);
  }finally{await file.close();}
}
