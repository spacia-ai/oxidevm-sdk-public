import {chmod,lstat,mkdir,rename,rm,writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {basename,dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {VMError} from "../runtime/errors.js";
import type {ProjectLock,ResolvedProjectConfig} from "./project.js";
import type {InstallAssetsOptions,InstallAssetsResult} from "./assets.js";
import {checkedOutput,installStaticAssets} from "./assets.js";
import {readSnapshotBundle} from "./snapshot-bundle.js";
import {SNAPSHOT_REFERENCE_MARKER,snapshotReferenceSource} from "./snapshot-reference.js";
import {copyEngineRelease,pinnedEngineRelease,resolveEngineDirectory} from "./engine-source.js";
import {copyVerified,hashFile} from "./files.js";
import {localBundlePath,readBundleFile} from "./bundle-files.js";
import {abortIfRequested} from "./tools.js";
export async function installSnapshotAssets(directory:string,config:ResolvedProjectConfig,lock:ProjectLock,options:InstallAssetsOptions):Promise<InstallAssetsResult> {
  if(options.trust===undefined||options.snapshotDir===undefined)throw new VMError("INVALID_ARGUMENT","Prepared snapshot installation requires external author trust");
  const bundle=await readSnapshotBundle(resolve(directory,options.snapshotDir),options.trust,options.signal),index=bundle.index;
  if(index.mode!==config.mode||index.sdkVersion!==lock.sdkVersion||`sha256:${index.engineReleaseId}`!==lock.engineRelease)throw new VMError("PROTOCOL_ERROR","Snapshot bundle differs from the project's SDK, engine or mode lock");
  const referencePath=await checkedOutput(directory,options.referencePath??`src/generated/${index.name}.snapshot.ts`);
  const old=await referenceContents(referencePath);
  if(old!==undefined&&!old.startsWith(SNAPSHOT_REFERENCE_MARKER))throw new VMError("PERMISSION_DENIED","Reference path contains an existing author file");
  const engine=pinnedEngineRelease(),engineDir=await resolveEngineDirectory({...(options.engineDir===undefined?{}:{engineDir:resolve(directory,options.engineDir)}),...(options.engineComplianceDir===undefined?{}:{engineComplianceDir:resolve(directory,options.engineComplianceDir)}),...(options.signal===undefined?{}:{signal:options.signal})},engine);
  const publicDir=resolve(directory,config.publicDir),base=new URL(config.assetBaseUrl,"https://project.invalid"),assets=await checkedOutput(publicDir,decodeURIComponent(base.pathname).replace(/^\/+|\/+$/gu,""));
  await checkedOutput(directory,config.publicDir);await mkdir(assets,{recursive:true});
  const relative=`snapshots/${bundle.digest}`,target=await checkedOutput(assets,relative),files=[{url:"snapshot.lock.json",bytes:(await lstat(join(bundle.directory,"snapshot.lock.json"))).size,sha256:bundle.digest},
    index.snapshot,index.verifier,index.reports.build,index.reports.test,...index.artifacts];
  for(const file of files){
    const path=await checkedOutput(target,file.url),present=await lstat(path).catch(()=>undefined);
    if(present!==undefined){if(!present.isFile()||present.size!==file.bytes||await hashFile(path,options.signal)!==file.sha256)throw new VMError("PROTOCOL_ERROR","Immutable snapshot assets differ");}
    else await copyVerified(await localBundlePath(bundle.directory,file.url),path,file,options.signal);
    await chmod(path,0o644);
  }
  const engineFiles=await copyEngineRelease(engineDir,await checkedOutput(assets,"runtime"),engine,options.signal,options.engineComplianceDir===undefined?undefined:resolve(directory,options.engineComplianceDir));
  const doctorFiles=await installStaticAssets(fileURLToPath(new URL("../../assets/doctor/",import.meta.url)),await checkedOutput(assets,"doctor"),options.signal);
  const hostingBase=`${config.assetBaseUrl}${relative}/`,temporary=`${referencePath}.installing-${randomUUID()}`;
  await mkdir(dirname(referencePath),{recursive:true});
  try{
    await writeFile(temporary,snapshotReferenceSource(index,hostingBase),{flag:"wx"});abortIfRequested(options.signal);
    await checkedOutput(directory,referencePath);
    if(await referenceContents(referencePath)!==old)throw new VMError("PERMISSION_DENIED","Reference changed while assets were copied");
    await rename(temporary,referencePath);
  }
  finally{await rm(temporary,{force:true});}
  await writeFile(join(assets,"project.json"),JSON.stringify({schemaVersion:2,engineRelease:lock.engineRelease,assetBaseUrl:config.assetBaseUrl,mode:config.mode})+"\n");
  return {publicDir,files:files.length+engineFiles+doctorFiles+1,referencePath};
}
async function referenceContents(path:string):Promise<string|undefined> {
  try{return new TextDecoder().decode(await readBundleFile(dirname(path),basename(path),16*1024**2));}
  catch(error){if(typeof error==="object"&&error!==null&&"code" in error&&error.code==="ENOENT")return undefined;throw error;}
}
