import {chromium,firefox,webkit,type BrowserContext} from "playwright";
import type {SnapshotBrowserRunner} from "../image-builder/browser-automation.js";
import {decodeSnapshotPreviewRequest,decodeSnapshotPreviewResponse} from "../snapshot-authoring-protocol.js";
import {VMError} from "../runtime/errors.js";
import {abortIfRequested} from "../image-builder/tools.js";

async function preview(context:BrowserContext,input:unknown,origin:string):Promise<unknown> {
  const request=decodeSnapshotPreviewRequest(input),url=new URL(request.url);
  const root=new URL(origin);
  if(url.protocol!=="http:"||url.port!==root.port||!/^[a-f0-9]{32}\.preview\.localhost$/u.test(url.hostname)||url.username!==""||url.password!==""||url.hash!==""||url.pathname.startsWith("/__oxidevm/"))throw new VMError("PROTOCOL_ERROR","Authoring preview origin is invalid");
  const page=await context.newPage();
  const timer=setTimeout(()=>{void page.close().catch(()=>{});},request.timeoutMs);
  try{
    await page.goto(url.origin,{waitUntil:"domcontentloaded",timeout:Math.min(request.timeoutMs,60_000)});
    await page.waitForFunction(()=>navigator.serviceWorker.controller!==null,undefined,{timeout:request.timeoutMs});
    const value:unknown=await page.evaluate(async({url,timeoutMs})=>{
      if(navigator.serviceWorker.controller===null)throw new Error("Preview is not service-worker controlled");
      const response=await fetch(url,{signal:AbortSignal.timeout(timeoutMs),cache:"no-store",credentials:"omit"});
      if(response.body===null)return {status:response.status,body:"",transportError:response.headers.has("X-OxideVM-Preview-Error")};
      const reader=response.body.getReader(),decoder=new TextDecoder();let body="",bytes=0;
      try{
        for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>1024**2)throw new Error("Preview body exceeds its bound");body+=decoder.decode(next.value,{stream:true});}
        body+=decoder.decode();
      }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      return {status:response.status,body,transportError:response.headers.has("X-OxideVM-Preview-Error")};
    },request);
    return decodeSnapshotPreviewResponse(value);
  }finally{clearTimeout(timer);await page.close();}
}

export const runSnapshotBrowser:SnapshotBrowserRunner["runSnapshotBrowser"]=async options=>{
  const browser=options.browser==="chromium"?chromium:options.browser==="firefox"?firefox:webkit;
  const deadline=AbortSignal.timeout(options.timeoutMs),signal=AbortSignal.any([deadline,...(options.signal===undefined?[]:[options.signal])]);
  let context:BrowserContext|undefined;
  const abort=()=>{void context?.close().catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
  try{
    abortIfRequested(signal);
    context=await browser.launchPersistentContext(options.profile,{headless:true});
    abortIfRequested(signal);const current=context,actual=current.browser();
    if(actual===null)throw new VMError("FEATURE_NOT_AVAILABLE","Browser identity is unavailable");
    const page=await current.newPage();
    await page.exposeBinding("oxidevmSnapshotPreview",(_source,input:unknown)=>preview(current,input,options.origin));
    await page.goto(options.origin,{waitUntil:"domcontentloaded",timeout:60_000});
    const result=page.locator('#oxidevm-snapshot[data-done="true"]');await result.waitFor({state:"attached",timeout:options.timeoutMs});
    const serialized=await result.textContent();
    if(serialized===null||Buffer.byteLength(serialized)>1024**2)throw new VMError("PROTOCOL_ERROR","Authoring browser result exceeds its bound");
    const value:unknown=JSON.parse(serialized);
    return {browser:{name:options.browser,version:actual.version()},result:value};
  }catch(error){
    if(deadline.aborted)throw new VMError("ABORTED","Snapshot browser deadline expired",{reason:"snapshot-build-timeout"});
    if(options.signal?.aborted===true)abortIfRequested(options.signal);
    if(error instanceof VMError)throw error;
    throw new VMError("FEATURE_NOT_AVAILABLE","Snapshot browser could not complete its action");
  }finally{signal.removeEventListener("abort",abort);await context?.close();}
};
