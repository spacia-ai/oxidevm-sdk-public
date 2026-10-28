import { serveRestoreStream } from "./snapshot-restore-stream.js";
import { decodeImagePreparationReport } from "../protocol/image-preparation.js";
import type { SnapshotStorageProgress } from "./snapshot-channel.js";
import type {ShippedInstallIdentity} from "../protocol.js";
import { NativeColdFiles } from "./native-cold-files.js";
import {stageNativeWorkspace} from "./native-workspace-stage.js";
import type {ManagedBoot} from "../protocol/storage.js";
import type {RootfsCheckpointDestination} from "./rootfs-store.js";
import { VMError } from "../errors.js";
import {sameShippedIdentity} from "../protocol/shipped-source.js";
import type { SnapshotRef } from "../protocol/snapshots.js";
import type { SnapshotCatalog } from "./snapshot-catalog.js";
import { NativeSnapshotCapture } from "./snapshot-userspace-capture.js";
import { NativeSnapshotFiles, type PreparedNativeFiles } from "./snapshot-userspace-files.js";
import { manifestObjects, USERSPACE_SNAPSHOT_SCHEMA, type UserspaceSnapshotManifest } from "./snapshot-manifest.js";
import type { NativeSnapshotStorageRequest } from "./snapshot-native-channel.js";
import type { SnapshotObjects, SnapshotReadLease } from "./snapshot-objects.js";
import type { RootfsStore } from "./rootfs-store.js";
import type { NativeFileSession, WorkspaceSelections } from "./workspace-selections.js";
import { NativePayloadRounds } from "./snapshot-native-payload-rounds.js";

export interface NativeSnapshotEnvironment {
  readonly workspaceId: string;
  readonly selections: WorkspaceSelections;
  readonly rootfs: Pick<RootfsStore, "pinImage" | "captureCheckpoint" | "acquireCheckpoint" | "releaseCheckpoint" | "prepareCheckpoint" | "currentRootfs" | "currentCheckpointSource" | "prepareImage" | "compactImage" | "reclaimAccelerators" | "activateCheckpoint" | "beginCheckpointVerification">;
}
type Open = Extract<NativeSnapshotStorageRequest, { readonly type: "open-native-capture" }>;
type Prepare = Extract<NativeSnapshotStorageRequest, { readonly type: "prepare-native-restore" }>;
interface Capture {
  readonly request: Open;
  readonly capture: NativeSnapshotCapture;
  readonly rounds: NativePayloadRounds;
  readonly catalog: SnapshotCatalog;
  readonly root?: string;
  readonly baseline?:UserspaceSnapshotManifest;
  readonly baselineReads?:SnapshotReadLease;
}
interface Restore {
  readonly previousInitialStart:ShippedInstallIdentity | undefined;
  readonly initialStart?:ShippedInstallIdentity;
  readonly retireVerification: () => void;
  readonly reads: SnapshotReadLease;
  readonly manifest: UserspaceSnapshotManifest;
  readonly originalFiles: string;
  readonly previous: NativeFileSession | undefined;
  readonly next: NativeFileSession;
  readonly files: PreparedNativeFiles;
  readonly recovery?: UserspaceSnapshotManifest;
  readonly destination:RootfsCheckpointDestination;
  readonly imagePin:string;
  readonly workspaceBase:string;
  readonly automatic:boolean;
  readonly newerFiles: { readonly workspace: boolean; readonly root: boolean };
  workspaceStaged:boolean;
  preservedId?:string;
  published: boolean;
}

/** Native transactions reuse the catalogue/object store. Hidden recovery points
 * use a private catalogue, so their durable commit never appears in the UI. */
export class NativeSnapshotStore {
  readonly #objects: SnapshotObjects;
  readonly #catalog: SnapshotCatalog;
  readonly #recovery: SnapshotCatalog;
  readonly #environment: NativeSnapshotEnvironment;
  readonly #files: NativeSnapshotFiles;
  readonly #cold: NativeColdFiles;
  #selecting=false;
  #acceleration:{readonly controller:AbortController;readonly job:Promise<void>}|undefined;
  #capture: Capture | undefined;
  #restore: Restore | undefined;

