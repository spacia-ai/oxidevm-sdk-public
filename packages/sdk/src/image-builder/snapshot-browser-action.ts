import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {record,exactKeys,string} from "../runtime/decode.js";
import type {SnapshotBrowser} from "../snapshot-authoring.js";
import type {InspectedImageFiles} from "./bundle.js";
import {resolveEngineDirectory} from "./engine-source.js";
import {startSnapshotServer,snapshotToken} from "./snapshot-server.js";
import {loadSnapshotBrowserRunner} from "./browser-automation.js";
import {decodeSnapshotBrowserResult,type SnapshotBrowserResult} from "./snapshot-browser-result.js";
import type {SnapshotRun} from "./snapshot-run.js";
export interface SnapshotBrowserAction {
  readonly action:"prepare"|"verify";readonly image:InspectedImageFiles;readonly imageDirectory:string;
  readonly browser:SnapshotBrowser;readonly configuration:Readonly<Record<string,unknown>>;readonly files:ReadonlyMap<string,string>;
  readonly backupPath:string;readonly engineDir?:string;readonly timeoutMs:number;readonly run:SnapshotRun;
}
export async function runSnapshotAction(input:SnapshotBrowserAction):Promise<{browser:{name:SnapshotBrowser;version:string};result:SnapshotBrowserResult}> {
  const engineDir=await resolveEngineDirectory({...(input.engineDir===undefined?{}:{engineDir:input.engineDir}),signal:input.run.signal});
  const files=new Map(input.files);
  const base=input.image.read.base;
  for(const file of input.image.files)files.set(new URL(file.relative,base).pathname,join(input.imageDirectory,file.relative));
  const identity={version:1 as const,buildId:input.run.buildId,token:snapshotToken()};
  const profile=await mkdtemp(join(tmpdir(),"oxidevm-snapshot-browser-"));
  try{
    const server=await startSnapshotServer({identity,configuration:{...input.configuration,version:1,action:input.action,identity,
      image:{mode:input.image.read.image.mode,manifestUrl:base.pathname,manifestSHA256:input.image.read.image.manifestSHA256,trust:input.image.read.image.trust}},backupPath:input.action==="verify"?join(profile,"unused-upload.oxvm"):input.backupPath,
      browserDir:fileURLToPath(new URL("../../assets/snapshot/",import.meta.url)),previewDir:fileURLToPath(new URL("../../assets/preview/",import.meta.url)),engineDir,files,
      signal:input.run.signal,onMessage:message=>{if(message.type==="progress")input.run.emit(message.phase,message.completedBytes===undefined?undefined:{completedBytes:message.completedBytes,totalBytes:message.totalBytes??message.completedBytes});}});
    try{
      const runner=await loadSnapshotBrowserRunner(),raw=record(await runner.runSnapshotBrowser({origin:server.origin,browser:input.browser,profile,
        timeoutMs:Math.min(input.timeoutMs,input.run.remaining()),signal:input.run.signal}),"browser action");
      exactKeys(raw,["browser","result"]);const browser=record(raw["browser"],"actual browser");exactKeys(browser,["name","version"]);
      if(browser["name"]!==input.browser)throw new Error("Browser identity differs");
      return {browser:{name:input.browser,version:string(browser["version"],"actual browser version")},result:decodeSnapshotBrowserResult(raw["result"])};
    }finally{await server.close();}
  }finally{await rm(profile,{recursive:true,force:true});}
}
