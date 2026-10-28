import {mkdir,writeFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import {VMError} from "@oxidevm/sdk";
export async function newDirectory(directory:string):Promise<void> {
  await mkdir(dirname(directory),{recursive:true});
  try{await mkdir(directory);}catch{throw new VMError("INVALID_ARGUMENT","Choose a new directory; scaffolding preserves existing files");}
}
export async function file(directory:string,path:string,text:string):Promise<void> {await writeFile(join(directory,path),text,{flag:"wx"});}
