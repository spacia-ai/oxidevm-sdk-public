import { readBrowserQuota } from "./browser-quota.js";
import { DISK_RESERVE_BYTES } from "./browser-quota.js";
import type { ImagePreparationProgress } from "./rootfs-image-preparation.js";
import type { UserspaceSnapshotManifest } from "./snapshot-manifest.js";
import {cachedWorkspaceSource} from "./rootfs-workspace-source.js";
import {cachedRootfsImage,requestedRootfsImage,readRootfsCache} from "./rootfs-cached-image.js";
import {openCachedRootfsFile} from "./rootfs-file-read.js";
import type {WorkspaceReadLease} from "./workspace-read.js";
import {decodeSHA256} from "../../values.js";
import { record, string } from "../decode.js";
import { VMError } from "../errors.js";
import type { ImagePreparation } from "../../values.js";
import type { ImageAcquisitionReason } from "../protocol/image-preparation.js";
import {
  decodeUserspaceRootfsManifest,
  encodeUserspaceRootfsMetadata,
  verifyUserspaceRootfsManifest,
  rootfsClosure,
  type UserspaceRootfsManifest,
  type UserspaceRootfsBlob,
  type TrustedRootfsKey,
} from "../userspace-rootfs.js";
import { managedImageUrl } from "../managed-image.js";
import type { PreparedImageIdentity,PreparedUserspaceRootfs } from "../protocol/storage.js";
import type { RootfsNetworkClient } from "./rootfs-network-channel.js";
import type { UserspaceRootfsRead } from "./userspace-storage-channel.js";
import { buildWorkspaceDelta } from "./workspace-delta.js";
import type { WorkspaceImage } from "./workspace-rebase.js";

import { activate, remove, verifiedFile, verifiedBytes, openDatabase, sha256, type Backend } from "./rootfs-store-backend.js";
import { RootfsCheckpoints, type RootfsCheckpointOwner, type RootfsCheckpointSource, type RootfsCheckpointDestination, type RootfsCheckpointBaseline } from "./rootfs-checkpoints.js";
export type { RootfsCheckpointOwner, RootfsCheckpointDestination, RootfsCheckpointBaseline } from "./rootfs-checkpoints.js";

export class RootfsStore {
  #imagePreparation: ImagePreparation = "on-demand";
  #localOnly = false;
  #requestedImage:{readonly id:string;readonly version:string}|undefined;
  #foreignWorkspace:{readonly source:RootfsCheckpointSource;readonly retire:()=>void}|undefined;
  #identity:PreparedImageIdentity|undefined;
  #prepared:PreparedUserspaceRootfs|undefined;
  #preparedCheckpoint:{readonly owner:RootfsCheckpointOwner;readonly source:RootfsCheckpointSource;readonly files:ReadonlyMap<string,UserspaceRootfsBlob>}|undefined;
  readonly #backend: Backend;
  readonly #network: RootfsNetworkClient;
  #active: UserspaceRootfsManifest | undefined;
  #activeSource: RootfsCheckpointSource | undefined;
  readonly #checkpoints: RootfsCheckpoints;
  #activeFiles = new Map<string, UserspaceRootfsBlob>();

  private constructor(backend: Backend, network: RootfsNetworkClient) {
    this.#backend = backend;
    this.#network = network;
    this.#checkpoints = new RootfsCheckpoints(backend, network);
  }

  static opfs(root: FileSystemDirectoryHandle, network: RootfsNetworkClient): RootfsStore {
    return new RootfsStore({ kind: "opfs", root }, network);
  }

  static inspectCachedCheckpoint(root: FileSystemDirectoryHandle, owner: RootfsCheckpointOwner, trusted: TrustedRootfsKey): Promise<RootfsCheckpointSource | undefined> {
    return RootfsCheckpoints.inspectCached({ kind: "opfs", root }, owner, trusted);
  }

