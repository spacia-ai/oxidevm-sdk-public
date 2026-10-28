import { RootfsImagePreparation, type ImagePreparationProgress } from "./rootfs-image-preparation.js";
import { rootfsClosure } from "../userspace-rootfs.js";
import { RootfsPackCache } from "./rootfs-pack-cache.js";
import { RootfsInstallations } from "./rootfs-installations.js";
import { retainRootfsRead, type RootfsReadLock } from "./rootfs-read-lock.js";
interface RetainOptions {
  readonly closure?: "verify" | "inherit" | "image";
  readonly progress?: (completedObjects: number) => void;
  readonly signal?: AbortSignal;
  readonly background?: boolean;
  readonly imageProgress?: (progress: ImagePreparationProgress) => void;
  readonly allowNetwork?: boolean;
}
import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeUserspaceRootfsManifest, userspaceTreeIdentity, verifyUserspaceRootfsManifest, type UserspaceRootfsManifest, type TrustedRootfsKey } from "../userspace-rootfs.js";
import { managedImageUrl } from "../managed-image.js";
import { decodeSnapshotRef } from "../protocol/snapshots.js";
import type { UserspaceSnapshotManifest } from "./snapshot-manifest.js";
import type { RootfsNetworkClient } from "./rootfs-network-channel.js";
import { names, openVerifiedReader, read, remove, sha256, verifiedBytes, write, type Backend, type Scope } from "./rootfs-store-backend.js";
import { readStorageObjects } from "./storage-read-batch.js";

export interface RootfsCheckpointOwner { readonly workspaceId: string; readonly snapshotId: string }
export interface RootfsCheckpointDestination { readonly manifestUrl: string; readonly trusted: TrustedRootfsKey }
export interface RootfsCheckpointSource { readonly manifest: UserspaceRootfsManifest; readonly bytes: Uint8Array<ArrayBuffer>; readonly url: URL; readonly digest: string }
export interface RootfsCheckpointBaseline { readonly owner: RootfsCheckpointOwner; readonly rootfs: UserspaceSnapshotManifest["rootfs"] }
type Pin = {
  readonly owner: RootfsCheckpointOwner;
  readonly sha256: string;
  readonly bytes: number;
  readonly manifestUrl: string;
} & ({ readonly version: 1 } | { readonly version: 2; readonly closure: "image" | "complete" } | { readonly version:3;readonly closure:"packed" });
const MAX_MANIFEST = 128 * 1024 * 1024;

/** Rootfs-specific reachability over the existing blob cache. Pins are independent of activation. */
export class RootfsCheckpoints {
  readonly #backend: Backend;
  readonly #network: RootfsNetworkClient;
  // While acquisition yields to the network, collection must retain its partial closure.
  readonly #pending = new Set<RootfsCheckpointSource>();
  readonly #reads=new Map<RootfsCheckpointSource,{count:number;release:(()=>Promise<void>)|undefined}>();
  #revision = 0;
  #preparing = 0;
  #verification: { readonly reads: Map<string, Promise<void>>; readonly sources: Map<string,Promise<UserspaceRootfsManifest>>; readonly lock: RootfsReadLock; readonly signal?: AbortSignal } | undefined;
  #repairTurn: Promise<void> = Promise.resolve();
  readonly #retaining = new Map<string, Set<{ retired: boolean }>>();
  readonly packs: RootfsPackCache;
  readonly #preparation: RootfsImagePreparation;
  #localOnly = false;
  constructor(backend: Backend, network: RootfsNetworkClient) {
    this.#backend = backend; this.#network = network;
    this.#preparation = new RootfsImagePreparation();
    this.packs = new RootfsPackCache(backend, network, (scope,name,bytes) => this.#write(scope,name,bytes), this.#preparation);
  }
  requireLocalImage(): void { this.#localOnly = true; }
  #write(scope: Scope,name: string,bytes: Uint8Array<ArrayBuffer>):Promise<void> {
    return this.#serialize(()=>write(this.#backend,scope,name,bytes));
  }
  #serialize<T>(work:()=>Promise<T>):Promise<T> {
    const pending=this.#repairTurn.then(work);
    this.#repairTurn=pending.then(()=>{},()=>{});return pending;
  }
  async #owned<T>(owner:RootfsCheckpointOwner,signal:AbortSignal|undefined,work:(assertActive:()=>void)=>Promise<T>):Promise<T> {
    const key=JSON.stringify([owner.workspaceId,owner.snapshotId]),attempt={retired:false};
    const attempts=this.#retaining.get(key)??new Set<{retired:boolean}>();
    this.#retaining.set(key,attempts);attempts.add(attempt);
    const assertActive=()=>{if(attempt.retired||signal?.aborted===true)throw new VMError("ABORTED","Rootfs pin owner was retired");};
    try {assertActive();return await work(assertActive);}
    finally {attempts.delete(attempt);if(attempts.size===0)this.#retaining.delete(key);}
  }

