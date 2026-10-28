import {exactKeys,integer,record} from "../../decode.js";
import type {WorkspaceStoreBackend} from "../workspace-store.js";
import {parseJson} from "../workspace-manifest.js";
const PATH="selections/legacy-fallback.json",MAXIMUM=128*1024;
const BARRIER=new TextEncoder().encode('{"formatVersion":2147483647,"selectedBy":"workspace-generations-v1"}');
/** Frozen legacy inputs keep the previous committed outcome readable after an upgrade crash.
 * Obsolete readers fail on the physical barriers rather than resurrecting replaced files. */
export async function readLegacySelection(raw:WorkspaceStoreBackend,generation:number):Promise<unknown> {
 const bytes=await raw.read(PATH,MAXIMUM);if(bytes===undefined)return undefined;
 const value=record(parseJson(bytes),"legacy selection fallback");exactKeys(value,["version","generation","selected"]);
 integer(value["version"],"legacy selection version",1,1);
 return integer(value["generation"],"legacy selection generation",0)===generation?value["selected"]:undefined;
}
export async function guardLegacyFiles(raw:WorkspaceStoreBackend,generation:number,selected:ReadonlyMap<string,string|null>,scopes:readonly string[]):Promise<void> {
 const bytes=new TextEncoder().encode(JSON.stringify({version:1,generation,selected:[...selected]}));
 if(bytes.length>MAXIMUM)throw new Error("Legacy selection fallback exceeds its bound");
 await raw.write(PATH,bytes);
 for(const scope of scopes) {
  await raw.write(`${scope}active.json`,BARRIER);
  await raw.write(`${scope}intent.json`,BARRIER);
 }
}
