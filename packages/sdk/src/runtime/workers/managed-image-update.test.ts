import {afterEach,expect,it,vi} from "vitest";
import {checkManagedImageUpdate} from "./managed-image-update.js";

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

it.each(["headers","body"])("bounds stalled update %s and releases queued storage work",async stage=>{
  vi.useFakeTimers();
  const cancelled=vi.fn(),url="https://images.example.test/manifest.json";
  vi.stubGlobal("fetch",vi.fn<typeof fetch>((_input,options)=>{
    if(stage==="body")return Promise.resolve(new Response(new ReadableStream<Uint8Array>({cancel:cancelled})));
    return new Promise<Response>((_resolve,reject)=>{
      options?.signal?.addEventListener("abort",()=>{cancelled();reject(new DOMException("cancelled","AbortError"));},{once:true});
    });
  }));
  let result:unknown,released=false;
  const pending=checkManagedImageUpdate(url,{id:"installed",version:"one"},{});
  const queued=pending.catch((error:unknown)=>{result=error;}).then(()=>{released=true;});
  await vi.advanceTimersByTimeAsync(2_000);
  expect(result).toMatchObject({code:"STORAGE_ERROR"});
  expect(cancelled).toHaveBeenCalledOnce();
  expect(released).toBe(true);
  await queued;
});

it("preserves caller cancellation while waiting for update metadata",async()=>{
  const lifetime=new AbortController();
  vi.stubGlobal("fetch",vi.fn<typeof fetch>((_input,options)=>new Promise<Response>((_resolve,reject)=>{
    options?.signal?.addEventListener("abort",()=>reject(new DOMException("cancelled","AbortError")),{once:true});
  })));
  const result=checkManagedImageUpdate("https://images.example.test/manifest.json",{id:"installed",version:"one"},{signal:lifetime.signal});
  const checked=expect(result).rejects.toMatchObject({code:"ABORTED"});
  lifetime.abort();await checked;
});
