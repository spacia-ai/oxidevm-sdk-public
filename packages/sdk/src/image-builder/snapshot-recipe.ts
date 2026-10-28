import {lstat,realpath} from "node:fs/promises";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {decodePublicVMOptions} from "../vm-options.js";
import {decodeShippedName} from "../runtime/managed-start.js";
import {validateRestorePointName} from "../runtime/protocol/snapshots.js";
import {exactKeys,integer,record,string} from "../runtime/decode.js";
import {VMError} from "../runtime/errors.js";
import {decodeImageLocation,type TrustedImageKey} from "../image.js";
import {defaultImage} from "../default-image.js";
import type {SnapshotBrowser,SnapshotTimeouts,SnapshotWorkload} from "../snapshot-authoring.js";
import type {BuildSnapshotOptions,SnapshotRecipe,SnapshotRecipeCommon} from "./snapshot-contracts.js";
import {hash,readSourceFile} from "./files.js";
import {localBundlePath} from "./bundle-files.js";
import {inspectImageFiles,type InspectedImageFiles} from "./bundle.js";
import {defaultImageCacheDir} from "./assets.js";
import {downloadBundle} from "./download.js";
import {readReleaseCatalog} from "./release-catalog.js";
import {getSDKRelease} from "./project.js";
import {readImageTrust} from "./keys.js";
import {abortIfRequested} from "./tools.js";
import {canonicalOutputPath,containsPath} from "./output-path.js";