  static inspectCachedImagePin(root:FileSystemDirectoryHandle,owner:RootfsCheckpointOwner,trusted:TrustedRootfsKey):Promise<RootfsCheckpointSource|undefined> {
    return RootfsCheckpoints.inspectCachedImage({kind:"opfs",root},owner,trusted);
  }

  static inspectInstalledImage(root:FileSystemDirectoryHandle,digest:string,trusted:TrustedRootfsKey):Promise<RootfsCheckpointSource|undefined> {
    return RootfsCheckpoints.inspectCachedImage({kind:"opfs",root},installedOwner(digest),trusted,digest);
  }

  static inspectCachedImage(root:FileSystemDirectoryHandle,href:string,trusted:TrustedRootfsKey,digest?:string):Promise<PreparedImageIdentity|undefined> {
    return cachedRootfsImage({kind:"opfs",root},href,trusted,digest);
  }

  inspectCachedImage(href:string,trusted:TrustedRootfsKey,digest?:string):Promise<PreparedImageIdentity|undefined> {
    return cachedRootfsImage(this.#backend,href,trusted,digest);
  }

  async inspectRequestedImage(href:string,trusted:TrustedRootfsKey,digest?:string,signal?:AbortSignal,cachedOnly=false):Promise<void> {
    this.#requestedImage=cachedOnly ? await cachedRootfsImage(this.#backend,href,trusted,digest)
      : await requestedRootfsImage(this.#backend,this.#network,{href,trusted,...(digest===undefined?{}:{digest})},signal);
  }

  async checkForUpdate(href:string,trusted:TrustedRootfsKey,digest?:string,signal?:AbortSignal):Promise<{readonly id:string;readonly version:string}|null> {
    const before=this.#activeSource;
    const offer=await requestedRootfsImage(this.#backend,this.#network,{href,trusted,...(digest===undefined?{}:{digest})},signal);
    if(before===undefined||this.#activeSource!==before||offer===undefined||offer.id===before.manifest.id&&offer.version===before.manifest.version)return null;
    this.#requestedImage=offer;return offer;
  }

  static indexedDb(network: RootfsNetworkClient): RootfsStore {
    return new RootfsStore({ kind: "indexeddb", database: openDatabase() }, network);
  }

  async prepare(manifestHref: string, trusted: TrustedRootfsKey, manifestSHA256?: string,cachedOnly=false,signal?:AbortSignal,imagePreparation:ImagePreparation="on-demand"): Promise<PreparedUserspaceRootfs> {
    this.#imagePreparation = imagePreparation;
    this.#checkpoints.beginPreparation();
    try {
      const manifestUrl = managedImageUrl(manifestHref);
      const bytes = await this.#fetchOrCachedManifest(manifestUrl,manifestSHA256,cachedOnly,signal);
      const manifestDigest=await sha256(bytes);
      if (manifestSHA256 !== undefined && manifestDigest !== manifestSHA256) throw new VMError("PROTOCOL_ERROR", "Userspace manifest digest differs from its pin");
      let decoded: unknown;
      try {
        decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw new VMError("PROTOCOL_ERROR", "Userspace rootfs manifest is not valid UTF-8 JSON");
      }
      const manifest = decodeUserspaceRootfsManifest(decoded, manifestUrl);
      await verifyUserspaceRootfsManifest(manifest, trusted);
      const evidence = manifest.provenance;
      for (const blob of [
        evidence.sbom,
        evidence.notices,
        evidence.correspondingSources,
        evidence.reproducibility,
      ]) {
        try {
          const packed=await this.#checkpoints.packs.openFile(manifest,manifestDigest,blob,signal??new AbortController().signal,()=>{});
          if(packed!==undefined){await packed.retire();continue;}
        } catch { signal?.throwIfAborted(); /* An unavailable packed cache may still have a valid loose representation. */ }
        if (!await verifiedFile(this.#backend, "blobs", blob.sha256, blob.bytes, blob.sha256)) {
          if(cachedOnly && imagePreparation !== "before-ready") throw new VMError("STORAGE_ERROR","retained rootfs evidence is not cached",{reason:"image-not-cached"});
          await this.#checkpoints.ensureBlob(blob,signal);
          if (!await verifiedFile(this.#backend, "blobs", blob.sha256, blob.bytes, blob.sha256)) {
            await remove(this.#backend, "blobs", blob.sha256);
            throw new VMError("STORAGE_ERROR", "persisted rootfs blob failed verification");
          }
        }
      }
      signal?.throwIfAborted();
      await activate(this.#backend, manifestUrl, manifest, bytes);
      this.#activeSource = { manifest, bytes, url: manifestUrl, digest:manifestDigest };
      if(!cachedOnly)this.#requestedImage={id:manifest.id,version:manifest.version};
      return this.#setActive(manifest,manifestDigest,trusted.keyId);
    } finally { this.#checkpoints.endPreparation(); }
  }

  #setActive(manifest: UserspaceRootfsManifest,digest:string,keyId:string): PreparedUserspaceRootfs {
    this.#active = manifest;
    this.#activeFiles=filesOf(manifest);
    this.#requestedImage??={id:manifest.id,version:manifest.version};
    const result=this.#describe(manifest,digest,keyId);
    this.#identity=result.identity;this.#prepared=result;return result;
  }

  #describe(manifest:UserspaceRootfsManifest,digest:string,keyId:string):PreparedUserspaceRootfs {
    const requested=this.#requestedImage;
    const update=requested===undefined||requested.id===manifest.id&&requested.version===manifest.version?undefined:requested;
    return {...prepared(manifest,digest,keyId),...(update===undefined?{}:{update})};
  }

  currentRootfs():PreparedUserspaceRootfs {
    if(this.#prepared===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","No verified rootfs is active");
    return this.#prepared;
  }

  currentIdentity():PreparedImageIdentity {
    if(this.#identity===undefined) throw new VMError("FEATURE_NOT_AVAILABLE","no verified Userspace image is active");
    return {...this.#identity};
  }

  async openCachedFile(path:string,sha256:string,bytes:number,signal:AbortSignal,snapshotId?:string):Promise<WorkspaceReadLease> {
    const selected=snapshotId===undefined?undefined:this.#preparedCheckpoint;
    if(snapshotId!==undefined&&selected?.owner.snapshotId!==snapshotId)throw new VMError("PROTOCOL_ERROR","Rootfs read has no verified selected checkpoint source");
    const source=snapshotId===undefined?this.#activeSource:selected?.source;
    const files=source===this.#activeSource?this.#activeFiles:selected?.files;
    const blob=files?.get(path.startsWith("/")?path.slice(1):path);
    if(source===undefined||blob===undefined||blob.sha256!==sha256||blob.bytes!==bytes)throw new VMError("PROTOCOL_ERROR","Rootfs read differs from the verified active image");
    const release=await this.#checkpoints.retainRead(source, signal);
    try {const packed=await this.#checkpoints.packs.openFile(source.manifest,source.digest,blob,signal,release,true);if(packed!==undefined)return packed;}
    catch(error){if(signal.aborted){release();throw error;} /* Original cached files remain a valid fallback. */ }
    return openCachedRootfsFile(this.#backend,blob,signal,release);
  }

  async read(path: string): Promise<UserspaceRootfsRead> {
    const manifest = this.#active;
    if (manifest === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "no Userspace rootfs is active");
    const normalized = path.startsWith("/") ? path.slice(1) : path;
    const blob = this.#activeFiles.get(normalized);
    if (blob === undefined) throw new VMError("STORAGE_NOT_FOUND", `rootfs file does not exist: ${path}`);
    const bytes = await this.#readBlob(blob);
    return { sha256: blob.sha256, bytes };
  }

  /** A file of the active image by its content hash, for prepared starts that leave image files out. */
  async readImageFile(sha256: string, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
    const blob = this.#active?.blobs.find(candidate => candidate.sha256 === sha256 && candidate.bytes === bytes);
    if (blob === undefined) throw new VMError("STORAGE_NOT_FOUND", "the active image holds no such file");
    return this.#readBlob(blob);
  }

  buildWorkspaceDelta(snapshot: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const manifest = this.#active;
    if (manifest?.workspaceBaseSha256 === undefined) {
      throw new VMError("STORAGE_ERROR", "active rootfs has no shared workspace identity", {
        reason: "workspace-base-missing",
      });
    }
    return buildWorkspaceDelta(snapshot, manifest.entries, manifest.blobs);
  }

  /**
   * The /workspace tree of the image whose workspace base is `workspaceBaseSha256`: the active one,
   * or one this browser cached earlier. The cached manifest is checked against that identity, which
   * hashes the whole workspace tree; undefined when no cached image matches.
   */
  async workspaceImage(workspaceBaseSha256: string): Promise<WorkspaceImage | undefined> {
    const source=await cachedWorkspaceSource(this.#backend,workspaceBaseSha256,this.#activeSource);
    return source===undefined?undefined:{entries:source.manifest.entries,blobs:source.manifest.blobs};
  }

  async workspaceBaseMetadata(base:string):Promise<{readonly metadata:Uint8Array}|undefined> {
    if(this.#preparedCheckpoint===undefined&&this.#activeSource===undefined)throw new VMError("PROTOCOL_ERROR","Workspace base inspection requires a verified image");
    const source=await cachedWorkspaceSource(this.#backend,base,this.#activeSource);
    this.#foreignWorkspace?.retire();this.#foreignWorkspace=undefined;
    if(source===undefined)return undefined;
    this.#foreignWorkspace={source,retire:await this.#checkpoints.retainRead(source)};
    return {metadata:encodeUserspaceRootfsMetadata(source.manifest)};
  }

  retireWorkspaceBase():void {this.#foreignWorkspace?.retire();this.#foreignWorkspace=undefined;}

  async openWorkspaceBaseFile(base:string,path:string,sha256:string,bytes:number,signal:AbortSignal):Promise<WorkspaceReadLease> {
    const source=this.#foreignWorkspace?.source;
    const normalized=path.startsWith("/")?path.slice(1):path;
    if(source?.manifest.workspaceBaseSha256!==base||!normalized.startsWith("workspace/"))throw new VMError("PROTOCOL_ERROR","Workspace file has no admitted foreign base");
    const blob=filesOf(source.manifest).get(normalized);
    if(blob===undefined||blob.sha256!==sha256||blob.bytes!==bytes)throw new VMError("PROTOCOL_ERROR","Workspace file differs from its proven base");
    const release = await this.#checkpoints.retainRead(source, signal);
    try {
      const packed = await this.#checkpoints.packs.openFile(source.manifest, source.digest, blob, signal, release, true);
      if (packed !== undefined) return packed;
    } catch(error) { if(signal.aborted) { release(); throw error; } }
    return await openCachedRootfsFile(this.#backend,blob,signal,release);
  }

  /** A file of any image this browser cached, verified by its digest; undefined when absent. */
  cachedBlob(sha256: string, bytes: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
    if (!/^[0-9a-f]{64}$/u.test(sha256)) return Promise.resolve(undefined);
    return verifiedBytes(this.#backend, "blobs", sha256, bytes, sha256);
  }

  pinImage(owner:RootfsCheckpointOwner) {
    if(this.#activeSource===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","No verified rootfs is active");
    return this.#localOnly ? this.#checkpoints.pinInstalledImage(owner,this.#activeSource,installedOwner(this.#activeSource.digest))
      : this.#checkpoints.pinImage(owner,this.#activeSource);
  }

  captureCheckpoint(owner: RootfsCheckpointOwner, progress?: (completedObjects: number) => void, baseline?: RootfsCheckpointBaseline,signal?:AbortSignal,imageProgress?:(progress:ImagePreparationProgress)=>void) {
    if (this.#activeSource === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "no Userspace rootfs is active");
    const source = this.#activeSource;
    return this.#checkpoints.capture(owner, source, progress, baseline,signal,imageProgress === undefined ? undefined
      : value => imageProgress({ ...value, reason: "first-install", imageSHA256: source.digest }));
  }

  beginCheckpointVerification(signal?: AbortSignal): Promise<() => void> {
    return this.#checkpoints.beginVerification(signal);
  }

  async acquireCheckpoint(owner: RootfsCheckpointOwner, rootfs: UserspaceSnapshotManifest["rootfs"], bytes: Uint8Array<ArrayBuffer>, destination: RootfsCheckpointDestination, purpose: "import" | "restore" = "import"): Promise<void> {
    await this.#checkpoints.acquire(owner,rootfs,bytes,destination,purpose==="import" || !this.#localOnly);
  }

  async prepareCheckpoint(owner: RootfsCheckpointOwner, rootfs: UserspaceSnapshotManifest["rootfs"], bytes: Uint8Array<ArrayBuffer>, destination: RootfsCheckpointDestination): Promise<PreparedUserspaceRootfs> {
    const source=await this.#checkpoints.acquire(owner, rootfs, bytes, destination);
    this.#foreignWorkspace?.retire();this.#foreignWorkspace=undefined;
    this.#preparedCheckpoint={owner:{...owner},source,files:source.manifest.rootTreeSha256===this.#active?.rootTreeSha256?this.#activeFiles:filesOf(source.manifest)};
    return this.#describe(source.manifest,source.digest,destination.trusted.keyId);
  }

  async activateCheckpoint(owner: RootfsCheckpointOwner, trusted: TrustedRootfsKey): Promise<PreparedUserspaceRootfs> {
    const source = await this.#checkpoints.restore(owner, trusted);
    if(this.#activeSource?.digest===source.digest && this.#activeSource.url.href===source.url.href && this.#prepared!==undefined){
      this.#foreignWorkspace?.retire();this.#foreignWorkspace=undefined;
      return this.#prepared;
    }
    await activate(this.#backend, source.url, source.manifest, source.bytes);
    this.#activeSource = source;
    this.#foreignWorkspace?.retire();this.#foreignWorkspace=undefined;
    return this.#setActive(source.manifest,source.digest,trusted.keyId);
  }

  inspectCheckpoint(owner: RootfsCheckpointOwner, trusted: TrustedRootfsKey): Promise<RootfsCheckpointSource | undefined> {
    return this.#checkpoints.inspect(owner, trusted);
  }

  releaseCheckpoint(owner: RootfsCheckpointOwner): Promise<void> {
    if(this.#preparedCheckpoint?.owner.workspaceId===owner.workspaceId&&this.#preparedCheckpoint.owner.snapshotId===owner.snapshotId){this.#preparedCheckpoint=undefined;this.#foreignWorkspace?.retire();this.#foreignWorkspace=undefined;}
    return this.#checkpoints.release(owner);
  }
  cachedCheckpointIdentities(availableRoot?: string): Promise<ReadonlySet<string>> { return this.#checkpoints.identities(availableRoot); }
  currentCheckpointSource():UserspaceSnapshotManifest["rootfs"] {
    const source=this.#activeSource;if(source===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","No image is active");
    return {origin:"managed",image:{id:source.manifest.id,version:source.manifest.version},rootTreeSha256:source.manifest.rootTreeSha256,manifest:{sha256:source.digest,bytes:source.bytes.length}};
  }
  async prepareImage(owner:RootfsCheckpointOwner,signal:AbortSignal,progress:(progress:ImagePreparationProgress)=>void,reason:ImageAcquisitionReason="automatic"):Promise<void> {
    const source=this.#activeSource;if(source===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","No image is active");
    const installed = installedOwner(source.digest), target = reason === "first-install" ? installed : owner;
    let downloadedBytes = 0, requestCount = 0;
    await this.#checkpoints.prepareImage(target,source,signal,
      value => { downloadedBytes = value.downloadedBytes ?? downloadedBytes; requestCount = value.requestCount ?? requestCount;
        progress({ ...value, reason, imageSHA256: source.digest }); },reason==="repair"||reason==="import",reason!=="automatic"||!this.#localOnly);
    const total = rootfsClosure(source.manifest).reduce((sum, blob) => sum + blob.bytes, 0);
    progress({ completedObjects: rootfsClosure(source.manifest).length, completedBytes: total, totalBytes: total,
      stage: "commit", imageSHA256: source.digest, reason, downloadedBytes, requestCount });
    if (source !== this.#activeSource) throw new VMError("ABORTED", "Prepared image was replaced");
    if (this.#imagePreparation === "before-ready") { this.#localOnly = true; this.#checkpoints.requireLocalImage(); }
  }
  async compactImage(signal:AbortSignal):Promise<void> {
    const source=this.#activeSource;if(source===undefined||source.manifest.packs!==undefined)return;
    if (await this.#checkpoints.packs.index(source.manifest, source.digest) !== undefined && await this.#checkpoints.packs.available(source.manifest, source.digest)) return;
    const quota=await readBrowserQuota(typeof navigator==="object"?navigator.storage:undefined);
    const needed=rootfsClosure(source.manifest).reduce((sum,blob)=>sum+blob.bytes,0)+DISK_RESERVE_BYTES;
    if(quota.estimate===null||quota.estimate.quota-quota.estimate.usage<needed)return;
    const locks=typeof navigator==="object"?navigator.locks:undefined;if(locks===undefined)return;
    this.#checkpoints.beginPreparation();
    try {await locks.request("oxidevm-rootfs-pack-lifecycle",{mode:"shared",signal},()=>
      locks.request(`oxidevm-rootfs-packs:${source.digest}`,{signal},()=>this.#checkpoints.packs.compact(source.manifest,source.digest,signal)));}
    catch(error){if(signal.aborted)throw new VMError("ABORTED","Image compaction cancelled");if(error instanceof VMError&&error.code==="ABORTED")throw error;}
    finally{this.#checkpoints.endPreparation();}
  }
  reclaimAccelerators():Promise<void>{return this.#collectPacks(()=>this.#checkpoints.packs.reclaim());}
  collect(): Promise<void> { return this.#collectPacks(()=>this.#checkpoints.collect(this.#activeSource)); }
  async #collectPacks(work:()=>Promise<void>):Promise<void> {
    await this.#checkpoints.settleReads();
    await this.#checkpoints.packs.settleReads();
    const locks=typeof navigator==="object"?navigator.locks:undefined;
    if(locks===undefined){await work();return;}
    // Rootfs caches span workspaces; unpublished derived chunks must survive another worker's GC.
    await locks.request("oxidevm-rootfs-pack-lifecycle",{mode:"exclusive",ifAvailable:true},async lock=>{if(lock!==null)await work();});
  }

  close(): void {
    this.#network.close();
    this.#foreignWorkspace?.retire();this.#foreignWorkspace=undefined;
    this.#active = undefined;this.#identity=undefined;this.#prepared=undefined;this.#preparedCheckpoint=undefined;this.#requestedImage=undefined;
    this.#activeSource = undefined;
    this.#activeFiles.clear();
    if (this.#backend.kind === "indexeddb") void this.#backend.database.then((database) => database.close());
  }

  async #fetchOrCachedManifest(url: URL,digest?:string,cachedOnly=false,signal?:AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    if (!cachedOnly && digest !== undefined) {
      const pinned = await readRootfsCache(this.#backend, "manifests", `${digest}.json`, 128 * 1024 ** 2);
      if (pinned !== undefined && pinned.length <= 128 * 1024 ** 2 && await sha256(pinned) === digest) return pinned;
      const cached = await this.#cachedManifest(url);
      if (cached !== undefined && cached.length <= 128 * 1024 ** 2 && await sha256(cached) === digest) return cached;
    }
    if(cachedOnly) {
      if(digest===undefined) throw new VMError("PROTOCOL_ERROR","cached public rootfs startup requires an exact manifest pin");
      const pinned=await readRootfsCache(this.#backend,"manifests",`${digest}.json`,128*1024**2);
      if(pinned!==undefined) return pinned;
      const cached=await this.#cachedManifest(url);
      if(cached!==undefined) return cached;
      throw new VMError("STORAGE_NOT_FOUND","retained rootfs manifest is not cached");
    }
    try {return await this.#network.fetchManifest(url,signal);} catch(error) {
      signal?.throwIfAborted();
      const cached=await this.#cachedManifest(url);if(cached!==undefined) return cached;throw error;
    }
  }
  async #cachedManifest(url:URL):Promise<Uint8Array<ArrayBuffer>|undefined> {
    const active=await readRootfsCache(this.#backend,"root","active.json",65536);if(active===undefined) return undefined;
    try {
      const marker=record(JSON.parse(new TextDecoder().decode(active)) as unknown,"cached rootfs marker");
      if(string(marker["manifestUrl"],"cached rootfs URL")!==url.href) return undefined;
      return await readRootfsCache(this.#backend,"manifests",string(marker["file"],"cached rootfs filename"),128*1024**2);
    } catch {return undefined;}
  }

  async #readBlob(
    blob: UserspaceRootfsManifest["blobs"][number],
  ): Promise<Uint8Array<ArrayBuffer>> {
    const source=this.#activeSource;
    if(source!==undefined){const packed=await this.#checkpoints.packs.readBlob(source.manifest,source.digest,blob);if(packed!==undefined)return packed;}
    const cached = await verifiedBytes(this.#backend, "blobs", blob.sha256, blob.bytes, blob.sha256);
    if (cached !== undefined) return cached;
    if (this.#localOnly) throw new VMError("STORAGE_ERROR", "Installed image data is missing; repair the image cache", { reason: "image-not-cached" });
    await this.#checkpoints.ensureBlob(blob, undefined, source);
    if (source !== undefined) {
      const packed = await this.#checkpoints.packs.readBlob(source.manifest, source.digest, blob);
      if (packed !== undefined) return packed;
    }
    const content=await verifiedBytes(this.#backend,"blobs",blob.sha256,blob.bytes,blob.sha256);
    if (content===undefined) {
      await remove(this.#backend, "blobs", blob.sha256);
      throw new VMError("STORAGE_ERROR", "persisted rootfs blob failed verification");
    }
    return content;
  }
}

function installedOwner(digest: string): RootfsCheckpointOwner {
  return { workspaceId: `image:${digest}`, snapshotId: "00000000-0000-4000-8000-000000000001" };
}

function prepared(manifest: UserspaceRootfsManifest,digest:string,keyId:string): PreparedUserspaceRootfs {
  return {
    ...(manifest.schemaVersion<5?{}:{identity:{id:manifest.id,version:manifest.version,mode:"userspace" as const,manifestSHA256:decodeSHA256(digest,"retained manifest digest"),cpuProfile:manifest.cpuProfile,keyId,signatureVerified:true as const}}),
    ...(manifest.snapshots===undefined?{}:{snapshots:manifest.snapshots.map(listing=>({...listing,manifest:{...listing.manifest,url:listing.manifest.url.href}}))}),
    id: manifest.id,
    version: manifest.version,
    cpuProfile: manifest.cpuProfile,
    rootTreeSha256: manifest.rootTreeSha256,
    ...(manifest.workspaceBaseSha256 === undefined ? {} : { workspaceBaseSha256: manifest.workspaceBaseSha256 }),
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    metadata: encodeUserspaceRootfsMetadata(manifest),
    runtimes: manifest.runtimes,
  };
}

function filesOf(manifest:UserspaceRootfsManifest):Map<string,UserspaceRootfsBlob> {
 const blobs=new Map(manifest.blobs.map(blob=>[blob.sha256,blob])),files=new Map<string,UserspaceRootfsBlob>();
 for(const entry of manifest.entries) {const blob=entry.type==="file"?blobs.get(entry.blob):entry.type==="hardlink"?files.get(entry.target):undefined;if(blob!==undefined)files.set(entry.path,blob);}
 return files;
}
