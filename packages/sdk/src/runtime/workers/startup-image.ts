import {decodeSHA256} from "../../values.js";
// Read-only pre-VM inspection. No workspace lease, recovery, activation or directory creation.
import type { InspectStartImageRequest, PreparedStartImage } from "../protocol/start-image.js";
import { VMError } from "../errors.js";
import { validateWorkspaceId } from "../workspace-path.js";
import { verifyManagedImageManifest, managedImageUrl } from "../managed-image.js";
import { readDiskHead, readGenerationRecord, managedImageStem } from "./managed-disk-head.js";
import { loadPinnedImage, baseIsKept, keptBootAsset, keptImageByManifest } from "./managed-image-pins.js";
import { SnapshotCatalog } from "./snapshot-catalog.js";
import { USERSPACE_SNAPSHOT_SCHEMA, type SnapshotManifest } from "./snapshot-manifest.js";
import { WorkspaceSelections } from "./workspace-selections.js";
import { opfsWorkspaceStoreBackend } from "./workspace-backend.js";
import { RootfsStore } from "./rootfs-store.js";
import { sha256Hex } from "./snapshot-content.js";
import { isNotFound } from "./snapshot-objects.js";

type NativeSelection={source:NonNullable<Awaited<ReturnType<typeof RootfsStore.inspectCachedCheckpoint>>>;memoryMiB?:number};
type StoredSelection=PreparedStartImage|NativeSelection|null;
type NativeStart={manifestUrl:string;manifestSHA256:string};
export async function inspectStartImage(request:InspectStartImageRequest,signal:AbortSignal):Promise<PreparedStartImage|null> {
  active(signal);
  if(request.resume==="fresh-image"||request.resume==="update-image") return null;
  if(!("storage" in navigator)||typeof navigator.storage.getDirectory!=="function") return null;
  return inspectStoredStartImage(await navigator.storage.getDirectory(),request,signal);
}
export async function inspectStoredStartImage(origin:FileSystemDirectoryHandle,request:InspectStartImageRequest,signal:AbortSignal):Promise<PreparedStartImage|null> {
  active(signal); validateWorkspaceId(request.workspaceId);
  if(request.resume==="fresh-image"||request.resume==="update-image") return null;
  const retained=await retainedOrTrustChanged(()=>inspectStoredSelection(origin,request,signal))??await retainedOrTrustChanged(()=>inspectInstalledImage(origin,request,signal));
  const selected=retained!==null&&"source" in retained?await nativeSource(retained.source,request,signal,retained.memoryMiB):retained;
  if(selected===null||request.mode!=="userspace"||selected.image.manifestSHA256===request.manifestSHA256)return selected;
  const root=await directory(origin,"oxidevm");
  const requested=root===undefined?undefined:await RootfsStore.inspectCachedImage(root,request.manifestUrl,{keyId:request.trustedKeyId,publicKey:new Uint8Array(request.trustedPublicKey)},request.manifestSHA256);
  return requested===undefined||requested.id===selected.image.id&&requested.version===selected.image.version?selected:{...selected,update:{id:requested.id,version:requested.version}};
}

/**
 * Saved state signed by another key than the app now configures is never booted. Name the
 * key it was signed with and the explicit ways forward instead of a bare trust failure.
 */
async function retainedOrTrustChanged(inspect:()=>Promise<StoredSelection>):Promise<StoredSelection> {
  try {return await inspect();}
  catch(error) {
    if(!(error instanceof VMError)||error.detail?.["reason"]!=="untrusted-key")throw error;
    const keyId=error.detail["keyId"];
    throw new VMError("PROTOCOL_ERROR",`This workspace was saved with an image signed by another key${typeof keyId==="string"?` (${keyId})`:""}; open it with resume: "update-image" to move it to the configured image, or use another workspaceId`,{reason:"image-trust-changed",...(typeof keyId==="string"?{keyId}:{})});
  }
}