  async retainRead(source:RootfsCheckpointSource, signal?: AbortSignal):Promise<()=>void> {
    let entry = this.#reads.get(source);
    if (entry === undefined) {
      const release = this.#verification?.lock.borrow() ?? await retainRootfsRead(signal);
      entry = this.#reads.get(source);
      if (entry === undefined) { entry = { count: 0, release }; this.#reads.set(source, entry); }
      else await release();
    }
    this.#revision++; entry.count++;
    const lease = entry; let retired = false;
    return () => {
      if (retired) return; retired = true; this.#revision++; lease.count--;
      if (lease.count !== 0) return;
      this.#reads.delete(source);
      if (lease.release !== undefined) { const retiring = lease.release(); void this.#serialize(() => retiring); }
    };
  }
  settleReads(): Promise<void> { return this.#repairTurn; }

  beginPreparation(): void { this.#preparing++; this.#revision++; }
  endPreparation(): void { this.#preparing--; this.#revision++; }

  /** Reuses authenticated immutable bodies only while one unpublished restore owns its pins. */
  async beginVerification(signal?: AbortSignal): Promise<() => void> {
    if (this.#hasVerification()) invalid("rootfs verification transaction is already active");
    const release = await retainRootfsRead(signal);
    if (this.#hasVerification()) { await release(); invalid("rootfs verification transaction is already active"); }
    const verification = { reads: new Map<string, Promise<void>>(), sources:new Map<string,Promise<UserspaceRootfsManifest>>(), lock: release, ...(signal === undefined ? {} : { signal }) };
    this.#verification = verification;
    const retirePacks=this.packs.beginVerification(release);
    this.beginPreparation();
    return () => {
      if (this.#verification !== verification) return;
      this.#verification = undefined;
      const retiring = release(); void this.#serialize(() => retiring);
      retirePacks();
      this.endPreparation();
    };
  }
  #hasVerification(): boolean { return this.#verification !== undefined; }

  async capture(owner: RootfsCheckpointOwner, source: RootfsCheckpointSource, progress?: (completedObjects: number) => void,
    baseline?: RootfsCheckpointBaseline, signal?: AbortSignal, imageProgress?:(progress:ImagePreparationProgress)=>void): Promise<{ readonly rootfs: UserspaceSnapshotManifest["rootfs"]; readonly manifest: Uint8Array<ArrayBuffer> }> {
    this.beginPreparation();
    try {
      const saved = await sourceRecord(source);
      const reuse = baseline !== undefined && await this.#canInherit(owner, source, saved.rootfs, baseline, signal);
      await this.#retain(owner, source, { closure: reuse ? "inherit" : "verify", ...(progress === undefined ? {} : { progress }),
        ...(signal === undefined ? {} : { signal }), ...(imageProgress === undefined ? {} : { imageProgress }) });
      return saved;
    } finally { this.endPreparation(); }
  }

  async pinImage(owner:RootfsCheckpointOwner,source:RootfsCheckpointSource):Promise<{readonly rootfs:UserspaceSnapshotManifest["rootfs"];readonly manifest:Uint8Array<ArrayBuffer>}> {
    await this.#retain(owner,source,{closure:"image"});
    return sourceRecord(source);
  }

  async pinInstalledImage(owner: RootfsCheckpointOwner, source: RootfsCheckpointSource, installed: RootfsCheckpointOwner) {
    const saved = await sourceRecord(source);
    if (!await this.#canInherit(installed, source, saved.rootfs, { owner: installed, rootfs: saved.rootfs })) {
      throw new VMError("STORAGE_ERROR", "Complete image installation is unavailable", { reason: "image-not-cached" });
    }
    await this.#retain(owner, source, { closure: "inherit" });
    return saved;
  }

  async acquire(owner: RootfsCheckpointOwner, expected: UserspaceSnapshotManifest["rootfs"], bytes: Uint8Array<ArrayBuffer>, destination: RootfsCheckpointDestination, allowNetwork = !this.#localOnly): Promise<RootfsCheckpointSource> {
    if (bytes.byteLength !== expected.manifest.bytes || bytes.byteLength > MAX_MANIFEST || await sha256(bytes) !== expected.manifest.sha256) invalid("snapshot rootfs manifest digest differs from its pin");
    const source = await this.#authenticate(bytes,managedImageUrl(destination.manifestUrl),expected.manifest.sha256,destination.trusted);
    if (source.manifest.id !== expected.image.id || source.manifest.version !== expected.image.version || source.manifest.rootTreeSha256 !== expected.rootTreeSha256) invalid("snapshot rootfs image differs from its pin");
    await this.#retain(owner, source, { allowNetwork });
    return source;
  }

  async restore(owner: RootfsCheckpointOwner, trusted: TrustedRootfsKey): Promise<RootfsCheckpointSource> {
    const encoded = await read(this.#backend, "pins", await pinName(owner));
    if (encoded === undefined) invalid("snapshot rootfs pin is missing");
    const pin = decodePin(encoded);
    if (pin.owner.workspaceId !== owner.workspaceId || pin.owner.snapshotId !== owner.snapshotId) invalid("snapshot rootfs pin owner differs");
    const bytes=await verifiedBytes(this.#backend,"manifests",`${pin.sha256}.json`,pin.bytes,pin.sha256);
    if(bytes===undefined)invalid("snapshot rootfs manifest is missing or corrupted");
    const source = await this.#authenticate(bytes,managedImageUrl(pin.manifestUrl),pin.sha256,trusted);
    await this.#ensure(source);
    return source;
  }

  async #authenticate(bytes:Uint8Array<ArrayBuffer>,url:URL,digest:string,trusted:TrustedRootfsKey):Promise<RootfsCheckpointSource> {
    // Hashing precedes this call. The parse/signature proof belongs only to this transaction and exact trust/URL context.
    const key=JSON.stringify([digest,url.href,trusted.keyId,Array.from(trusted.publicKey)]),memo=this.#verification?.sources;
    let proof=memo?.get(key);
    if(proof===undefined){
      proof=(async()=>{const source=await decodeSource(bytes,url,digest);await verifyUserspaceRootfsManifest(source.manifest,trusted);return source.manifest;})();
      memo?.set(key,proof);void proof.catch(()=>memo?.delete(key));
    }
    return {bytes,url,digest,manifest:await proof};
  }

  async #persistManifest(source:RootfsCheckpointSource):Promise<void> {
    const key=`manifest:${source.digest}:${String(source.bytes.length)}`,memo=this.#verification?.reads;
    const previous=memo?.get(key);if(previous!==undefined){await previous;return;}
    // Metadata writes are serialized by the caller, and the transaction's read lock prevents GC.
    const saving=(async()=>{
      if(await verifiedBytes(this.#backend,"manifests",`${source.digest}.json`,source.bytes.length,source.digest)===undefined)
        await write(this.#backend,"manifests",`${source.digest}.json`,source.bytes);
    })();
    memo?.set(key,saving);void saving.catch(()=>memo?.delete(key));await saving;
  }

  inspect(owner: RootfsCheckpointOwner, trusted: TrustedRootfsKey): Promise<RootfsCheckpointSource | undefined> {
    return RootfsCheckpoints.inspectCached(this.#backend, owner, trusted);
  }

  static async inspectCached(backend:Backend,owner:RootfsCheckpointOwner,trusted:TrustedRootfsKey):Promise<RootfsCheckpointSource|undefined> {
    const source=await inspectSignedSource(backend,owner,trusted);
    if(source!==undefined&&!await completeSource(backend,source))invalid("snapshot rootfs cached closure is incomplete or corrupted");
    return source;
  }

  /** Cold files retain signed image authority without promising a complete offline checkpoint. */
  static inspectCachedImage(backend:Backend,owner:RootfsCheckpointOwner,trusted:TrustedRootfsKey,installedDigest?:string):Promise<RootfsCheckpointSource|undefined> {
    return inspectSignedSource(backend,owner,trusted,installedDigest);
  }

  async release(owner: RootfsCheckpointOwner): Promise<void> {
    this.#revision++;
    for(const attempt of this.#retaining.get(JSON.stringify([owner.workspaceId,owner.snapshotId]))??[])attempt.retired=true;
    const name=await pinName(owner);
    await this.#serialize(()=>remove(this.#backend,"pins",name));
  }

  async identities(availableRoot?: string): Promise<ReadonlySet<string>> {
    const identities = new Set<string>();
    // Only this inspection may reuse a closure result; the next call rechecks persisted bytes.
    const complete = new Map<string, { readonly root: string; readonly valid: boolean }>();
    for (const name of await names(this.#backend, "pins")) {
      try {
        const encoded = await read(this.#backend, "pins", name);
        if (encoded === undefined) continue;
        const pin = decodePin(encoded);
        if (await pinName(pin.owner) !== name) continue;
        const key = `${pin.sha256}:${String(pin.bytes)}`;
        let checked = complete.get(key);
        if (checked === undefined) {
          const source = await readSource(this.#backend, pin);
          const root = source.manifest.rootTreeSha256;
          checked = { root, valid: root === availableRoot || (this.#localOnly && completePin(pin)
            ? await this.packs.available(source.manifest, source.digest) : await completeSource(this.#backend, source)) };
          complete.set(key, checked);
        }
        if (checked.valid) identities.add(checked.root);
      } catch { /* An incomplete or corrupted cache is not an offline resume candidate. */ }
    }
    return identities;
  }

  async collect(active: RootfsCheckpointSource | undefined): Promise<void> {
    if (this.#preparing !== 0) return;
    const revision = this.#revision;
    const manifests = new Set<string>(), blobs = new Set<string>(), packs=new Set<string>(), layouts=new Set<string>();
    const retain = async (source: RootfsCheckpointSource) => {
      for (const blob of closure(source.manifest)) blobs.add(blob.sha256);
      const index=await this.packs.index(source.manifest,source.digest);
      if(index!==undefined){layouts.add(`${source.digest}.json`);for(const chunk of index.chunks)packs.add(chunk.sha256);}
    };
    if (active !== undefined) await retain(active);
    for(const source of this.#reads.keys()){await retain(source);manifests.add(`${await sha256(source.bytes)}.json`);}
    for (const pending of this.#pending) { await retain(pending); manifests.add(`${await sha256(pending.bytes)}.json`); }
    // A previous store instance can still have a selected image even before this one prepares it.
    const activeMarker = await read(this.#backend, "root", "active.json");
    try {
      const installations = await new RootfsInstallations(this.#backend, (scope, name, bytes) => this.#write(scope, name, bytes)).retained();
      for (const [digest, index] of installations) {
        manifests.add(`${digest}.json`); layouts.add(`${digest}.json`);
        for (const chunk of index.chunks) packs.add(chunk.sha256);
      }
      if (activeMarker !== undefined) {
        const marker = record(JSON.parse(new TextDecoder().decode(activeMarker)) as unknown, "active rootfs");
        const file = string(marker["file"], "active rootfs filename");
        const url = managedImageUrl(string(marker["manifestUrl"], "active rootfs URL"));
        const bytes = await read(this.#backend, "manifests", file);
        if (bytes === undefined) return;
        manifests.add(file); await retain(await decodeSource(bytes, url));
      }
      // Legacy cached images are also workspace-base authorities. Their existing owner has
      // no complete durable reachability index, so checkpoint GC must not evict them.
      for (const name of await names(this.#backend, "manifests")) {
        if (/^[0-9a-f]{64}\.json$/u.test(name)) continue;
        const bytes = await read(this.#backend, "manifests", name);
        if (bytes === undefined) return;
        manifests.add(name);
        await retain(await decodeSource(bytes, new URL("https://oxidevm-rootfs-cache.invalid/manifest.json")));
      }
      for (const name of await names(this.#backend, "pins")) {
        const encoded = await read(this.#backend, "pins", name);
        if (encoded === undefined) return;
        const pin = decodePin(encoded);
        if (await pinName(pin.owner) !== name) return;
        manifests.add(`${pin.sha256}.json`); await retain(await readSource(this.#backend, pin));
      }
    } catch {
      // A damaged pin can hide reachability. Fail closed without deleting any cached object.
      return;
    }
    for (const name of await names(this.#backend, "manifests")) {
      if (revision !== this.#revision) return;
      if (!manifests.has(name)) await remove(this.#backend, "manifests", name);
    }
    for (const name of await names(this.#backend,"pack-layouts")) {if(revision!==this.#revision)return;if(!layouts.has(name))await remove(this.#backend,"pack-layouts",name);}
    for (const name of await names(this.#backend,"packs")) {if(revision!==this.#revision)return;if(!packs.has(name))await remove(this.#backend,"packs",name);}
    for (const name of await names(this.#backend, "blobs")) {
      if (revision !== this.#revision) return;
      if (!blobs.has(name)) await remove(this.#backend, "blobs", name);
    }
  }

  /** Complete pins retain immutable bodies through GC; image-only and legacy pins prove no closure. */
  async #canInherit(owner: RootfsCheckpointOwner, source: RootfsCheckpointSource,
    expected: UserspaceSnapshotManifest["rootfs"], baseline: RootfsCheckpointBaseline, signal?: AbortSignal): Promise<boolean> {
    const previous = baseline.rootfs;
    if (source.digest !== expected.manifest.sha256) return false;
    if (baseline.owner.workspaceId !== owner.workspaceId
      || previous.image.id !== expected.image.id || previous.image.version !== expected.image.version
      || previous.rootTreeSha256 !== expected.rootTreeSha256 || previous.manifest.sha256 !== expected.manifest.sha256
      || previous.manifest.bytes !== expected.manifest.bytes) return false;
    const bytes = await read(this.#backend, "pins", await pinName(baseline.owner));
    if (bytes === undefined) return false;
    const pin = decodePin(bytes);
    if (pin.owner.workspaceId !== baseline.owner.workspaceId || pin.owner.snapshotId !== baseline.owner.snapshotId) invalid("snapshot rootfs pin owner differs");
    const reusable = completePin(pin) && pin.sha256 === expected.manifest.sha256
      && pin.bytes === expected.manifest.bytes
      && await verifiedBytes(this.#backend, "manifests", `${pin.sha256}.json`, pin.bytes, pin.sha256) !== undefined;
    if (reusable && this.#localOnly) await this.#requireAvailable(source, signal);
    return reusable;
  }

  async #retain(owner: RootfsCheckpointOwner, source: RootfsCheckpointSource, options: RetainOptions = {}): Promise<void> {
    const { closure = "verify", progress, signal, background = false, imageProgress } = options;
    return this.#owned(owner,signal,async assertActive=>{
    const name = await pinName(owner);
    const digest = await sha256(source.bytes);
    if(digest!==source.digest)invalid("rootfs source manifest identity changed");
    // A caller cannot repurpose a retained checkpoint owner for another immutable image.
    const previous = await read(this.#backend, "pins", name);
    if (previous !== undefined && decodePin(previous).sha256 !== digest) invalid("snapshot rootfs pin already names another manifest");
    this.#revision++;
    this.#pending.add(source);
    try {
      if(closure === "verify")await this.#ensure(source,progress,signal,background,imageProgress,options.allowNetwork ?? !this.#localOnly);
      const packed=closure!=="image"&&source.manifest.packs!==undefined&&(this.packs.verifiedLayout(source.digest)||await this.#completeProof(source,signal,true));
      const identity={owner,sha256:digest,bytes:source.bytes.length,manifestUrl:source.url.href};
      const pin: Pin = packed?{...identity,version:3,closure:"packed"}:{...identity,version:2,closure:closure==="image"?"image":"complete"};
      await this.#serialize(async()=>{
        assertActive();
        const replaced=await read(this.#backend,"pins",name);
        if(replaced!==undefined&&decodePin(replaced).sha256!==digest)invalid("snapshot rootfs pin already names another manifest");
        await this.#persistManifest(source);
        assertActive();
        await write(this.#backend,"pins",name,new TextEncoder().encode(JSON.stringify(pin)));
        try {assertActive();} catch(error) {
          if(replaced===undefined)await remove(this.#backend,"pins",name);
          else await write(this.#backend,"pins",name,replaced);
          throw error;
        }
      });
    } finally { this.#pending.delete(source); this.#revision++; }
    });
  }

  async prepareImage(owner:RootfsCheckpointOwner,source:RootfsCheckpointSource,signal:AbortSignal,progress:(progress:ImagePreparationProgress)=>void,verifyComplete=false,allowNetwork=!this.#localOnly):Promise<void> {
    return this.#owned(owner,signal,async assertActive=>{this.beginPreparation();try{
      const record=await sourceRecord(source),total=rootfsClosure(source.manifest).reduce((sum,blob)=>sum+blob.bytes,0);
      const inherited=!verifyComplete
        && (await this.#canInherit(owner,source,record.rootfs,{owner,rootfs:record.rootfs},signal) || await this.#completeProof(source,signal))
        && await this.packs.available(source.manifest,source.digest,signal);
      assertActive();
      if(inherited){
        await this.#retain(owner,source,{closure:"inherit",signal});
        progress({completedObjects:0,completedBytes:total,totalBytes:total,stage:"commit",imageSHA256:source.digest,downloadedBytes:0,requestCount:0});return;
      }
      await this.#retain(owner,source,{signal,background:true,imageProgress:progress,allowNetwork});
    }finally{this.endPreparation();}});
  }

  async #ensure(source:RootfsCheckpointSource,progress?:(objects:number)=>void,signal?:AbortSignal,background=false,imageProgress?:(progress:ImagePreparationProgress)=>void,allowNetwork = !this.#localOnly):Promise<void> {
    rootfsClosure(source.manifest);
    const key=`source:${source.digest}:${allowNetwork ? "acquire" : "local"}`,memo=this.#verification?.reads;
    const previous=memo?.get(key);if(previous!==undefined){await previous;return;}
    const cancellation=signal??this.#verification?.signal;
    const preparing=this.#preparation.prepare(key,{background,...(cancellation===undefined?{}:{signal:cancellation}),progress:value=>{if(value.completedObjects!==0)progress?.(value.completedObjects);imageProgress?.(value);}},async (workSignal,foreground,report)=>{
      this.beginPreparation();
      try {
        const run = () => this.#ensureBodies(source,(completedObjects,completedBytes,totalBytes,details)=>report({completedObjects,completedBytes,totalBytes,...details}),workSignal,foreground,allowNetwork);
        const locks = typeof navigator === "object" ? navigator.locks : undefined;
        if (locks === undefined) await run();
        else if (this.#verification !== undefined) await locks.request(`oxidevm-rootfs-packs:${source.digest}`, { signal: workSignal }, run);
        else await locks.request("oxidevm-rootfs-pack-lifecycle", { mode: "shared", signal: workSignal }, () => locks.request(`oxidevm-rootfs-packs:${source.digest}`, { signal: workSignal }, run));
      }
      finally {this.endPreparation();}
    });
    memo?.set(key,preparing);void preparing.catch(()=>memo?.delete(key));await preparing;
  }

  async #ensureBodies(source: RootfsCheckpointSource, progress: (objects:number,bytes:number,total:number,details?:Omit<ImagePreparationProgress,"completedObjects"|"completedBytes"|"totalBytes">)=>void, signal:AbortSignal,foreground:()=>boolean,allowNetwork:boolean): Promise<void> {
    // Installed sessions authenticate files on use. Only installation, import and explicit repair scan the entire image.
    if(this.#localOnly && !allowNetwork){await this.#requireAvailable(source,signal);return;}
    await this.#serialize(()=>this.#persistManifest(source));
    let completed = 0,completedBytes=0;const counted=new Set<string>(),totalBytes=rootfsClosure(source.manifest).reduce((sum,blob)=>sum+blob.bytes,0);
    const reportComplete = () => {
      for (const blob of closure(source.manifest)) {
        const key = blobIdentity(blob);
        if (!counted.has(key)) { counted.add(key); completedBytes += blob.bytes; }
        progress(++completed, completedBytes, totalBytes, { stage: "verify", imageSHA256: source.digest, downloadedBytes: 0, requestCount: 0 });
      }
    };
    progress(0,0,totalBytes,{stage:"verify",imageSHA256:source.digest,downloadedBytes:0,requestCount:0});
    const verified = this.#verification?.reads ?? new Map<string, Promise<void>>();
    if(source.manifest.packs!==undefined&&await this.#completeProof(source,signal,true)&&await this.packs.verifyPinnedPacks(source.manifest,source.digest,signal)){
      reportComplete();return;
    }
    {
      const cached=new Set(await names(this.#backend,"blobs")),needed=rootfsClosure(source.manifest);
      if(needed.every(blob=>cached.has(blob.sha256))&&await completeLooseSource(this.#backend,source,signal)){
        reportComplete();return;
      }
    }
    if (!allowNetwork) {
      if (await this.packs.verify(source.manifest, source.digest, signal)) { reportComplete(); return; }
      throw new VMError("STORAGE_ERROR", "Installed image data is missing or damaged; repair the image cache", { reason: "image-not-cached" });
    }
    let metadataBytes = 0, metadataRequests = 0;
    const transported = await this.packs.discover(source.manifest, source.digest, source.url, signal, value => {
      metadataBytes = value.downloadedBytes; metadataRequests = value.requestCount;
      progress(completed,completedBytes,totalBytes,{stage:"download",imageSHA256:source.digest,...value});
    });
    if (transported || await this.packs.index(source.manifest,source.digest) !== undefined) {
      const key=`packs:${source.digest}`;
      let pending=verified.get(key);
      if(pending===undefined) {
        pending=this.packs.ensure(source.manifest,source.digest,signal,(bytes,total,stage,network)=>progress(bytes === total && stage !== "download" ? rootfsClosure(source.manifest).length : 0,bytes,total,{
          stage:stage??"verify",imageSHA256:source.digest,downloadedBytes:metadataBytes+(network?.downloadedBytes??0),requestCount:metadataRequests+(network?.requestCount??0),
        }),foreground).then(ok=>{if(!ok)invalid("Packed rootfs accelerator failed validation");});
        verified.set(key,pending);void pending.catch(()=>verified.delete(key));
      }
      try {await pending;return;}catch(error){
        if(signal.aborted)throw error;
        if(source.manifest.packs!==undefined || transported){
          if(await completeLooseSource(this.#backend,source,signal)){progress(rootfsClosure(source.manifest).length,totalBytes,totalBytes);return;}
          throw error;
        }
      }
    }
    const read = await openVerifiedReader(this.#backend, "blobs");
    // Unread image files wait on HTTP; keep those slots occupied within the shared eight-MiB window.
    await readStorageObjects(closure(source.manifest), async blob => {
      const key = blobIdentity(blob);
      let pending = verified.get(key);
      if (pending === undefined) {
        if (signal.aborted) throw new VMError("ABORTED", "Rootfs verification cancelled");
        pending = this.#ensureBlob(blob, read,signal,!foreground());
        verified.set(key, pending);
        void pending.catch(() => verified.delete(key));
      }
      await pending;
      if(!counted.has(key)){counted.add(key);completedBytes+=blob.bytes;}
      progress(++completed,completedBytes,totalBytes);
    }, signal, () => foreground()?32:4);
  }

  async #requireAvailable(source:RootfsCheckpointSource,signal?:AbortSignal):Promise<void> {
    active(signal);
    if(!await this.#completeProof(source,signal) || !await this.packs.available(source.manifest,source.digest,signal)) {
      throw new VMError("STORAGE_ERROR","Installed image data is missing; repair the image cache",{reason:"image-not-cached"});
    }
    active(signal);
  }

  async #completeProof(source:RootfsCheckpointSource,signal?:AbortSignal,packedOnly=false):Promise<boolean> {
    for(const name of await names(this.#backend,"pins")){
      if(signal?.aborted===true)throw new VMError("ABORTED","Rootfs verification cancelled");
      try {
        const bytes=await read(this.#backend,"pins",name);if(bytes===undefined)continue;
        const pin=decodePin(bytes);
        if((packedOnly?pin.version===3:completePin(pin))&&pin.sha256===source.digest&&pin.bytes===source.bytes.length&&await pinName(pin.owner)===name)return true;
      }catch { /* Missing or damaged proof falls back to complete logical-file verification. */ }
    }
    return false;
  }

  async ensureBlob(blob:ReturnType<typeof closure>[number],signal?:AbortSignal,source?:RootfsCheckpointSource):Promise<void> {
    if (source !== undefined && await this.packs.acquireBlob(source.manifest, source.digest, blob, signal)) return;
    await this.#ensureBlob(blob,undefined,signal);
  }
  async #ensureBlob(blob: ReturnType<typeof closure>[number], read: Awaited<ReturnType<typeof openVerifiedReader>>|undefined,signal?:AbortSignal,background=false): Promise<void> {
    await this.#preparation.prepare(`blob:${blobIdentity(blob)}`,{background,...(signal===undefined?{}:{signal})},async(workSignal,foreground)=>{
      const verify=read??await openVerifiedReader(this.#backend,"blobs");
      if (await verify(blob.sha256, blob.bytes, blob.sha256) !== undefined) return;
      const content = await this.#network.fetchBlob(blob.url, blob.bytes, blob.sha256,workSignal,foreground()?"high":"low");
      if (content.length !== blob.bytes || await sha256(content) !== blob.sha256) invalid("snapshot rootfs blob failed verification");
      await this.cacheBlob(blob,content);
    });
  }
  async cacheBlob(blob:{readonly bytes:number;readonly sha256:string},content:Uint8Array<ArrayBuffer>):Promise<void> {
    await this.#serialize(async()=>{
      await write(this.#backend,"blobs",blob.sha256,content);
      if(await verifiedBytes(this.#backend,"blobs",blob.sha256,blob.bytes,blob.sha256)===undefined){await remove(this.#backend,"blobs",blob.sha256);invalid("persisted snapshot rootfs blob failed verification");}
    });
  }
}

function closure(manifest: UserspaceRootfsManifest) {const p=manifest.provenance;return [...manifest.blobs,p.sbom,p.notices,p.correspondingSources,p.reproducibility];}
async function decodeSource(bytes: Uint8Array<ArrayBuffer>, url: URL, digest?:string): Promise<RootfsCheckpointSource> {
  if (bytes.length > MAX_MANIFEST) invalid("snapshot rootfs manifest is too large");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return { bytes, url, digest:digest??await sha256(bytes), manifest: decodeUserspaceRootfsManifest(value, url) };
}
function decodePin(bytes: Uint8Array<ArrayBuffer>): Pin {
  if (bytes.length > 8192) invalid("rootfs checkpoint pin is too large");
  const pin = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown, "rootfs checkpoint pin");
  const version = pin["version"];
  if (version !== 1 && version !== 2 && version !== 3) invalid("rootfs checkpoint pin version is invalid");
  exactKeys(pin, ["version", "owner", "sha256", "bytes", "manifestUrl", ...(version === 1 ? [] : ["closure"])]);
  const owner = record(pin["owner"], "rootfs checkpoint owner");
  exactKeys(owner, ["workspaceId", "snapshotId"]);
  const digest = string(pin["sha256"], "rootfs manifest digest");
  if (!/^[0-9a-f]{64}$/u.test(digest)) invalid("rootfs manifest digest is invalid");
  const common = {
    owner: { workspaceId: string(owner["workspaceId"], "rootfs workspace"), snapshotId: string(owner["snapshotId"], "rootfs snapshot") },
    sha256: digest, bytes: integer(pin["bytes"], "rootfs manifest bytes", 1, MAX_MANIFEST), manifestUrl: managedImageUrl(string(pin["manifestUrl"], "rootfs manifest URL")).href,
  };
  if (version === 1) return { ...common, version };
  const closure = pin["closure"];
  if(version===3){if(closure!=="packed")invalid("rootfs packed verification proof is invalid");return {...common,version,closure};}
  if (closure !== "image" && closure !== "complete") invalid("rootfs checkpoint closure is invalid");
  return { ...common, version, closure };
}
async function pinName(owner: RootfsCheckpointOwner): Promise<string> {
  if (owner.workspaceId.length === 0 || new TextEncoder().encode(owner.workspaceId).length > 1024) invalid("rootfs checkpoint workspace is invalid");
  decodeSnapshotRef({ id: owner.snapshotId, createdAt: "1970-01-01T00:00:00.000Z" });
  return `${await sha256(new TextEncoder().encode(JSON.stringify([owner.workspaceId, owner.snapshotId])))}.json`;
}
function invalid(message: string): never { throw new VMError("STORAGE_ERROR", message, { reason: "snapshot-rootfs-damaged" }); }

async function readSource(backend: Backend, pin: Pin): Promise<RootfsCheckpointSource> {
  const bytes = await verifiedBytes(backend, "manifests", `${pin.sha256}.json`, pin.bytes, pin.sha256);
  if (bytes === undefined) invalid("snapshot rootfs manifest is missing or corrupted");
  const source = await decodeSource(bytes, managedImageUrl(pin.manifestUrl),pin.sha256);
  const identity = await userspaceTreeIdentity(source.manifest.entries, source.manifest.blobs, source.manifest.schemaVersion);
  if (identity.rootTreeSha256 !== source.manifest.rootTreeSha256) invalid("snapshot rootfs tree identity differs");
  return source;
}
async function completeSource(backend: Backend, source: RootfsCheckpointSource): Promise<boolean> {
  if(await new RootfsPackCache(backend).verify(source.manifest,source.digest))return true;
  return completeLooseSource(backend,source);
}
async function completeLooseSource(backend:Backend,source:RootfsCheckpointSource,signal?:AbortSignal):Promise<boolean> {
  let complete = true;
  const distinct = [...new Map(closure(source.manifest).map(blob => [blobIdentity(blob), blob])).values()];
  const read = await openVerifiedReader(backend, "blobs");
  await readStorageObjects(distinct, async blob => {
    if (await read(blob.sha256, blob.bytes, blob.sha256) === undefined) complete = false;
  },signal);
  return complete;
}

function blobIdentity(blob: { readonly sha256: string; readonly bytes: number }): string {
  return `${blob.sha256}:${String(blob.bytes)}`;
}

function completePin(pin:Pin):boolean {return pin.version===3 || pin.version===2&&pin.closure==="complete";}
function active(signal?:AbortSignal):void {if(signal?.aborted===true)throw new VMError("ABORTED","Installed image inspection cancelled");}

async function sourceRecord(source:RootfsCheckpointSource):Promise<{readonly rootfs:UserspaceSnapshotManifest["rootfs"];readonly manifest:Uint8Array<ArrayBuffer>}> {
 return {rootfs:{origin:"managed",image:{id:source.manifest.id,version:source.manifest.version},rootTreeSha256:source.manifest.rootTreeSha256,manifest:{sha256:await sha256(source.bytes),bytes:source.bytes.length}},manifest:source.bytes};
}

async function inspectSignedSource(backend:Backend,owner:RootfsCheckpointOwner,trusted:TrustedRootfsKey,installedDigest?:string):Promise<RootfsCheckpointSource|undefined> {
 try {
  const encoded=await read(backend,"pins",await pinName(owner));if(encoded===undefined)return undefined;
  const pin=decodePin(encoded);if(pin.owner.workspaceId!==owner.workspaceId||pin.owner.snapshotId!==owner.snapshotId)invalid("snapshot rootfs pin owner differs");
  if(installedDigest!==undefined&&(pin.sha256!==installedDigest||!completePin(pin)))invalid("installed rootfs pin differs from the requested complete image");
  const bytes=await verifiedBytes(backend,"manifests",`${pin.sha256}.json`,pin.bytes,pin.sha256);
  if(bytes===undefined)invalid("snapshot rootfs manifest is missing or corrupted");
  const source=await decodeSource(bytes,managedImageUrl(pin.manifestUrl),pin.sha256);
  await verifyUserspaceRootfsManifest(source.manifest,trusted);return source;
 }catch(error){if(error instanceof VMError)throw error;invalid("snapshot rootfs checkpoint metadata is malformed");}
}
