import type {ManagedBoot} from "../protocol/storage.js";
import { VMError } from "../errors.js";
import type { SnapshotCompatibility, SnapshotInfo, SnapshotMachine, SnapshotRef, SnapshotUsage } from "../protocol.js";
import type { ManagedBases } from "./managed-base.js";
import { ManagedDisk } from "./managed-disk.js";
import {
  clearResumePoint,
  collectGenerations,
  liveChangeBase,
  managedImageStem,
  type ManagedImageRef,
  newGenerationName,
  promoteGeneration,
  readDiskHead,
  settleHead,
} from "./managed-disk-head.js";
import {
  baseIsKept,
  cachedBaseIdentities,
  cachedImageStems,
  loadPinnedImage,
  setWorkspacePins,
} from "./managed-image-pins.js";
import {
  allZero,
  type OpenCaptureRequest,
  type SealCaptureRequest,
  SnapshotCapture,
  type SnapshotBoot,
} from "./snapshot-capture.js";
import { SnapshotCatalog } from "./snapshot-catalog.js";
import type { PreparedSnapshotRestore, SnapshotStorageRequest, SnapshotStorageProgress } from "./snapshot-channel.js";
import {
  encodeSnapshotManifest,
  isZeroChunk,
  manifestObjects,
  MAX_ASSET_BYTES,
  type ObjectRef,
  objectRef,
  SNAPSHOT_CHUNK_BYTES,
  type SnapshotDisk,
  type SnapshotManifest,
  type SystemSnapshotManifest,
  snapshotMode,
  snapshotChunkLength,
} from "./snapshot-manifest.js";
import { sha256Hex } from "./snapshot-content.js";
import { isNotFound, SnapshotObjects } from "./snapshot-objects.js";
import type { RestoreStreamChunk } from "./snapshot-restore-stream.js";
import { importBootAssets, importedManifest, SnapshotImport, type SnapshotImportOptions } from "./snapshot-import.js";
import {sameShippedIdentity, type ShippedInstallIdentity} from "../protocol/shipped-source.js";
import { compatibility, describeSnapshots } from "./snapshot-listing.js";
import { type RetentionClock, retainedSnapshots } from "./snapshot-retention.js";
import { NativeSnapshotStore, type NativeSnapshotEnvironment } from "./snapshot-native-store.js";
import type { NativeSnapshotStorageRequest } from "./snapshot-native-channel.js";
import {
  decodeWorkspaceIndex,
  encodeWorkspaceIndex,
  indexWorkspaceSnapshot,
  type WorkspacePlan,
  workspaceChanges,
} from "./workspace-index.js";

const ROOT = "snapshots-v2";

type RememberBootRequest = Extract<SnapshotStorageRequest, { readonly type: "remember-boot" }>;

interface PendingRestore {
  readonly manifest: SystemSnapshotManifest;
  readonly disk?: ManagedDisk;
  diskCommitted: boolean;
  readonly initialStart?:ShippedInstallIdentity;
}

/** A committed restore point an export reads, its objects held from collection until `release`. */
export interface SnapshotExport {
  readonly manifest: SnapshotManifest;
  read(ref: ObjectRef): Promise<Uint8Array<ArrayBuffer>>;
  release(): void;
}

/** Where the store keeps images and pins, and the clock its retention reads. */
export interface SnapshotEnvironment {
  /** The origin's managed image cache. */
  readonly images: FileSystemDirectoryHandle;
  /** The storage owner's shared base packs. */
  readonly bases: ManagedBases;
  /** The workspace whose image pins (`managed-images/pins/<workspaceId>.json`) the store keeps. */
  readonly workspaceId: string;
  readonly clock: RetentionClock;
  /** The workspace overlay a managed boot's restore points record. */
  readonly workspace?: WorkspaceSource;
  /** The full-system VM whose restore points these are; a listing compares them with it. */
  readonly machine?: SnapshotMachine;
  /** The managed profile the VM runs, once its image is prepared. */
  readonly image?: () => { readonly id: string } | undefined;
  /** The browser's storage estimate and persistence for this origin, where it reports them. */
  readonly quota?: () => Promise<Pick<SnapshotUsage, "estimate" | "persisted">>;
  readonly native?: Omit<NativeSnapshotEnvironment, "workspaceId"> & {
    readonly cachedImages: (availableRoot?: string) => Promise<ReadonlySet<string>>;
  };
}