async function inspectInstalledImage(origin:FileSystemDirectoryHandle,request:InspectStartImageRequest,signal:AbortSignal):Promise<StoredSelection> {
  active(signal);const root=await directory(origin,"oxidevm");if(root===undefined)return null;
  if(request.mode==="system")return systemImage(root,undefined,request,signal);
  const source=await RootfsStore.inspectInstalledImage(root,request.manifestSHA256,{keyId:request.trustedKeyId,publicKey:request.trustedPublicKey.slice()});
  active(signal);return source===undefined?null:{source};
}
// Diagnostic preparation accepts the legacy signed-root formats already admitted by
// RootfsStore. It authenticates the same retained source without projecting it as a
// public whole-manifest image identity.
export async function inspectStoredNativeStart(origin:FileSystemDirectoryHandle,request:InspectStartImageRequest,signal:AbortSignal):Promise<NativeStart|null> {
  active(signal);validateWorkspaceId(request.workspaceId);
  if(request.mode!=="userspace")throw new VMError("PROTOCOL_ERROR","Native startup requires the Userspace runtime");
  if(request.resume==="fresh-image"||request.resume==="update-image")return null;
  const retained=await inspectStoredSelection(origin,request,signal);
  if(retained===null)return null;
  if(!("source" in retained))throw new VMError("PROTOCOL_ERROR","Native startup selected another runtime");
  active(signal);
  return {manifestUrl:retained.source.url.href,manifestSHA256:await sha256Hex(retained.source.bytes)};
}
async function inspectStoredSelection(origin:FileSystemDirectoryHandle,request:InspectStartImageRequest,signal:AbortSignal):Promise<StoredSelection> {
  const oxidevm=await directory(origin,"oxidevm");if(oxidevm===undefined) return null;
  const workspaces=await directory(oxidevm,"workspaces");if(workspaces===undefined) return null;
  const workspace=await directory(workspaces,request.workspaceId);if(workspace===undefined) return null;
  const snapshots=await directory(workspace,"snapshots-v2");
  const explicit=typeof request.resume==="object";
  if(explicit) {
    const snapshot=snapshots===undefined?undefined:await SnapshotCatalog.inspect(snapshots,request.resume.id);
    if(snapshot===undefined||snapshot.createdAt!==request.resume.createdAt) throw new VMError("STORAGE_NOT_FOUND","requested restore point is not retained");
    if((snapshot.schema===USERSPACE_SNAPSHOT_SCHEMA?"userspace":"system")!==request.mode) throw new VMError("FEATURE_NOT_AVAILABLE","restore point belongs to another runtime",{reason:"runtime-mismatch"});
    return request.mode==="system"?systemImage(oxidevm,workspace,request,signal,snapshot):nativeImage(oxidevm,request,signal,snapshot);
  }
  if(request.mode==="system") return systemImage(oxidevm,workspace,request,signal);
  const overlays=await directory(oxidevm,"workspace-overlays");
  const overlay=overlays===undefined?undefined:await directory(overlays,request.workspaceId);
  if(overlay===undefined) return null;
  const session=await new WorkspaceSelections(opfsWorkspaceStoreBackend(overlay)).session();
  if(session?.image!==undefined&&session.resume===null&&session.recovery===undefined) {
    const source=await RootfsStore.inspectCachedImagePin(oxidevm,{workspaceId:request.workspaceId,snapshotId:session.image},{keyId:request.trustedKeyId,publicKey:request.trustedPublicKey.slice()});
    if(source===undefined)throw new VMError("STORAGE_NOT_FOUND","Selected native image pin is missing");
    return {source};
  }
  if(snapshots===undefined)return null;
  const chosen=request.resume==="pre-resume"?session?.recovery:session?.recovery??session?.resume;
  if(chosen===undefined||chosen===null) return null;
  const hidden=await directory(snapshots,"native-recovery");
  const saved=await inspectUsable(snapshots,chosen)??(hidden===undefined?undefined:await inspectUsable(hidden,chosen));
  if(saved!==undefined) {
    const selected=await nativeImage(oxidevm,request,signal,saved);
    if(selected!==null) return selected;
  }
  if(request.resume!=="latest"||saved===undefined) return null;
  for(const older of await SnapshotCatalog.inspectList(snapshots)) {
    active(signal);
    if(older.schema!==USERSPACE_SNAPSHOT_SCHEMA||older.kind!=="automatic"||older.capturedAtUnixMs>=saved.capturedAtUnixMs) continue;
    const selected=await nativeImage(oxidevm,request,signal,older);if(selected!==null) return selected;
  }
  return null;
}
/** A restore point from an older build is not a start point: the start proceeds as if it were absent. */
async function inspectUsable(root: FileSystemDirectoryHandle, id: string): Promise<SnapshotManifest | undefined> {
  try {
    return await SnapshotCatalog.inspect(root, id);
  } catch (error) {
    if (error instanceof VMError && error.code === "SNAPSHOT_VERSION") return undefined;
    throw error;
  }
}
async function systemImage(oxidevm:FileSystemDirectoryHandle,workspace:FileSystemDirectoryHandle|undefined,request:InspectStartImageRequest,signal:AbortSignal,snapshot?:SnapshotManifest):Promise<PreparedStartImage|null> {
  active(signal);
  const disks=workspace===undefined?undefined:await directory(workspace,"managed-disks");
  const images=await directory(oxidevm,"managed-images");if(images===undefined) return null;
  let identity:string|undefined;
  if(snapshot!==undefined&&snapshot.schema!==USERSPACE_SNAPSHOT_SCHEMA&&snapshot.disk?.origin==="managed") identity=snapshot.disk.baseIdentity;
  else if(disks!==undefined) {
    const head=await readDiskHead(disks);
    const name=request.resume==="pre-resume"?head?.previous??head?.generation:head?.generation;
    const generation=name===undefined?undefined:await directory(disks,name);
    identity=generation===undefined?undefined:(await readGenerationRecord(generation))?.image.identity;
  }
  const pinned=identity===undefined?await keptImageByManifest(images,managedImageUrl(request.manifestUrl),request.manifestSHA256):await loadPinnedImage(images,identity);
  if(pinned===undefined) return null;
  if(pinned.manifest.schemaVersion!==9) throw new VMError("PROTOCOL_ERROR","retained public image is not whole-manifest signed");
  await verifyManagedImageManifest(pinned.manifest,{keyId:request.trustedKeyId,publicKey:request.trustedPublicKey.slice()});
  const stem=managedImageStem(pinned.ref);
  if(!await baseIsKept(images,stem,pinned.ref.identity)||await keptBootAsset(images,stem,"kernel",pinned.manifest.kernel)===undefined||pinned.manifest.initrd!==undefined&&await keptBootAsset(images,stem,"initrd",pinned.manifest.initrd)===undefined) return null;
  // The committed installation supplies availability; the base lease authenticates chunks on use.
  const pack=await (await images.getFileHandle(`${stem}.pack`)).getFile();
  if(pack.size!==pinned.manifest.disk.chunks.reduce((sum,chunk)=>sum+chunk.bytes,0))throw new VMError("STORAGE_ERROR","Retained managed base is incomplete",{reason:"image-not-cached"});
  active(signal);
  const manifest=pinned.manifest;
  return {image:{id:manifest.id,version:manifest.version,mode:"system",manifestSHA256:decodeSHA256(await sha256Hex(new TextEncoder().encode(pinned.manifestText)),"signed manifest digest"),cpuProfile:manifest.cpuProfile,keyId:request.trustedKeyId,signatureVerified:true},manifestUrl:pinned.url.href,memoryMiB:snapshot!==undefined&&snapshot.schema!==USERSPACE_SNAPSHOT_SCHEMA?snapshot.machine.memoryBytes/1024**2:manifest.memoryMiB,vcpus:manifest.vcpus};
}
async function nativeImage(oxidevm:FileSystemDirectoryHandle,request:InspectStartImageRequest,signal:AbortSignal,snapshot:SnapshotManifest):Promise<NativeSelection|null> {
  if(snapshot.schema!==USERSPACE_SNAPSHOT_SCHEMA) return null;active(signal);
  // This chooses signed image authority; native admission verifies every required body.
  const source=await RootfsStore.inspectCachedImagePin(oxidevm,{workspaceId:request.workspaceId,snapshotId:snapshot.id},{keyId:request.trustedKeyId,publicKey:request.trustedPublicKey.slice()});
  if(source===undefined) return null;
  const hash=await sha256Hex(source.bytes),manifest=source.manifest,expected=snapshot.rootfs;
  if(expected.manifest.sha256!==hash||expected.manifest.bytes!==source.bytes.length||expected.image.id!==manifest.id||expected.image.version!==manifest.version||expected.rootTreeSha256!==manifest.rootTreeSha256) throw new VMError("STORAGE_ERROR","retained rootfs source differs from its committed restore point");
  active(signal);
  return {source,memoryMiB:snapshot.compatibility.memoryBytes/1024**2};
}
async function nativeSource(source:Awaited<ReturnType<typeof RootfsStore.inspectCachedCheckpoint>> & {},request:InspectStartImageRequest,signal:AbortSignal,memoryMiB?:number):Promise<PreparedStartImage> {
  active(signal);const manifest=source.manifest;
  if(manifest.schemaVersion<5)throw new VMError("PROTOCOL_ERROR","Retained public native image requires a whole-manifest signature");
  return {image:{id:manifest.id,version:manifest.version,mode:"userspace",manifestSHA256:decodeSHA256(await sha256Hex(source.bytes),"retained manifest digest"),cpuProfile:manifest.cpuProfile,keyId:request.trustedKeyId,signatureVerified:true},manifestUrl:source.url.href,memoryMiB:memoryMiB??manifest.resources?.memoryMiB??256,...(manifest.resources?.maxProcesses===undefined?{}:{maxProcesses:manifest.resources.maxProcesses})};
}
async function directory(root:FileSystemDirectoryHandle,name:string):Promise<FileSystemDirectoryHandle|undefined> {
  try {return await root.getDirectoryHandle(name);} catch(error) {if(isNotFound(error)) return undefined;throw error;}
}
function active(signal:AbortSignal):void {if(signal.aborted) throw new VMError("ABORTED","retained image inspection was cancelled");}
