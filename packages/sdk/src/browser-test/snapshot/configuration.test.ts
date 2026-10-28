import {generateKeyPairSync} from "node:crypto";
import {afterEach,expect,it,vi} from "vitest";
import {assertSnapshotBrowserSupport,openSnapshotVM} from "./configuration.js";
import {createVM} from "./sdk.js";
import type * as SnapshotSDK from "./sdk.js";
vi.mock("../../runtime/browser-support.js",()=>({detectBrowserSupport:()=>({supported:true})}));
vi.mock("./sdk.js",async original=>({...await original<typeof SnapshotSDK>(),createVM:vi.fn()}));
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
for(const absent of ["storage","locks"]){
  it(`reports typed unavailability when navigator.${absent} is absent`,()=>{
    vi.stubGlobal("isSecureContext",true);vi.stubGlobal("crossOriginIsolated",true);vi.stubGlobal("indexedDB",{});
    vi.stubGlobal("navigator",{storage:{getDirectory(){}},locks:{request(){}},serviceWorker:{},[absent]:undefined});
    let failure:unknown;
    try{assertSnapshotBrowserSupport();}catch(error){failure=error;}
    expect(failure).toMatchObject({code:"FEATURE_NOT_AVAILABLE"});
  });
}
it.each(["user","root"])("keeps native snapshot %s authoring independent of acceleration assets",async initialUser=>{
  vi.stubGlobal("location",new URL("http://localhost:5173/"));
  const failure=new Error("reached native VM creation");
  vi.mocked(createVM).mockRejectedValueOnce(failure);
  const publicKey=generateKeyPairSync("ed25519").publicKey.export({format:"der",type:"spki"}).toString("base64");
  await expect(openSnapshotVM({image:{mode:"userspace",manifestUrl:"/image.json",manifestSHA256:"ab".repeat(32),trust:{algorithm:"Ed25519",keyId:"test",publicKey}},vm:{initialUser}},"userspace","prepare",new AbortController().signal)).rejects.toBe(failure);
  expect(createVM).toHaveBeenCalledWith(expect.objectContaining({mode:"userspace",initialUser,commandInterceptors:"off"}));
});