/** The managed boot's workspace overlay as the workspace store holds it. */
export interface WorkspaceSource {
  /** The workspace base of the managed image this boot runs; undefined for other boots. */
  readonly base: () => string | undefined;
  /** The store's overlay of `baseSha256` now; undefined before its first commit. */
  readonly read: (
    baseSha256: string,
  ) => Promise<{ readonly generation: number; readonly snapshot: Uint8Array<ArrayBuffer> } | undefined>;
}

/**
 * The workspace's restore points (layout `snapshots-v2/{manifests,commits,objects,intents}`, kept
 * by the catalog), its single active capture or restore transaction, and the maintenance that
 * thins automatic points and collects what nothing needs.
 */
export class SnapshotStore {
  readonly #workspace: FileSystemDirectoryHandle;
  readonly #objects: SnapshotObjects;
  readonly #catalog: SnapshotCatalog;
  readonly #environment: SnapshotEnvironment;
  readonly #native: NativeSnapshotStore | undefined;
  #boot: SnapshotBoot | undefined;
  /**
   * The snapshot the running VM last committed or restored: the parent of its next incremental
   * capture. It stays usable, and its objects stay referenced, after the point is deleted.
   */
  #lineage: SystemSnapshotManifest | undefined;
  #capture: SnapshotCapture | undefined;
  #restore: PendingRestore | undefined;
  /** The index object of each workspace generation already recorded (`<base>:<generation>`). */
  readonly #workspaceIndexes = new Map<string, ObjectRef>();
  /** Backup exports reading objects and imports storing them, held from collection. */
  readonly #transfers = new Set<{ objectRefs(): Iterable<string> }>();

  private constructor(
    workspace: FileSystemDirectoryHandle,
    objects: SnapshotObjects,
    catalog: SnapshotCatalog,
    environment: SnapshotEnvironment,
    native?: NativeSnapshotStore,
  ) {
    this.#workspace = workspace;
    this.#objects = objects;
    this.#catalog = catalog;
    this.#environment = environment;
    this.#native = native;
  }

  /**
   * Opens the v2 store and settles the intents a closed tab left. Its first open drops the
   * development v1 store and restore generations.
   */
  static async open(workspace: FileSystemDirectoryHandle, environment: SnapshotEnvironment): Promise<SnapshotStore> {
    if (!(await hasDirectory(workspace, ROOT))) await dropDevelopmentStore(workspace);
    const root = await workspace.getDirectoryHandle(ROOT, { create: true });
    const objects = await SnapshotObjects.open(root);
    const catalog = new SnapshotCatalog(root, objects);
    await catalog.recover();
    let native: NativeSnapshotStore | undefined;
    if (environment.native !== undefined) {
      const recovery = new SnapshotCatalog(await root.getDirectoryHandle("native-recovery", { create: true }), objects);
      await recovery.recover();
      native = new NativeSnapshotStore(objects, catalog, recovery, { ...environment.native, workspaceId: environment.workspaceId });
    }
    return new SnapshotStore(workspace, objects, catalog, environment, native);
  }