export const SNAPSHOT_DEFAULT_TIMEOUTS:Required<SnapshotTimeouts>={buildMs:10_800_000,commandMs:900_000,readyMs:900_000,captureMs:1_800_000,verifyMs:1_800_000};
export interface SnapshotFile {readonly from:string;readonly to:string;readonly bytes:number;readonly sha256:string}
export type ResolvedSnapshotRecipe=SnapshotRecipe & {
  readonly recipeDir:string;readonly signingKeyFile:string;readonly label:string;readonly browser:SnapshotBrowser;
  readonly outDir:string;readonly publicBaseUrl:string;readonly timeouts:Required<SnapshotTimeouts>;
  readonly maxDownloadBytes:number;readonly stagedFiles:readonly SnapshotFile[];
  readonly preparationPath:string;readonly verificationPath:string;
};
export function snapshotBrowser(value:unknown):SnapshotBrowser {
  if(value==="chromium"||value==="firefox"||value==="webkit")return value;
  throw new VMError("INVALID_ARGUMENT","Snapshot browser must be chromium, firefox or webkit");
}
export function snapshotTimer(value:unknown,label:string):number {return integer(value,label,1,2_147_483_647);}
function text(value:unknown,label:string):string {
  const result=string(value,label);
  if(result.length===0||result.length>8192||result.includes("\0"))throw new VMError("INVALID_ARGUMENT",`${label} is invalid`);
  return result;
}
export function decodeSnapshotRecipe(value:unknown):SnapshotRecipe {
  try{return decodeRecipe(value);}catch(error){
    if(error instanceof VMError&&(error.code==="PROTOCOL_ERROR"||error.code==="INVALID_ARGUMENT"))throw new VMError("INVALID_ARGUMENT","Snapshot recipe is invalid",{reason:"snapshot-recipe-invalid"});
    throw error;
  }
}
function decodeRecipe(value:unknown):SnapshotRecipe {
  const input=record(value,"snapshot recipe");
  exactKeys(input,["name","mode","image","workload","verify"],["label","imageTrust","files","browser","outDir","publicBaseUrl","timeouts","maxDownloadBytes","vm"]);
  const name=decodeShippedName(input["name"]);if(name===undefined)throw new VMError("INVALID_ARGUMENT","Snapshot name is required");
  const workload=record(input["workload"],"workload");let decodedWorkload:SnapshotWorkload;
  if(workload["module"]!==undefined){exactKeys(workload,["module"]);decodedWorkload={module:text(workload["module"],"preparation module")};}
  else{exactKeys(workload,["shell"]);decodedWorkload={shell:text(workload["shell"],"preparation shell")};}
  const verify=record(input["verify"],"verification");exactKeys(verify,["module"]);
  const timeouts=input["timeouts"]===undefined?undefined:record(input["timeouts"],"timeouts");
  const decodedTimeouts:SnapshotTimeouts={};
  if(timeouts!==undefined){
    exactKeys(timeouts,[],["buildMs","commandMs","readyMs","captureMs","verifyMs"]);
    for(const key of ["buildMs","commandMs","readyMs","captureMs","verifyMs"] as const)if(timeouts[key]!==undefined)Object.assign(decodedTimeouts,{[key]:snapshotTimer(timeouts[key],key)});
  }
  let files:SnapshotRecipeCommon["files"];
  if(input["files"]!==undefined){
    if(!Array.isArray(input["files"])||input["files"].length>4096)throw new VMError("INVALID_ARGUMENT","Staged file list is invalid");
    files=Array.from<unknown>(input["files"]).map(value=>{const file=record(value,"staged file");exactKeys(file,["from","to"]);return {from:text(file["from"],"source"),to:guestDestination(file["to"])};});
  }
  const common:SnapshotRecipeCommon={name,image:text(input["image"],"image"),workload:decodedWorkload,verify:{module:text(verify["module"],"verification module")},
    ...(input["label"]===undefined?{}:{label:validateRestorePointName(input["label"])}),
    ...(input["imageTrust"]===undefined?{}:{imageTrust:text(input["imageTrust"],"image trust")}),
    ...(files===undefined?{}:{files}),...(input["browser"]===undefined?{}:{browser:snapshotBrowser(input["browser"])}),
    ...(input["outDir"]===undefined?{}:{outDir:text(input["outDir"],"output")}),
    ...(input["publicBaseUrl"]===undefined?{}:{publicBaseUrl:publicBase(input["publicBaseUrl"])}),
    ...(timeouts===undefined?{}:{timeouts:decodedTimeouts}),
    ...(input["maxDownloadBytes"]===undefined?{}:{maxDownloadBytes:integer(input["maxDownloadBytes"],"download limit",1,16*1024**3)})};
  const mode=input["mode"];
  if(mode!=="system"&&mode!=="userspace")throw new VMError("INVALID_ARGUMENT","Snapshot mode is invalid");
  const vm=input["vm"]===undefined?undefined:record(input["vm"],"snapshot resources");
  if(vm===undefined)return {...common,mode};
  exactKeys(vm,[],mode==="system"?["memoryMiB","vcpus","network"]:["memoryMiB","limits","initialUser","rootPersistence","network"]);
  const options=decodePublicVMOptions({...vm,mode,...(mode==="userspace"?{commandInterceptors:"off"}:{}),workspaceId:"snapshot-authoring-validation"});
  if(options.mode==="system")return {...common,mode:"system",vm:{...(options.memoryMiB===undefined?{}:{memoryMiB:options.memoryMiB}),...(vm["vcpus"]===undefined?{}:{vcpus:options.vcpus}),network:options.network}};
  return {...common,mode:"userspace",vm:{...(options.memoryMiB===undefined?{}:{memoryMiB:options.memoryMiB}),...(vm["limits"]===undefined?{}:{limits:options.limits}),...(options.initialUser===undefined?{}:{initialUser:options.initialUser}),...(options.rootPersistence===undefined?{}:{rootPersistence:options.rootPersistence}),network:options.network}};
}
function guestDestination(value:unknown):string {
  const path=text(value,"guest destination");
  if(!path.startsWith("/workspace/")||path.includes("\\")||path.includes("%")||path.slice(1).split("/").some(part=>part==="."||part===".."||part===""))throw new VMError("INVALID_ARGUMENT","Staged destination must be an unambiguous /workspace path");
  return path;
}
function publicBase(value:unknown):string {
  const textValue=value instanceof URL?value.href:text(value,"public base");
  decodeImageLocation(textValue.endsWith("/")?`${textValue}manifest.json`:`${textValue}/manifest.json`);
  const url=new URL(textValue,"https://reference.invalid");
  if(url.search!==""||url.hash!=="")throw new VMError("INVALID_ARGUMENT","Public base must name a directory");
  return textValue.endsWith("/")?textValue:`${textValue}/`;
}
export async function loadSnapshotRecipe(path:string):Promise<SnapshotRecipe> {
  try{
    const module:unknown=await import(pathToFileURL(resolve(path)).href);
    return decodeSnapshotRecipe(record(module,"snapshot recipe module")["default"]);
  }catch{throw new VMError("INVALID_ARGUMENT","Snapshot recipe could not be loaded",{reason:"snapshot-recipe-invalid"});}
}
export async function resolveSnapshotRecipe(input:SnapshotRecipe,options:BuildSnapshotOptions,operation:"build"|"pack"="build"):Promise<ResolvedSnapshotRecipe> {
  abortIfRequested(options.signal);
  const recipe=decodeSnapshotRecipe(input),recipeDir=await realpath(resolve(options.recipeDir));
  const outDir=await canonicalOutputPath(resolve(recipeDir,options.outDir??recipe.outDir??"dist"));
  const signingKeyFile=await canonicalOutputPath(resolve(recipeDir,options.signingKeyFile));
  const keyIdentity=await lstat(signingKeyFile).catch(()=>undefined);
  if(containsPath(outDir,recipeDir)||containsPath(outDir,signingKeyFile))throw new VMError("INVALID_ARGUMENT","Output must not replace author inputs",{reason:"snapshot-input-unsafe"});
  const boundedInput=async(path:string)=> {
    const from=await localBundlePath(recipeDir,path);
    const metadata=await lstat(from);
    if(containsPath(outDir,from)||from===signingKeyFile||keyIdentity!==undefined&&metadata.dev===keyIdentity.dev&&metadata.ino===keyIdentity.ino)throw new VMError("INVALID_ARGUMENT","Snapshot input overlaps output or signing key",{reason:"snapshot-input-unsafe"});
    return from;
  };
  const preparationInput="module" in recipe.workload?recipe.workload.module:recipe.workload.shell;
  const preparationPath=operation==="pack"?resolve(recipeDir,preparationInput):await boundedInput(preparationInput);
  const verificationPath=await boundedInput(recipe.verify.module);
  const stagedFiles:SnapshotFile[]=[];
  for(const file of operation==="pack"?[]:recipe.files??[]){
    if(stagedFiles.some(other=>other.to===file.to||other.to.startsWith(`${file.to}/`)||file.to.startsWith(`${other.to}/`)))throw new VMError("INVALID_ARGUMENT","Staged destinations overlap");
    const from=await boundedInput(file.from),source=await readSourceFile(from,16*1024**2,options.signal);
    stagedFiles.push({from,to:file.to,bytes:source.bytes.length,sha256:hash(source.bytes)});
  }
  for(const path of operation==="pack"?[verificationPath]:[preparationPath,verificationPath])await readSourceFile(path,16*1024**2,options.signal);
  if(recipe.image!=="default"){
    const image=await canonicalOutputPath(resolve(recipeDir,recipe.image));
    if(containsPath(outDir,image)||containsPath(image,outDir))throw new VMError("INVALID_ARGUMENT","Snapshot output overlaps the image input");
  }
  const timeouts={...SNAPSHOT_DEFAULT_TIMEOUTS,...recipe.timeouts,...(options.timeoutMs===undefined?{}:{buildMs:snapshotTimer(options.timeoutMs,"timeoutMs")})};
  return {...recipe,recipeDir,signingKeyFile,label:recipe.label??recipe.name,browser:snapshotBrowser(options.browser??recipe.browser??"chromium"),outDir,
    publicBaseUrl:publicBase(options.publicBaseUrl??recipe.publicBaseUrl??"/"),timeouts,maxDownloadBytes:recipe.maxDownloadBytes??2*1024**3,
    preparationPath,verificationPath,stagedFiles};
}
export async function resolveSnapshotImage(recipe:ResolvedSnapshotRecipe,trust?:TrustedImageKey,signal?:AbortSignal):Promise<InspectedImageFiles> {
  let bundle:string,anchor:TrustedImageKey;
  if(recipe.image==="default"){
    const pin=defaultImage(recipe.mode);anchor=trust??(recipe.imageTrust===undefined?pin.trust:await readImageTrust(resolve(recipe.recipeDir,recipe.imageTrust)));bundle=join(defaultImageCacheDir(),pin.manifestSHA256);
    if(await lstat(bundle).catch(()=>undefined)===undefined){
      const catalog=await readReleaseCatalog(),entry=catalog.images.find(entry=>entry.mode===recipe.mode&&entry.manifestSHA256===pin.manifestSHA256);
      if(entry===undefined||catalog.sdkVersion!==getSDKRelease().sdkVersion)throw new VMError("PROTOCOL_ERROR","Installed SDK has no matching default image");
      await downloadBundle(entry.archive,bundle,async staging=>{await inspectImageFiles(staging,{trust:anchor,...(signal===undefined?{}:{signal})});},signal);
    }
  }else{
    bundle=resolve(recipe.recipeDir,recipe.image);
    const selected=trust??(recipe.imageTrust===undefined?undefined:await readImageTrust(resolve(recipe.recipeDir,recipe.imageTrust)));
    if(selected===undefined)throw new VMError("INVALID_ARGUMENT","Custom snapshot images require external image trust");
    anchor=selected;
  }
  const inspected=await inspectImageFiles(bundle,{trust:anchor,...(signal===undefined?{}:{signal})});
  if(inspected.read.image.mode!==recipe.mode||recipe.image==="default"&&inspected.read.image.manifestSHA256!==defaultImage(recipe.mode).manifestSHA256)throw new VMError("INVALID_ARGUMENT","Image does not match snapshot mode and release pin");
  return inspected;
}
