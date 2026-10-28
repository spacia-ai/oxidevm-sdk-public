import {decodeUserspaceRootfsManifest,userspaceTreeIdentity,MAX_ROOTFS_METADATA_BYTES} from "../userspace-rootfs.js";
import type {RootfsCheckpointSource} from "./rootfs-checkpoints.js";
import {readRootfsCache} from "./rootfs-cached-image.js";
import {names,sha256,type Backend} from "./rootfs-store-backend.js";
const CACHE_URL=new URL("https://oxidevm-rootfs-cache.invalid/manifest.json");
/** The workspace hash authenticates the complete tree, including file digests and metadata. */
export async function cachedWorkspaceSource(backend:Backend,base:string,active:RootfsCheckpointSource|undefined):Promise<RootfsCheckpointSource|undefined> {
 if(active?.manifest.workspaceBaseSha256===base)return active;
 for(const name of await names(backend,"manifests")) {
  try {
   const bytes=await readRootfsCache(backend,"manifests",name,MAX_ROOTFS_METADATA_BYTES);if(bytes===undefined)continue;
   const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);if(!text.includes(base))continue;
   const manifest=decodeUserspaceRootfsManifest(JSON.parse(text) as unknown,CACHE_URL);if(manifest.workspaceBaseSha256!==base)continue;
   const identity=await userspaceTreeIdentity(manifest.entries,manifest.blobs,manifest.schemaVersion);
   if(identity.workspaceBaseSha256===base)return {manifest,bytes,url:CACHE_URL,digest:await sha256(bytes)};
  }catch{ /* A damaged cache entry is not an authority for the requested tree. */ }
 }
 return undefined;
}