  abortNativeFiles(sourceId:string):Promise<void> {if(this.#native===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","Native checkpoint storage is unavailable");return this.#native.abortCold(sourceId);}

  selectNativeFiles(request:{readonly boot:ManagedBoot;readonly rootTreeSha256:string;readonly rootPersistence:"ephemeral"|"persistent"},signal:AbortSignal):Promise<{readonly sourceId:string;readonly replaced?:string}> {
    this.#assertIdle();if(this.#native===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","Native checkpoint storage is unavailable");
    return this.#native.selectFiles(request,signal);
  }

  retainedNativeReadId(id:string):string { return this.#native?.retainedReadId(id)??id; }

  handleNative(request: NativeSnapshotStorageRequest, signal: AbortSignal, progress?: (progress: SnapshotStorageProgress) => void): Promise<unknown> {
    if (this.#capture !== undefined || this.#restore !== undefined) throw new VMError("STORAGE_ERROR", "Another snapshot transaction is active");
    if (this.#native === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Native checkpoint storage is unavailable");
    return this.#native.handle(request, signal, progress);
  }

  async rememberBoot(request: RememberBootRequest, managedDisk: ManagedDisk | undefined): Promise<void> {
    await this.abort();
    if (
      request.kernel.byteLength === 0 ||
      request.kernel.byteLength > MAX_ASSET_BYTES ||
      (request.initrd?.byteLength ?? 0) > MAX_ASSET_BYTES ||
      (request.disk?.byteLength ?? 0) > MAX_ASSET_BYTES ||
      (request.managedDisk && request.disk !== undefined) ||
      (request.managedDisk && managedDisk === undefined)
    ) {
      throw new VMError("STORAGE_ERROR", "snapshot boot assets are inconsistent");
    }
    const kernel = await this.#objects.put(request.kernel);
    const initrd = request.initrd === undefined ? undefined : await this.#objects.put(request.initrd);
    let disk: SnapshotBoot["disk"] = null;
    if (request.disk !== undefined) {
      if (request.disk.byteLength === 0 || request.disk.byteLength % 512 !== 0) {
        throw new VMError("STORAGE_ERROR", "snapshot base disk is invalid");
      }
      const base = new Map<number, ObjectRef>();
      for (let offset = 0; offset < request.disk.byteLength; offset += SNAPSHOT_CHUNK_BYTES) {
        const bytes = request.disk.subarray(offset, Math.min(offset + SNAPSHOT_CHUNK_BYTES, request.disk.byteLength));
        if (!allZero(bytes)) base.set(offset / SNAPSHOT_CHUNK_BYTES, await this.#objects.put(bytes));
      }
      disk = {
        origin: "core",
        bytes: request.disk.byteLength,
        baseIdentity: await sha256Hex(request.disk.slice()),
        base,
      };
    } else if (request.managedDisk) {
      disk = { origin: "managed" };
      // A cold boot leaves every restore point behind.
      await clearResumePoint(await this.#disks());
    }
    this.#boot = { kernel, ...(initrd === undefined ? {} : { initrd }), disk };
    this.#lineage = undefined;
  }

  /**
   * The restore points a resume tries, in order: the one the VM last matched, then the automatic
   * saves before it, newest first. None once the image booted cold, or when that point is gone.
   */
  async resumeCandidates(): Promise<SnapshotInfo[]> {
    if (this.#environment.machine?.mode === "userspace") {
      const recovery = await this.#native?.recoveryCandidate();
      if (recovery !== undefined) return describeSnapshots([{ id: recovery.id, manifest: recovery }], {
        machine: this.#environment.machine, image: this.#environment.image?.(), cachedImages: await this.#cachedImages(),
      });
      const resume = (await this.#environment.native?.selections.session())?.resume;
      if (resume === undefined || resume === null) return [];
      const points = (await this.list()).filter(info => info.mode === "userspace");
      const latest = points.find(info => info.ref.id === resume);
      if (latest === undefined) return [];
      return [latest, ...points.filter(info => info.kind === "automatic" && info.ref.id !== resume && info.capturedAtUnixMs < latest.capturedAtUnixMs)];
    }
    const pointer = (await readDiskHead(await this.#disks()))?.resume ?? null;
    if (pointer === null) return [];
    const infos = await this.list();
    const latest = infos.find((info) => info.ref.id === pointer);
    if (latest === undefined) return [];
    return [
      latest,
      ...infos.filter((info) => info.mode === latest.mode && info.kind === "automatic" && info.capturedAtUnixMs < latest.capturedAtUnixMs),
    ];
  }

  /**
   * Opens a capture before its cut, so RAM can be copied while the guest runs. The capture holds
   * the store until it commits or aborts.
   */
  async openCapture(request: OpenCaptureRequest, managedDisk: ManagedDisk | undefined): Promise<void> {
    this.#assertIdle();
    const boot = this.#boot;
    if (boot === undefined) throw new VMError("STORAGE_ERROR", "boot assets were not persisted");
    const id = request.snapshot.id;
    if (await this.#catalog.exists(id)) {
      throw new VMError("STORAGE_ERROR", "snapshot id already exists");
    }
    const parent = request.parentId === undefined ? undefined : await this.#manifest(request.parentId);
    const workspace = boot.disk?.origin === "managed" ? await this.#workspaceRecord() : undefined;
    const capture = SnapshotCapture.open(this.#objects, request, boot, managedDisk, { parent, workspace });
    await this.#catalog.beginIntent({ kind: "capture", snapshot: id });
    this.#capture = capture;
  }

  /**
   * What a resumed guest needs from the workspace store since `snapshot` was saved: nothing when
   * the store's overlay is still the generation the guest matched, else the store's changes.
   */
  async planWorkspace(snapshot: SnapshotRef): Promise<WorkspacePlan> {
    const recorded = (await this.#manifest(snapshot.id)).workspace;
    const source = this.#environment.workspace;
    if (recorded === undefined || source === undefined) return { kind: "unrecorded" };
    let overlay: Awaited<ReturnType<WorkspaceSource["read"]>>;
    try {
      overlay = await source.read(recorded.baseSha256);
    } catch (error) {
      // The store now holds another image's workspace: there is nothing to carry over.
      if (error instanceof VMError && error.detail?.["reason"] === "workspace-base-mismatch") return { kind: "unrecorded" };
      throw error;
    }
    if (overlay === undefined || overlay.generation === recorded.generation) return { kind: "in-sync" };
    const index = decodeWorkspaceIndex(await this.#objects.read(recorded.index));
    return { kind: "changed", generation: overlay.generation, changes: await workspaceChanges(index, overlay.snapshot) };
  }

  /**
   * The workspace store's overlay as this save finds it, with its index. While a full-system
   * session runs only its own synchronizations write the overlay, so what the store gains after
   * the save is either the guest's own files or edits made elsewhere (Userspace) that a resume
   * carries in. A store that cannot be read leaves the save without a record instead of failing it.
   */
  async #workspaceRecord(): Promise<SystemSnapshotManifest["workspace"]> {
    const source = this.#environment.workspace;
    const baseSha256 = source?.base();
    if (source === undefined || baseSha256 === undefined) return undefined;
    try {
      const overlay = await source.read(baseSha256);
      if (overlay === undefined) return undefined;
      const key = `${baseSha256}:${String(overlay.generation)}`;
      let index = this.#workspaceIndexes.get(key);
      // Collection may have removed an index no restore point referenced any more.
      if (index === undefined || (await this.#objects.size(index.sha256)) !== index.bytes) {
        index = await this.#objects.put(encodeWorkspaceIndex(await indexWorkspaceSnapshot(overlay.snapshot)));
        this.#workspaceIndexes.set(key, index);
      }
      return { baseSha256, generation: overlay.generation, index };
    } catch {
      return undefined;
    }
  }

  /** Seals the open capture at its cut and reads the managed disk's changed chunks. */
  async sealCapture(request: SealCaptureRequest, managedDisk: ManagedDisk | undefined): Promise<void> {
    const capture = this.#capture;
    if (capture === undefined) throw new VMError("STORAGE_ERROR", "snapshot capture is not active");
    const changeBaseId = managedDisk?.changeBase ?? null;
    const changeBase = changeBaseId === null ? undefined : await this.#manifest(changeBaseId).catch(() => undefined);
    await capture.seal(request, managedDisk, changeBase);
  }

  async putCaptureChunk(area: "ram" | "disk", index: number, data: Uint8Array): Promise<void> {
    const capture = this.#capture;
    if (capture === undefined) throw new VMError("STORAGE_ERROR", "snapshot capture is not active");
    await capture.put(area, index, data);
  }

  async commitCapture(): Promise<SnapshotRef> {
    const capture = this.#capture;
    if (capture === undefined) throw new VMError("STORAGE_ERROR", "snapshot capture is not active");
    await capture.settled();
    const manifest = capture.manifest();
    await this.#catalog.commit(manifest);
    this.#capture = undefined;
    this.#lineage = manifest;
    await this.#catalog.endIntent(manifest.id);
    const disk = capture.managedDisk;
    if (disk !== undefined) {
      // The disk equalled this snapshot at its cut; a named save after a resume also releases
      // the pre-resume generation.
      await disk.commitCut(manifest.id);
      await settleHead(await this.#disks(), manifest.id, manifest.kind === "named");
    }
    return { id: manifest.id, createdAt: manifest.createdAt };
  }

  /**
   * Prepares restoring `snapshot` over `live`, the managed disk running now, if any; the result
   * says whether that disk holds files newer than the snapshot, which the restore drops.
   */
  async prepareRestore(
    snapshot: SnapshotRef,
    canHostDisk: boolean,
    live: ManagedDisk | undefined,
    initialStart?:ShippedInstallIdentity,
  ): Promise<PreparedSnapshotRestore> {
    this.#assertIdle();
    const manifest = await this.#catalog.load(snapshot.id);
    if(initialStart!==undefined) {
      const source=await this.#catalog.shippedSource(snapshot.id);
      if(source===undefined||!sameShippedIdentity(source,initialStart)||manifest.kind!=="shipped")throw new VMError("INVALID_ARGUMENT","Initial restore source does not match authenticated import");
    }
    if (manifest.schema !== 2) throw new VMError("FEATURE_NOT_AVAILABLE", "restore point belongs to another runtime", { reason: "runtime-mismatch" });
    if (manifest.createdAt !== snapshot.createdAt) {
      throw new VMError("STORAGE_NOT_FOUND", "snapshot reference does not match its manifest");
    }
    // Every object must be present before the control worker begins the destructive restore;
    // contents are verified as they are read.
    await this.#checkObjects(manifest);
    const machineRecord = await this.#objects.read(manifest.machine.record);
    const agentState = manifest.host?.agent === undefined ? undefined : await this.#objects.read(manifest.host.agent);
    const appData = manifest.host?.appData === undefined ? undefined : await this.#objects.read(manifest.host.appData);
    const disk = manifest.disk;
    let generation: ManagedDisk | undefined;
    if (disk?.origin === "managed") {
      if (!canHostDisk) {
        throw new VMError("FEATURE_NOT_AVAILABLE", "managed-disk snapshots require cross-origin isolation");
      }
      generation = await this.#rebuildManagedDisk(manifest.id, disk);
    }
    this.#restore = { manifest, ...(generation === undefined ? {} : { disk: generation }), diskCommitted: false,...(initialStart===undefined?{}:{initialStart}) };
    return {
      snapshot,
      capturedAtUnixMs: manifest.capturedAtUnixMs,
      newerFiles: live !== undefined && await this.#holdsUnsavedFiles(live, manifest.id),
      machineRecord,
      memoryBytes: manifest.machine.memoryBytes,
      ramChunks: manifest.ram.map((chunk) => chunk.index),
      ...(agentState === undefined ? {} : { agentState }),
      ...(appData === undefined ? {} : { appData }),
      disk: {
        mode: disk === null ? "none" : disk.origin === "core" ? "core" : "host",
        bytes: disk?.bytes ?? 0,
        baseChunks: disk?.origin === "core" ? disk.base.map((chunk) => chunk.index) : [],
        overlayChunks: disk?.origin === "core" ? disk.chunks.map((chunk) => chunk.index) : [],
      },
    };
  }

  /**
   * The chunks the prepared restore streams to the core, in the order the control worker
   * applies them: a core disk's base, then RAM, then the core disk's changes. Each read verifies
   * its object; an explicit zero reads as zeros.
   */
  preparedManagedImage():ManagedImageRef|undefined { return this.#restore?.disk?.image; }

  restoreChunks(): RestoreStreamChunk[] {
    const manifest = this.#restore?.manifest;
    if (manifest === undefined) throw new VMError("STORAGE_ERROR", "snapshot restore is not active");
    const read = (ref: ObjectRef) => () => this.#objects.read(ref);
    const ram = manifest.ram.map((chunk) => ({ area: "ram" as const, index: chunk.index, read: read(chunk) }));
    const disk = manifest.disk;
    if (disk?.origin !== "core") return ram;
    return [
      ...disk.base.map((chunk) => ({ area: "disk-base" as const, index: chunk.index, read: read(chunk) })),
      ...ram,
      ...disk.chunks.map((chunk) => ({
        area: "disk-overlay" as const,
        index: chunk.index,
        read: isZeroChunk(chunk)
          ? () => Promise.resolve(new Uint8Array(snapshotChunkLength(chunk.index, disk.bytes)))
          : read(chunk),
      })),
    ];
  }

  async commitRestoreDisk(): Promise<ManagedDisk | undefined> {
    await Promise.resolve();
    const restore = this.#restore;
    if (restore === undefined) throw new VMError("STORAGE_ERROR", "snapshot restore is not active");
    if (restore.disk !== undefined) {
      await promoteGeneration(await this.#disks(), restore.disk.generation, restore.manifest.id,restore.initialStart);
    }
    restore.diskCommitted = true;
    return restore.disk;
  }

  completeRestore(): void {
    const restore = this.#restore;
    if (restore === undefined || !restore.diskCommitted) {
      throw new VMError("STORAGE_ERROR", "snapshot restore is incomplete");
    }
    const manifest = restore.manifest;
    this.#boot = {
      kernel: manifest.assets.kernel,
      ...(manifest.assets.initrd === undefined ? {} : { initrd: manifest.assets.initrd }),
      disk: bootDisk(manifest.disk),
    };
    this.#lineage = manifest;
    this.#restore = undefined;
  }

  /**
   * Whether restoring `restoring` over `live` drops files no kept restore point holds: changes
   * since its change base, or a change base (other than `restoring`) that was deleted since. A
   * disk that never changed, or that equals a kept restore point, holds none.
   */
  async #holdsUnsavedFiles(live: ManagedDisk, restoring: string): Promise<boolean> {
    if (live.changedChunks().length !== 0) return true;
    const base = live.changeBase;
    return base !== null && base !== restoring && !(await this.#catalog.exists(base));
  }

  /** Ends the active transaction once its writes stop; a later collection removes what it wrote. */
  async abort(): Promise<void> {
    await this.#native?.abort();
    const capture = this.#capture;
    this.#capture = undefined;
    const restore = this.#restore;
    this.#restore = undefined;
    if (restore?.disk !== undefined && !restore.diskCommitted) restore.disk.close();
    if (capture === undefined) return;
    capture.managedDisk?.abortCut();
    await capture.settled().catch(() => undefined);
    // An intent left behind is rolled back when the store next opens.
    await this.#catalog.endIntent(capture.id).catch(() => undefined);
  }

  /**
   * Every committed restore point, newest first, with whether it can resume this VM; one that
   * cannot be read follows them, so it can still be deleted.
   */
  async list(): Promise<SnapshotInfo[]> {
    const machine = this.#environment.machine;
    if (machine === undefined) {
      throw new VMError("FEATURE_NOT_AVAILABLE", "Restore point machine configuration is unavailable");
    }
    return describeSnapshots(await this.#catalog.list(), {
      machine,
      image: this.#environment.image?.(),
      cachedImages: await this.#cachedImages(),
    });
  }

  /** Whether a restore point from elsewhere fits this VM, by the listing's rules. */
  async compatibility(manifest: SnapshotManifest): Promise<SnapshotCompatibility> {
    const machine = this.#environment.machine;
    if (machine === undefined) {
      throw new VMError("FEATURE_NOT_AVAILABLE", "Restore point machine configuration is unavailable");
    }
    return compatibility(manifest, {
      machine,
      image: this.#environment.image?.(),
      cachedImages: await this.#cachedImages(),
    });
  }

  /** The committed restore point `snapshot` and a reader of its objects, held from collection until released. */
  async openExport(snapshot: SnapshotRef): Promise<SnapshotExport> {
    await this.#requireRef(snapshot);
    const manifest = await this.#catalog.load(snapshot.id);
    const held = { objectRefs: () => manifestObjects(manifest).map((ref) => ref.sha256) };
    this.#transfers.add(held);
    return {
      manifest,
      read: (ref) => this.#objects.read(ref),
      release: () => {
        this.#transfers.delete(held);
      },
    };
  }

  /**
   * Starts importing `source` as a new restore point. A managed restore point's kernel and initrd
   * come from its image, which this browser must keep with the same boot assets.
   */
  async beginImport(source: SnapshotManifest, kind: "imported" | "shipped" = "imported", options: SnapshotImportOptions = {}): Promise<SnapshotImport> {
    const assets = await importBootAssets(this.#environment.images, source);
    const transaction = await SnapshotImport.begin(
      this.#catalog,
      this.#objects,
      source,
      new Date(this.#environment.clock.now()).toISOString(),
      () => {
        this.#transfers.delete(transaction);
      },
      kind,
      options,
    );
    this.#transfers.add(transaction);
    try {
      for (const { ref, content } of assets) await transaction.put(ref, content);
    } catch (error) {
      await transaction.abort();
      throw error;
    }
    return transaction;
  }

  async findShipped(source: ShippedInstallIdentity, expected: SnapshotManifest): Promise<SnapshotInfo | undefined> {
    for (const info of await this.list()) {
      if (info.kind !== "shipped" || info.resumable !== true) continue;
      const storedSource = await this.#catalog.shippedSource(info.ref.id);
      if (storedSource === undefined || !sameShippedIdentity(storedSource,source)) continue;
      const stored = await this.#catalog.load(info.ref.id);
      if (await sha256Hex(encodeSnapshotManifest(stored)) !== await sha256Hex(encodeSnapshotManifest(importedManifest(expected,expected.createdAt,"shipped",expected.id)))) continue;
      for (const ref of manifestObjects(stored)) await this.#objects.read(ref);
      return info;
    }
    return undefined;
  }

  async rename(snapshot: SnapshotRef, label: string): Promise<SnapshotInfo> {
    await this.#requireRef(snapshot);
    await this.#catalog.rename(snapshot.id, label);
    const renamed = (await this.list()).find((info) => info.ref.id === snapshot.id);
    if (renamed === undefined) throw new VMError("STORAGE_NOT_FOUND", "snapshot was not found");
    return renamed;
  }

  /** Deletes a restore point and frees everything only it needed. */
  async delete(snapshot: SnapshotRef): Promise<void> {
    await this.#requireRef(snapshot);
    await this.#catalog.delete(snapshot.id);
    await this.#native?.deleted(snapshot.id);
    await this.#collect();
  }

  async usage(): Promise<SnapshotUsage> {
    const objects = await this.#catalog.usage(await this.#roots());
    const browser = (await this.#environment.quota?.()) ?? { estimate: null, persisted: null };
    return { ...objects, estimate: browser.estimate, persisted: browser.persisted };
  }

  /**
   * Refuses a reference whose creation time differs from its readable manifest; a damaged
   * restore point is named by its id alone.
   */
  async #requireRef(snapshot: SnapshotRef): Promise<void> {
    let manifest: SnapshotManifest;
    try {
      manifest = await this.#catalog.load(snapshot.id);
    } catch (error) {
      if (error instanceof VMError && error.code === "STORAGE_NOT_FOUND") throw error;
      return;
    }
    if (manifest.createdAt !== snapshot.createdAt) {
      throw new VMError("STORAGE_NOT_FOUND", "snapshot reference does not match its manifest");
    }
  }

  /**
   * Thins automatic restore points (ADR 0014 retention), then removes every object, disk
   * generation and image pin nothing needs any more.
   */
  async maintain(): Promise<void> {
    await this.#applyRetention();
    await this.#collect();
  }

  async #applyRetention(): Promise<void> {
    const points = (await this.#catalog.list()).flatMap((entry) => "manifest" in entry
      ? [{ id: entry.id, mode: snapshotMode(entry.manifest), kind: entry.manifest.kind, capturedAtUnixMs: entry.manifest.capturedAtUnixMs }]
      : []);
    const { clock } = this.#environment;
    const kept = retainedSnapshots(points, clock.now(), clock.startOfDay);
    // The live disk's change base keeps the next capture incremental; a restore reads its source.
    const changeBase = await liveChangeBase(await this.#disks());
    if (changeBase !== null) kept.add(changeBase);
    if (this.#restore !== undefined) kept.add(this.#restore.manifest.id);
    for (const id of await this.#native?.protectedIds() ?? []) kept.add(id);
    for (const point of points) {
      if (!kept.has(point.id)) {
        await this.#catalog.delete(point.id);
        await this.#native?.deleted(point.id);
      }
    }
  }

  async #collect(): Promise<void> {
    const entries = await this.#catalog.list();
    if (entries.every(entry => "manifest" in entry)) await this.#native?.collect(new Set(entries.map(entry => entry.id)));
    await this.#catalog.collect(await this.#roots());
    const inUse = new Set<string>();
    if (this.#restore?.disk !== undefined) inUse.add(this.#restore.disk.generation);
    const { liveImages } = await collectGenerations(await this.#disks(), inUse);
    await this.#pinImages(liveImages);
  }

  /**
   * Pins exactly the images the live disk generations and the managed restore points need, so
   * stale-image cleanup may remove the rest. Pins stay as they are while a restore point cannot
   * be read, because its image is unknown.
   */
  async #pinImages(liveImages: readonly ManagedImageRef[]): Promise<void> {
    const { images, workspaceId } = this.#environment;
    const stems = new Set(liveImages.map(managedImageStem));
    const cached = await cachedImageStems(images);
    for (const entry of await this.#catalog.list()) {
      if (!("manifest" in entry)) return;
      const disk = entry.manifest.schema === 2 ? entry.manifest.disk : undefined;
      const stem = disk?.origin === "managed" ? cached.get(disk.baseIdentity) : undefined;
      if (stem !== undefined) stems.add(stem);
    }
    await setWorkspacePins(images, workspaceId, stems);
  }

  /**
   * The objects the current boot and the active transaction need before anything commits. Waits
   * for the capture's in-flight writes, so each written object is either referenced or known.
   */
  async #roots(): Promise<Set<string>> {
    await this.#capture?.settled().catch(() => undefined);
    const roots = new Set<string>();
    for (const ref of await this.#native?.objectRefs() ?? []) roots.add(ref);
    const boot = this.#boot;
    if (boot !== undefined) {
      roots.add(boot.kernel.sha256);
      if (boot.initrd !== undefined) roots.add(boot.initrd.sha256);
      if (boot.disk?.origin === "core") for (const ref of boot.disk.base.values()) roots.add(ref.sha256);
    }
    for (const sha256 of this.#capture?.objectRefs() ?? []) roots.add(sha256);
    for (const transfer of this.#transfers) for (const sha256 of transfer.objectRefs()) roots.add(sha256);
    for (const manifest of [this.#lineage, this.#restore?.manifest]) {
      if (manifest !== undefined) for (const ref of manifestObjects(manifest)) roots.add(ref.sha256);
    }
    return roots;
  }

  /** The lineage snapshot when `id` names it, otherwise the committed snapshot `id`. */
  async #manifest(id: string): Promise<SystemSnapshotManifest> {
    const manifest = this.#lineage?.id === id ? this.#lineage : await this.#catalog.load(id);
    if (manifest.schema !== 2) throw new VMError("FEATURE_NOT_AVAILABLE", "restore point belongs to another runtime", { reason: "runtime-mismatch" });
    return manifest;
  }

  /**
   * Builds an overlay-only generation for a managed snapshot: the shared base pack of its pinned
   * image underneath, the snapshot's chunks and explicit zeros written over it. Nothing of the
   * base is copied.
   */
  async #rebuildManagedDisk(
    snapshotId: string,
    disk: Extract<SnapshotDisk, { readonly origin: "managed" }>,
  ): Promise<ManagedDisk> {
    const { images, bases } = this.#environment;
    const image = await loadPinnedImage(images, disk.baseIdentity);
    if (
      image === undefined || image.manifest.disk.bytes !== disk.bytes
      || !(await baseIsKept(images, managedImageStem(image.ref), image.ref.identity))
    ) {
      throw new VMError("STORAGE_NOT_FOUND", "the snapshot's base image is not available", {
        reason: "base-missing",
      });
    }
    const generation = await ManagedDisk.open(
      await this.#disks(),
      newGenerationName(),
      { ref: image.ref, manifest: image.manifest },
      await bases.acquire(images, managedImageStem(image.ref), image.manifest.disk.chunks),
    );
    try {
      for (const chunk of disk.chunks) {
        generation.write(
          chunk.index * SNAPSHOT_CHUNK_BYTES,
          isZeroChunk(chunk) ? new Uint8Array(snapshotChunkLength(chunk.index, disk.bytes)) : await this.#objects.read(chunk),
        );
      }
      await generation.commitSnapshot(snapshotId);
      return generation;
    } catch (error) {
      generation.close();
      throw error;
    }
  }

  async #checkObjects(manifest: SnapshotManifest): Promise<void> {
    for (const ref of manifestObjects(manifest)) {
      if ((await this.#objects.size(ref.sha256)) !== ref.bytes) {
        throw new VMError("STORAGE_NOT_FOUND", "a snapshot object is missing", { reason: "snapshot-damaged" });
      }
    }
  }

  #disks(): Promise<FileSystemDirectoryHandle> {
    return this.#workspace.getDirectoryHandle("managed-disks", { create: true });
  }

  #assertIdle(): void {
    if (this.#capture !== undefined || this.#restore !== undefined || this.#native?.busy === true) {
      throw new VMError("STORAGE_ERROR", "another snapshot transaction is active");
    }
  }

  async #cachedImages(): Promise<ReadonlySet<string>> {
    const native=this.#environment.native;
    if(this.#environment.machine?.mode!=="userspace"||native===undefined)return cachedBaseIdentities(this.#environment.images);
    const availableRoot = this.#environment.image?.() === undefined ? undefined : native.rootfs.currentRootfs().rootTreeSha256;
    const identities=new Set(await native.cachedImages(availableRoot));
    // Preparation authenticates the active source before it mounts. A backup of
    // that root can acquire its unread closure during import; it needs no prior
    // complete checkpoint pin in this new browser.
    if(availableRoot!==undefined)identities.add(availableRoot);
    return identities;
  }
}

function bootDisk(disk: SnapshotDisk | null): SnapshotBoot["disk"] {
  if (disk === null) return null;
  if (disk.origin === "managed") return { origin: "managed" };
  return {
    origin: "core",
    bytes: disk.bytes,
    baseIdentity: disk.baseIdentity,
    base: new Map(disk.base.map((chunk) => [chunk.index, objectRef(chunk)])),
  };
}

/** Removes the development-only v1 store and the restore generations it created. */
async function dropDevelopmentStore(workspace: FileSystemDirectoryHandle): Promise<void> {
  await removeIfPresent(workspace, "snapshots-v1");
  let disks: FileSystemDirectoryHandle;
  try {
    disks = await workspace.getDirectoryHandle("managed-disks");
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  await removeIfPresent(disks, "generations");
  await removeIfPresent(disks, "active");
}

async function removeIfPresent(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await directory.removeEntry(name, { recursive: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function hasDirectory(directory: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await directory.getDirectoryHandle(name);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}
