import {decodeManagedImageSnapshots,managedImageUrl} from "../managed-image.js";
import type {ManagedImageSnapshot} from "../managed-image.js";
import {record,string} from "../decode.js";
import {VMError} from "../errors.js";
export interface PreparedShippedListing {readonly name:string;readonly manifest:{readonly url:string;readonly bytes:number;readonly sha256:string};readonly bytes:number}
/** Reconstructs bounded signed catalog entries from their plain structured-clone wire form. */
export function decodePreparedShippedListings(value:unknown):PreparedShippedListing[] {
  if(!Array.isArray(value)||value.length>16) throw new VMError("PROTOCOL_ERROR","prepared shipped starts must be a bounded list");
  if(value.length===0)return [];
  const first=record(value[0],"prepared shipped start"),artifact=record(first["manifest"],"prepared shipped start manifest");
  const url=managedImageUrl(string(artifact["url"],"prepared shipped start URL"));
  const base=new URL("../../",url);
  const listings:ManagedImageSnapshot[]=decodeManagedImageSnapshots(value,base);
  return listings.map(listing=>({...listing,manifest:{...listing.manifest,url:listing.manifest.url.href}}));
}