  constructor(objects: SnapshotObjects, catalog: SnapshotCatalog, recovery: SnapshotCatalog, environment: NativeSnapshotEnvironment) {
    this.#objects = objects; this.#catalog = catalog; this.#recovery = recovery; this.#environment = environment;
    this.#files = new NativeSnapshotFiles(environment.selections, objects);
    this.#cold = new NativeColdFiles(environment.selections, this.#files);
  }

  get busy(): boolean { return this.#capture !== undefined || this.#restore !== undefined || this.#cold.busy || this.#selecting; }

  /** Imported ancestors use the prepared portable files until reconciliation stages its result. */
  retainedReadId(id:string):string {
    const restore=this.#restore;
    if(restore===undefined||restore.manifest.id!==id)return id;
    if(restore.published||restore.workspaceStaged)invalid("Prepared ancestor file generation has retired");
    return restore.files.id;
  }

  async selectFiles(request:{readonly boot:ManagedBoot;readonly rootTreeSha256:string;readonly rootPersistence:"ephemeral"|"persistent"},signal:AbortSignal):Promise<{readonly sourceId:string;readonly replaced?:string}> {
    this.#acceleration?.controller.abort();this.#idle();active(signal);this.#selecting=true;
    const image=crypto.randomUUID();
    let committed=false;
    try {
      const previous=await this.#environment.selections.session();
      const saved=await this.#rootOperation(signal,()=>this.#environment.rootfs.pinImage(this.#owner(image)), true);
      if(saved.rootfs.rootTreeSha256!==request.rootTreeSha256) invalid("Cold-start image differs from its verified source");
      const result=await this.#environment.selections.selectBoot(request.boot,request.rootTreeSha256,image,signal);
      committed=true;
      if(previous?.image!==undefined)await this.#environment.rootfs.releaseCheckpoint(this.#owner(previous.image)).catch(()=>{});
      const sourceId = await this.#cold.begin(request.rootPersistence === "persistent" ? request.rootTreeSha256 : undefined, this.#environment.rootfs.currentRootfs().workspaceBaseSha256??request.rootTreeSha256, signal);
      return {...result, sourceId};
    } finally {this.#selecting=false;if(!committed)await this.#environment.rootfs.releaseCheckpoint(this.#owner(image));}
  }

  abortCold(sourceId:string):Promise<void> {return this.#cold.abort(sourceId);}

  async handle(request: NativeSnapshotStorageRequest, signal: AbortSignal, progress?: (value: SnapshotStorageProgress) => void): Promise<unknown> {
    switch (request.type) {
      case "open-native-capture": return this.#open(request, signal, progress);
      case "reclaim-native-cache": return this.#environment.rootfs.reclaimAccelerators();
      case "prepare-native-image": {
        const previous=await this.#environment.selections.session(),image=previous?.image??crypto.randomUUID();
        if (previous?.image === undefined && (request.reason ?? "automatic") === "automatic") return undefined;
        const before=this.#environment.rootfs.currentCheckpointSource().manifest.sha256;
        await this.#environment.rootfs.prepareImage(this.#owner(image),signal,value=>{
          progress?.(decodeImagePreparationReport({ ...value }));
        },request.reason??"automatic");
        active(signal);if(this.#environment.rootfs.currentCheckpointSource().manifest.sha256!==before)throw new VMError("ABORTED","Prepared image was replaced");
        if((request.reason??"automatic")==="automatic")await this.#accelerate(signal);
        active(signal);return undefined;
      }
      case "native-payload-round-open": active(signal); this.#requireCapture().rounds.beginRound(request.round);return undefined;
      case "native-payload-round-put": active(signal); return this.#requireCapture().rounds.putRound(request.round, request.index, request.data);
      case "native-payload-round-seal": active(signal); return this.#requireCapture().rounds.sealRound(request.round, request.bytes);
      case "native-live-index-put": active(signal); return this.#requireCapture().rounds.putLiveIndex(request.index, request.data);
      case "native-live-index-seal": active(signal); return this.#requireCapture().rounds.sealLiveIndex(request.bytes);
      case "native-payload-consolidate": {
        active(signal);
        const capture = this.#requireCapture();
        return capture.rounds.consolidate((index, bytes) => { active(signal); return capture.capture.put("payloads", index, bytes); },
          (index, ref) => { active(signal); capture.capture.reusePayload(index, ref); return Promise.resolve(); });
      }
      case "seal-native-capture": {
        const capture = this.#requireCapture();
        active(signal);
        const durable = await this.#files.capture(capture.capture.id, capture.request.workspaceBaseSha256, capture.root, signal, capture.baseline);
        capture.capture.setDurable(durable);
        return capture.capture.seal(request);
      }
      case "put-native-chunk": active(signal); return this.#requireCapture().capture.put(request.area, request.index, request.data);
      case "commit-native-capture": return this.#commit(signal);
      case "prepare-native-restore": return this.#prepare(request, signal);
      case "stream-native-restore": {
        active(signal);
        const restore = this.#requireRestore();
        return serveRestoreStream(request.port, restore.manifest[request.area].chunks.map(ref => ({
          area: request.area === "graph" ? "native-graph" as const : "native-payloads" as const,
          index: ref.index, read: () => restore.reads.read(ref),
        })), signal, 4);
      }
      case "read-native-restore": {
        active(signal);
        const ref = this.#requireRestore().manifest[request.area].chunks[request.index];
        if (ref === undefined || ref.index !== request.index) return invalid("Native restore chunk is out of range");
        const bytes = await this.#requireRestore().reads.read(ref);
        active(signal);
        return bytes;
      }
      case "stage-native-cold-workspace": {
        const result = await stageNativeWorkspace(() => this.#cold.files(request.sourceId,request.publication.workspaceBaseSha256), request.publication, signal);
        if (result.retired && result.outcome.kind === "committed") this.#cold.staged(request.sourceId, request.preserve);
        return result;
      }
      case "publish-native-cold": return this.#cold.publish(request.sourceId, signal);
      case "complete-native-cold": return this.#cold.complete(request.sourceId);
      case "stage-native-workspace": {
        let restore:Restore|undefined;
        const result=await stageNativeWorkspace(()=>{
          restore=this.#requireRestore();
          if(!restore.automatic||restore.published||restore.workspaceStaged||request.publication.workspaceBaseSha256!==restore.workspaceBase||request.preservedId!==undefined&&request.preservedId!==restore.originalFiles)invalid("Native workspace staging authority is invalid");
          return restore.files;
        },request.publication,signal);
        if(result.retired&&result.outcome.kind==="committed"&&restore!==undefined){restore.workspaceStaged=true;if(request.preservedId!==undefined)restore.preservedId=request.preservedId;}
        return result;
      }
      case "publish-native-restore": {
        const restore = this.#requireRestore();
        if (restore.published) return invalid("Native file selection was already published");
        if(restore.automatic&&restore.newerFiles.workspace&&!restore.workspaceStaged)return invalid("Automatic restore workspace is not durably staged");
        await restore.files.commit(signal, restore.next,restore.preservedId,restore.initialStart);
        restore.published = true;
        await this.#rootOperation(new AbortController().signal,()=>this.#environment.rootfs.activateCheckpoint(this.#owner(restore.manifest.id),restore.destination.trusted));
        return undefined;
      }
      case "complete-native-restore": {
        const restore = this.#requireRestore();
        if (!restore.published) return invalid("Native restore is not published");
        restore.retireVerification();
        this.#restore = undefined;
        if (restore.next.replaced !== restore.originalFiles) await this.#release(restore.originalFiles).catch(()=>{});
        if(restore.previous?.image!==undefined&&restore.previous.image!==restore.imagePin)await this.#environment.rootfs.releaseCheckpoint(this.#owner(restore.previous.image)).catch(()=>{});
        return undefined;
      }
      case "native-session": return this.#environment.selections.session();
      case "retire-native-recovery": {
        const session = await this.#environment.selections.session();
        if (session?.recovery === request.snapshot.id || this.#restore?.recovery?.id === request.snapshot.id) return invalid("Recovery is still in use");
        if (!await this.#recovery.exists(request.snapshot.id)) return undefined;
        await this.#load(request.snapshot, true);
        await this.#recovery.delete(request.snapshot.id);
        await this.#release(request.snapshot.id);
        return undefined;
      }
    }
  }

  #accelerate(signal:AbortSignal):Promise<void> {
    if(this.#acceleration!==undefined)return this.#acceleration.job;
    const controller=new AbortController(),cancel=()=>controller.abort();
    signal.addEventListener("abort",cancel,{once:true});if(signal.aborted)cancel();
    // AutoSave owns this background request. A foreground transaction interrupts the optional work.
    const job=Promise.resolve().then(()=>this.#environment.rootfs.compactImage(controller.signal)).catch(()=>{}).finally(()=>{
      signal.removeEventListener("abort",cancel);if(this.#acceleration?.controller===controller)this.#acceleration=undefined;
    });
    this.#acceleration={controller,job};return job;
  }

  async #baseline(ref:SnapshotRef,rootfs:UserspaceSnapshotManifest["rootfs"],memoryBytes:number,rootPersistence:"ephemeral"|"persistent",signal:AbortSignal):Promise<{readonly manifest:UserspaceSnapshotManifest;readonly reads:SnapshotReadLease}> {
    try {
      const manifest=await this.#load(ref);
      if((manifest.durable?.root!==undefined)!==(rootPersistence==="persistent")||manifest.compatibility.memoryBytes!==memoryBytes||manifest.rootfs.rootTreeSha256!==rootfs.rootTreeSha256||manifest.rootfs.manifest.sha256!==rootfs.manifest.sha256)throw new Error("Baseline identity changed");
      const reads=await this.#objects.openVerifiedReads(manifestObjects(manifest),signal);
      return {manifest,reads};
    } catch(error) {active(signal);if(error instanceof VMError&&error.code==="ABORTED")throw error;throw new VMError("STORAGE_NOT_FOUND","Native incremental baseline is unavailable",{reason:"checkpoint-baseline-unavailable"});}
  }

  async #open(request: Open, signal: AbortSignal, progress?: (value:SnapshotStorageProgress) => void): Promise<void> {
    this.#acceleration?.controller.abort();this.#idle(); active(signal);
    const catalog = request.recovery === true ? this.#recovery : this.#catalog;
    if (await this.#catalog.exists(request.snapshot.id) || await this.#recovery.exists(request.snapshot.id)) invalid("Native snapshot identity already exists");
    await catalog.beginIntent({ kind: "capture", snapshot: request.snapshot.id });
    let baselineReads:SnapshotReadLease|undefined;
    try {
      const parent = await this.#parent(request.baseline?.id ?? request.parentId), previous = await this.#environment.selections.session();
      const running = this.#environment.rootfs.currentCheckpointSource();
      const imageBaseline = parent!==undefined&&parent.rootfs.manifest.sha256===running.manifest.sha256 ? parent
        : previous?.image===undefined ? parent : {id:previous.image,rootfs:running};
      let reportedAt = 0, reported = 0;
      const saved = await this.#rootOperation(signal, () => this.#environment.rootfs.captureCheckpoint(this.#owner(request.snapshot.id), completed => {
        active(signal);
        // Image preparation repeats object counts with byte and stage updates; capture progress
        // on the snapshot channel must strictly increase.
        if (completed <= reported) return;
        const now = performance.now();
        if (reported === 0 || now - reportedAt >= 1_000) { progress?.(completed); reported = completed; reportedAt = now; }
      }, imageBaseline === undefined ? undefined : { owner: this.#owner(imageBaseline.id), rootfs: imageBaseline.rootfs },signal, value=>{
        progress?.(decodeImagePreparationReport({ ...value }));
      }), true);
      active(signal);
      const ref = await this.#objects.put(saved.manifest);
      if (ref.sha256 !== saved.rootfs.manifest.sha256 || ref.bytes !== saved.rootfs.manifest.bytes) invalid("Native rootfs manifest identity changed");
      const selected=request.baseline===undefined?undefined:await this.#baseline(request.baseline,saved.rootfs,request.memoryBytes,request.rootPersistence,signal);
      const baseline=selected?.manifest;baselineReads=selected?.reads;
      const rounds=new NativePayloadRounds(this.#objects);if(baseline!==undefined)await rounds.setBaseline(baseline.payloads,baselineReads);
      active(signal);
      this.#capture = { request,...(baseline===undefined?{}:{baseline}),...(baselineReads===undefined?{}:{baselineReads}), capture: new NativeSnapshotCapture(this.#objects, request, saved.rootfs), catalog,
        rounds,
        ...(request.rootPersistence === "persistent" ? { root: saved.rootfs.rootTreeSha256 } : {}) };
    } catch (error) {
      baselineReads?.retire();
      await this.#release(request.snapshot.id);
      await catalog.endIntent(request.snapshot.id);
      throw error;
    }
  }

  async #commit(signal: AbortSignal): Promise<SnapshotRef> {
    active(signal);
    const capture = this.#requireCapture();
    const manifest = capture.capture.manifest();
    await capture.catalog.commit(manifest);
    // Retain dirty generations if the committed point's resume pointer cannot be saved.
    const previous = await this.#environment.selections.session();
    if (capture.request.recovery === true) {
      await this.#environment.selections.setSession({ ...(previous ?? { resume: null }), recovery: manifest.id });
    } else {
      await this.#environment.selections.setSession({ resume: manifest.id,
        ...(previous?.image===undefined?{}:{image:previous.image}),
        ...(manifest.kind === "named" || previous?.replaced === undefined ? {} : { replaced: previous.replaced }) });
    }
    capture.baselineReads?.retire();this.#capture = undefined;
    // The commit marker is the outcome, even if retirement is interrupted.
    await capture.catalog.endIntent(manifest.id).catch(() => {});
    return { id: manifest.id, createdAt: manifest.createdAt };
  }

  async #prepare(request: Prepare, signal: AbortSignal): Promise<unknown> {
    this.#acceleration?.controller.abort();this.#idle(); active(signal);
    const retireRootfs = await this.#environment.rootfs.beginCheckpointVerification(signal);
    let reads: SnapshotReadLease | undefined;
    const retireVerification = () => { reads?.retire(); retireRootfs(); };
    this.#selecting = true;
    let retained = false;
    try {
      const manifest = await this.#load(request.snapshot);
      const previousInitialStart=(await this.#environment.selections.initialStartEvidence()).initialStart;
      if(request.initialStart!==undefined) {
        const source=await this.#catalog.shippedSource(manifest.id);
        if(source===undefined||!sameShippedIdentity(source,request.initialStart)||manifest.kind!=="shipped")invalid("Initial native restore does not match authenticated import");
      }
      const recovery = request.recovery === undefined ? undefined
        : request.recovery.id === manifest.id && request.recovery.createdAt === manifest.createdAt ? manifest : await this.#load(request.recovery);
      reads = await this.#objects.openVerifiedReads([manifest.rootfs.manifest], signal);
      const rootManifest = await reads.read(manifest.rootfs.manifest);
      const refs = [...manifestObjects(manifest), ...(recovery === undefined ? [] : manifestObjects(recovery))]
        .filter(ref => ref.sha256 !== manifest.rootfs.manifest.sha256 || ref.bytes !== manifest.rootfs.manifest.bytes);
      const [verification, preparation] = await Promise.allSettled([
        reads.verify(refs),
        this.#rootOperation(signal, () => this.#environment.rootfs.prepareCheckpoint(this.#owner(manifest.id), manifest.rootfs, rootManifest, request.destination)),
      ]);
      if (verification.status === "rejected") { const error: unknown = verification.reason; throw error; }
      if (preparation.status === "rejected") { const error: unknown = preparation.reason; throw error; }
      const preparedRootfs = preparation.value;
      const root = request.rootPersistence === "persistent" ? manifest.rootfs.rootTreeSha256 : undefined;
      const originalRoot=request.rootPersistence==="persistent"?this.#environment.rootfs.currentRootfs().rootTreeSha256:undefined;
      const selections = this.#environment.selections;
      const previous = await selections.session();
      const originalFiles = request.replacedId ?? crypto.randomUUID();
      await selections.retain(originalFiles, originalRoot,root);
      const imagePin=crypto.randomUUID();
      let files: PreparedNativeFiles | undefined;
      try {
        await this.#rootOperation(signal,()=>this.#environment.rootfs.captureCheckpoint(this.#owner(originalFiles)));
        await this.#rootOperation(signal,()=>this.#environment.rootfs.acquireCheckpoint(this.#owner(imagePin),manifest.rootfs,rootManifest,request.destination,"restore"));
        files = await this.#files.prepare(manifest.id, root, manifest.durable, signal, reads);
        const newerFiles=await selections.differences(originalFiles,files.id,originalRoot,root,signal);
        const next: NativeFileSession = await this.#recovery.exists(manifest.id)
          ? { ...(previous ?? { resume: null }),image:imagePin, recovery: manifest.id }
          : { resume: manifest.id,image:imagePin, ...(request.replacedId === undefined ? {} : { replaced: originalFiles }) };
        if (recovery !== undefined) await selections.setSession({ ...(previous ?? { resume: null }), recovery: recovery.id });
        this.#restore = { previousInitialStart,retireVerification, reads, newerFiles, manifest, originalFiles, previous, next, files,destination:request.destination,imagePin,automatic:request.replacedId!==undefined,workspaceBase:manifest.durable?.workspace?.baseSha256??preparedRootfs.workspaceBaseSha256??manifest.rootfs.rootTreeSha256,workspaceStaged:false, published: false, ...(recovery === undefined ? {} : { recovery }),...(request.initialStart===undefined?{}:{initialStart:request.initialStart}) };
        const attachment = manifest.host?.attachment === undefined ? undefined : await reads.read(manifest.host.attachment);
        const appData = manifest.host?.appData === undefined ? undefined : await reads.read(manifest.host.appData);
        retained = true;
        return { manifest,rootfs:preparedRootfs,newerFiles, ...(attachment === undefined ? {} : { attachment }), ...(appData === undefined ? {} : { appData }) };
      } catch (error) {
        await files?.abort();
        if (this.#restore !== undefined) await selections.setSession(previous ?? { resume: null });
        await this.#release(originalFiles);
        await this.#environment.rootfs.releaseCheckpoint(this.#owner(imagePin));
        this.#restore = undefined;
        throw error;
      }
    } finally { if (!retained) retireVerification(); this.#selecting = false; }
  }

  async abort(): Promise<void> {
    const acceleration=this.#acceleration;acceleration?.controller.abort();await acceleration?.job;
    await this.#cold.abort();
    const capture = this.#capture;
    if (capture !== undefined) {
      // A lost acknowledgement must not remove a committed point's pins.
      let committed = false;
      try { await capture.catalog.load(capture.capture.id); committed = true; } catch { /* No valid commit marker. */ }
      try {
        if (!committed) await this.#release(capture.capture.id);
        await capture.catalog.endIntent(capture.capture.id);
        this.#capture = undefined;
      }finally{capture.baselineReads?.retire();}
    }
    const restore = this.#restore;
    if (restore !== undefined) {
      try {
        const selections = this.#environment.selections;
        const recovered = { ...(restore.previous ?? { resume: null }), ...(restore.recovery === undefined ? {} : { recovery: restore.recovery.id }) };
        if (restore.published) {
          await selections.publish(restore.originalFiles, new AbortController().signal, recovered,undefined,restore.previousInitialStart??null);
          await this.#environment.rootfs.activateCheckpoint(this.#owner(restore.originalFiles),restore.destination.trusted);
        }
        else { await restore.files.abort(); await selections.setSession(recovered); }
        await this.#release(restore.originalFiles);
        await this.#environment.rootfs.releaseCheckpoint(this.#owner(restore.imagePin));
        this.#restore = undefined;
      } finally { restore.retireVerification(); }
    }
  }

  async objectRefs(): Promise<Set<string>> {
    const refs = new Set(this.#capture?.capture.objectRefs());
    if (this.#capture !== undefined) {for (const ref of this.#capture.rounds.objectRefs()) refs.add(ref);
      if(this.#capture.baseline!==undefined)for(const ref of manifestObjects(this.#capture.baseline))refs.add(ref.sha256);}
    for (const manifest of [this.#restore?.manifest, this.#restore?.recovery]) {
      if (manifest !== undefined) for (const ref of manifestObjects(manifest)) refs.add(ref.sha256);
    }
    for (const entry of await this.#recovery.list()) {
      if (!("manifest" in entry)) throw new VMError("STORAGE_ERROR", "Recovery checkpoint is damaged; collection is deferred");
      for (const ref of manifestObjects(entry.manifest)) refs.add(ref.sha256);
    }
    return refs;
  }

  async protectedIds(): Promise<Set<string>> {
    const session = await this.#environment.selections.session();
    return new Set([session?.resume, session?.recovery, this.#restore?.manifest.id, this.#restore?.recovery?.id,this.#capture?.baseline?.id]
      .filter((id): id is string => id !== undefined && id !== null));
  }

  async deleted(id: string): Promise<void> {
    const session = await this.#environment.selections.session();
    if (session?.resume === id) await this.#environment.selections.setSession({ ...session, resume: null });
    if (this.#restore?.manifest.id !== id && this.#restore?.recovery?.id !== id) await this.#release(id);
  }

  async collect(catalogIds: ReadonlySet<string>): Promise<void> {
    const protectedIds = await this.protectedIds();
    const kept = new Set([...catalogIds, ...protectedIds, ...this.#cold.retainedIds]);
    const session = await this.#environment.selections.session();
    if (session?.replaced !== undefined) kept.add(session.replaced);
    if (this.#capture !== undefined) kept.add(this.#capture.capture.id);
    if (this.#restore !== undefined) kept.add(this.#restore.originalFiles);
    for (const entry of await this.#recovery.list()) {
      if (!("manifest" in entry)) throw new VMError("STORAGE_ERROR", "Recovery checkpoint is damaged; collection is deferred");
      if (protectedIds.has(entry.id)) kept.add(entry.id);
      else { await this.#recovery.delete(entry.id); await this.#release(entry.id); }
    }
    await this.#environment.selections.collect(kept);
  }

  async recoveryCandidate(): Promise<UserspaceSnapshotManifest | undefined> {
    const recovery = (await this.#environment.selections.session())?.recovery;
    if (recovery === undefined) return undefined;
    const catalog = await this.#catalog.exists(recovery) ? this.#catalog : this.#recovery;
    const manifest = await catalog.load(recovery);
    if (manifest.schema !== USERSPACE_SNAPSHOT_SCHEMA) return invalid("Native recovery checkpoint has the wrong runtime");
    return manifest;
  }

  async #load(snapshot: SnapshotRef, recoveryOnly = false): Promise<UserspaceSnapshotManifest> {
    const catalog = recoveryOnly || !await this.#catalog.exists(snapshot.id) ? this.#recovery : this.#catalog;
    const manifest = await catalog.load(snapshot.id);
    if (manifest.createdAt !== snapshot.createdAt) throw new VMError("STORAGE_NOT_FOUND", "Snapshot reference differs from its manifest");
    if (manifest.schema !== USERSPACE_SNAPSHOT_SCHEMA) throw new VMError("FEATURE_NOT_AVAILABLE", "Restore point belongs to another runtime", { reason: "runtime-mismatch" });
    return manifest;
  }

  async #parent(id: string | undefined): Promise<UserspaceSnapshotManifest | undefined> {
    if (id === undefined) return undefined;
    for (const catalog of [this.#catalog, this.#recovery]) {
      if (!await catalog.exists(id)) continue;
      try {
        const manifest = await catalog.load(id);
        return manifest.schema === USERSPACE_SNAPSHOT_SCHEMA ? manifest : undefined;
      } catch (error) {
        if (error instanceof VMError && (error.code === "STORAGE_NOT_FOUND" || error.detail?.["reason"] === "snapshot-damaged")) return undefined;
        throw error;
      }
    }
    return undefined;
  }

  async #release(id: string): Promise<void> {
    if(await this.#environment.selections.isPreserved(id))return;
    await this.#environment.selections.release(id);
    await this.#environment.rootfs.releaseCheckpoint(this.#owner(id));
  }
  #owner(snapshotId: string) { return { workspaceId: this.#environment.workspaceId, snapshotId }; }
  #requireCapture(): Capture { return this.#capture ?? invalid("Native snapshot capture is not active"); }
  #requireRestore(): Restore { return this.#restore ?? invalid("Native snapshot restore is not active"); }
  #idle(): void { if (this.busy) invalid("A native snapshot transaction is already active"); }
  async #rootOperation<T>(signal: AbortSignal, work: () => Promise<T>, verify = false): Promise<T> {
    active(signal);
    const retire = verify ? await this.#environment.rootfs.beginCheckpointVerification(signal) : undefined;
    try { const value = await work(); active(signal); return value; }
    finally { retire?.(); }
  }
}
function active(signal: AbortSignal): void { if (signal.aborted) throw new VMError("ABORTED", "Native checkpoint operation cancelled"); }
function invalid(message: string): never { throw new VMError("STORAGE_ERROR", message); }
