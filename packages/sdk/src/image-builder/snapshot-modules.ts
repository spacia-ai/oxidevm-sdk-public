import {builtinModules} from "node:module";
import {mkdir,writeFile} from "node:fs/promises";
import {dirname,join,relative,sep} from "node:path";
import {build,type Plugin} from "esbuild";
import type {ResolvedSnapshotRecipe} from "./snapshot-recipe.js";
import {hash,readSourceFile} from "./files.js";
import {VMError} from "../runtime/errors.js";
import {abortIfRequested} from "./tools.js";
import {localBundlePath} from "./bundle-files.js";
export interface CompiledSnapshotArtifact {readonly path:string;readonly bytes:number;readonly sha256:string}
export interface CompiledSnapshotModules {
  readonly preparation:{readonly kind:"module"|"shell";readonly artifact:CompiledSnapshotArtifact};
  readonly verification:CompiledSnapshotArtifact;
}
function browserInputs(root:string):Plugin {
  const builtins=new Set(builtinModules.map(name=>name.replace(/^node:/u,"")));
  return {name:"oxidevm-browser-author",setup(builder){
    builder.onResolve({filter:/.*/},args=>{
      if(args.path==="@oxidevm/sdk")return {path:args.path,external:true};
      if(args.path.startsWith("node:")||builtins.has(args.path)||args.path.startsWith("@oxidevm/sdk/"))throw new VMError("INVALID_ARGUMENT","Author modules require browser dependencies");
      return undefined;
    });
    builder.onLoad({filter:/.*/},async args=>{
      const from=relative(root,args.path);
      if(from===".."||from.startsWith(`..${sep}`))throw new VMError("INVALID_ARGUMENT","Author dependency escapes its directory");
      const path=await localBundlePath(root,from);
      const bytes=await readSourceFile(path,16*1024**2);
      const loader=/\.tsx$/u.test(path)?"tsx":/\.[cm]?ts$/u.test(path)?"ts":/\.jsx$/u.test(path)?"jsx":/\.json$/u.test(path)?"json":/\.[cm]?js$/u.test(path)?"js":undefined;
      if(loader===undefined)throw new VMError("INVALID_ARGUMENT","Author dependencies must be JavaScript, TypeScript or JSON");
      return {contents:new TextDecoder().decode(bytes.bytes),loader,resolveDir:dirname(path)};
    });
  }};
}
/** Browser ESM retains one external SDK import, resolved by the harness import map. */
export async function compileSnapshotModule(source:string,root:string,out:string,signal?:AbortSignal):Promise<CompiledSnapshotArtifact> {
  abortIfRequested(signal);
  try{
    const result=await build({entryPoints:[source],bundle:true,format:"esm",platform:"browser",target:"es2024",write:false,
      logLevel:"silent",plugins:[browserInputs(root)],external:["@oxidevm/sdk"]});
    abortIfRequested(signal);
    const output=result.outputFiles[0];
    if(output===undefined||output.contents.length>16*1024**2)throw new VMError("INVALID_ARGUMENT","Compiled author module exceeds its bound");
    await mkdir(dirname(out),{recursive:true});await writeFile(out,output.contents);
    return {path:out,bytes:output.contents.length,sha256:hash(output.contents)};
  }catch(error){
    if(error instanceof VMError)throw error;
    throw new VMError("INVALID_ARGUMENT","Browser author module compilation failed",{reason:"snapshot-recipe-invalid"});
  }
}
export async function compileSnapshotModules(recipe:ResolvedSnapshotRecipe,outDir:string,signal?:AbortSignal):Promise<CompiledSnapshotModules> {
  await mkdir(outDir,{recursive:true});
  const verification=await compileSnapshotModule(recipe.verificationPath,recipe.recipeDir,join(outDir,"verify.mjs"),signal);
  if("shell" in recipe.workload){
    const source=await readSourceFile(recipe.preparationPath,16*1024**2,signal),path=join(outDir,"prepare.sh");
    await writeFile(path,source.bytes);
    return {preparation:{kind:"shell",artifact:{path,bytes:source.bytes.length,sha256:hash(source.bytes)}},verification};
  }
  const artifact=await compileSnapshotModule(recipe.preparationPath,recipe.recipeDir,join(outDir,"prepare.mjs"),signal);
  return {preparation:{kind:"module",artifact},verification};
}
