import {storageOutcome} from "./storage-outcome.js";
import {checkpointWorkspaceRead} from "./checkpoint-workspace-read.js";
import {currentSystemImage} from "./current-system-image.js";
import { checkManagedImageUpdate } from "./managed-image-update.js";
import type {ImageTrust} from "../image-provenance.js";
/// <reference lib="webworker" />

import {
  VMError,
  normalizeStorageError,
  serializeUnknownError,
} from "../errors.js";
import {
  decodeRequestId,
  decodeStorageIncoming,
  PROTOCOL_VERSION,
  type StorageRequest,
  type WorkerResponse,
  type WorkspaceEntry,
  type PreparedUserspaceRootfs,
} from "../protocol.js";
import {
  normalizeWorkspacePath,
  validateWorkspaceId,
  workspaceLockName,
} from "../workspace-path.js";
import { ManagedBases } from "./managed-base.js";
import { acquireLocalDataLock, eraseLocalDataStorage } from "./local-data.js";
import type { ManagedDisk } from "./managed-disk.js";
import { DISK_RESERVE_BYTES, SpaceReserve } from "./managed-disk-reserve.js";
import { prepareManagedDisk, prepareCurrentManagedImage } from "./managed-image-cache.js";
import { StorageDiskBridge } from "./storage-disk-bridge.js";
import { RootfsNetworkClient } from "./rootfs-network-channel.js";
import { RootfsStore } from "./rootfs-store.js";
import { inspectStartImage,inspectStoredNativeStart } from "./startup-image.js";
import {
  type UserspaceStorageRequest,
  type UserspaceStorageValue,
} from "./userspace-storage-channel.js";
import {
  type SnapshotStorageRequest,
  type SnapshotStorageProgress,
} from "./snapshot-channel.js";
import { serveRestoreStream } from "./snapshot-restore-stream.js";
import { serveSnapshotStorage } from "./snapshot-storage-server.js";
import { SYSTEM_CLOCK } from "./snapshot-retention.js";
import { SnapshotStore } from "./snapshot-store.js";
import { type ArchiveRun, clearStagedExports, exportBackup, importBackup, inspectBackup } from "./snapshot-archive-jobs.js";
import { shippedError } from "./snapshot-archive/shipped.js";
import { fetchBounded, installShipped } from "./shipped-install.js";
import {resolveShippedSource} from "./shipped-source.js";
import {InitialStart} from "./initial-start.js";
import type { ManagedImageSnapshot } from "../managed-image.js";
import type { ManagedImageRef } from "./managed-disk-head.js";
import { readBrowserQuota } from "./browser-quota.js";
import { WorkspacePublications } from "./workspace-publication.js";
import { WorkspaceStore } from "./workspace-store.js";
import { WorkspaceSelections } from "./workspace-selections.js";
import { serveUserspaceStorage } from "./userspace-storage-server.js";
import { UserspaceRootStorage } from "./userspace-root-storage.js";
import { openAccelerationKnowledgeDatabase, readAccelerationKnowledge, writeAccelerationKnowledge, type AccelerationKnowledgeBackend } from "./acceleration-knowledge.js";
import { retireWorkspaceTransfer } from "./workspace-transfer.js";
import { descend, parentDirectory, indexedDbWorkspaceStoreBackend, opfsWorkspaceStoreBackend, reserveWorkspaceWrites, indexedDbRead, indexedDbWrite, indexedDbRemove, indexedDbKeys } from "./workspace-backend.js";

type StorageState =
  | { readonly kind: "uninitialized" }
  | {
      readonly kind: "indexeddb-fallback";
      readonly database: Promise<IDBDatabase>;
      readonly overlayDatabase: Promise<IDBDatabase>;
    }
  | {
      readonly kind: "opfs";
      readonly workspaceId: string;
      readonly root: FileSystemDirectoryHandle;
      readonly oxidevm: FileSystemDirectoryHandle;
      readonly overlayRoot: FileSystemDirectoryHandle;
    };

let storage: StorageState = { kind: "uninitialized" };
let diskBridge: StorageDiskBridge | undefined;
let managedDisk: ManagedDisk | undefined;
/** Shared base packs of every disk generation this worker opens. */
const managedBases = new ManagedBases();
let snapshotStore: SnapshotStore | undefined;
let snapshotChannel: ReturnType<typeof serveSnapshotStorage> | undefined;
/**
 * The managed image last prepared: its profile, which restore points must share to resume, and
 * its workspace base, whose overlay they record.
 */
let systemImageTrust:ImageTrust|undefined;
let systemRequestedImage:{readonly id:string;readonly version:string}|undefined;
let preparedImage: {
  readonly id: string;
  readonly workspaceBaseSha256: string | undefined;
  readonly ref: ManagedImageRef;
  readonly snapshots: readonly ManagedImageSnapshot[];
  readonly manifestSHA256?: string;
} | undefined;
let rootfsStore: RootfsStore | undefined;
let preparedUserspace: PreparedUserspaceRootfs | undefined;
let workspaceStore: WorkspaceStore | undefined;
let workspaceSelections: WorkspaceSelections | undefined;
let initialStart: InitialStart | undefined;
let workspaceReserve: SpaceReserve | undefined;
const workspacePublications = new WorkspacePublications();
let releaseWorkspaceLock: (() => void) | undefined;
let ephemeralWorkspaceId: string | undefined;
let releaseLocalDataLock: (() => Promise<void>) | undefined;
let userspaceStorage: ReturnType<typeof serveUserspaceStorage> | undefined;
let userspaceRootStorage: UserspaceRootStorage | undefined;
let lastRequestId = 0;
let queue = Promise.resolve();
const active = new Map<number, { readonly controller: AbortController; readonly type: StorageRequest["type"]; running: boolean }>();

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  receive(event.data);
});

function receive(value: unknown): void {
  let request: ReturnType<typeof decodeStorageIncoming>;
  try {
    request = decodeStorageIncoming(value);
  } catch (error) {
    const id = decodeRequestId(value);
    if (id !== undefined) postFailure(id, error);
    return;
  }
  if (request.type === "cancel") {
    const pending = active.get(request.requestId);
    if (pending !== undefined) {
      pending.controller.abort();
    }
    return;
  }
  if (request.id <= lastRequestId) {
    postFailure(
      request.id,
      new VMError("PROTOCOL_ERROR", `duplicate request id ${request.id}`),
    );
    return;
  }
  lastRequestId = request.id;
  if (request.type === "dispose" || request.type === "initialize") {
    void snapshotChannel?.close();
    for (const job of active.values()) if (isArchiveJob(job.type)) job.controller.abort();
  }
  active.set(request.id, { controller: new AbortController(), type: request.type, running: false });
  // A backup job takes one queue turn per chunk, so other requests run between its chunks.
  if (isArchiveJob(request.type)) void respond(request);
  else queue = queue.then(() => respond(request));
}

function isArchiveJob(type: StorageRequest["type"]): boolean {
  return type === "snapshot-export" || type === "snapshot-import" || type === "snapshot-install-shipped";
}

/** Runs `turn` as one turn of the storage queue, after everything queued before it. */
function enqueue<T>(turn: () => Promise<T>): Promise<T> {
  const work = queue.then(turn);
  queue = work.then(() => undefined, () => undefined);
  return work;
}

async function respond(request: StorageRequest): Promise<void> {
  let response: WorkerResponse;
  try {
    const value=await storageOutcome(request.type,()=>{
      const pending=active.get(request.id);if(pending!==undefined)pending.running=true;
      return handle(request);
    },()=>abortIfCanceled(request.id));
    response = {
      id: request.id,
      version: PROTOCOL_VERSION,
      ok: true,
      value,
    };
  } catch (error) {
    response = {
      id: request.id,
      version: PROTOCOL_VERSION,
      ok: false,
      error: serializeUnknownError(normalizeStorageError(error)),
    };
  }
  active.delete(request.id);
  self.postMessage(response);
  if (request.type === "dispose") self.close();
}

async function handle(request: StorageRequest): Promise<unknown> {
  if (request.type !== "dispose") workspacePublications.assertActive();
  switch (request.type) {
    case "initial-start-state":
      if(initialStart===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","Prepared initialization requires durable snapshot storage");
      return initialStart.state();
    case "initial-start-begin":
      if(initialStart===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","Prepared initialization requires durable snapshot storage");
      return initialStart.begin(request.source);
    case "initial-start-retire":
      await initialStart?.retire();return undefined;
    case "inspect-start-image":
      if (storage.kind !== "uninitialized") throw new VMError("INVALID_ARGUMENT", "Startup image inspection requires a fresh storage worker");
      return inspectStartImage(request, active.get(request.id)?.controller.signal ?? AbortSignal.abort());
    case "erase-local-data":
      if (storage.kind !== "uninitialized" || releaseLocalDataLock !== undefined) {
        throw new VMError("INVALID_ARGUMENT", "Local data erasure requires a fresh storage worker");
      }
      await eraseLocalDataStorage(active.get(request.id)?.controller.signal ?? AbortSignal.abort());
      return undefined;
    case "initialize":
      await initialize(request);
      return undefined;
    case "workspace-persistence": {
      const current = requireStorage();
      if (current.kind === "indexeddb-fallback") await Promise.all([current.database, current.overlayDatabase]);
      return current.kind === "opfs" ? "opfs" : "indexeddb";
    }
    case "abort-userspace-files":
      try {await requireSnapshotStore().abortNativeFiles(request.sourceId);}
      finally {rootfsStore?.retireWorkspaceBase();}
      return undefined;
    case "select-userspace-files":
      return requireSnapshotStore().selectNativeFiles(request,active.get(request.id)?.controller.signal??AbortSignal.abort());
    case "current-system-image": {
      const current=requireStorage();if(current.kind!=="opfs"||managedDisk===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","No managed system disk is active");
      return currentSystemImage(await current.oxidevm.getDirectoryHandle("managed-images"),managedDisk.image,systemImageTrust,systemRequestedImage);
    }
    case "prepare-current-system-image": {
      const current = requireStorage();
      if (current.kind !== "opfs" || managedDisk === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "No managed system image is active");
      await prepareCurrentManagedImage(await current.oxidevm.getDirectoryHandle("managed-images"), current.workspaceId, managedDisk.image,
        systemImageTrust === undefined ? undefined : { keyId: systemImageTrust.keyId, publicKey: new Uint8Array(systemImageTrust.publicKey) }, active.get(request.id)?.controller.signal, managedBases);
      return undefined;
    }
    case "current-userspace-rootfs": {
      if(rootfsStore===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","No verified native image is active");
      preparedUserspace=rootfsStore.currentRootfs();return preparedUserspace;
    }
    case "current-userspace-image": {
      if(rootfsStore===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","No verified native image is active");
      const identity=rootfsStore.currentIdentity();
      if(preparedUserspace!==undefined)preparedUserspace={...preparedUserspace,identity};
      return identity;
    }
    case "prepare-managed-image": {
      const current = requireStorage();
      if (current.kind !== "opfs" || diskBridge === undefined) {
        throw new VMError(
          "FEATURE_NOT_AVAILABLE",
          "managed disks require OPFS, cross-origin isolation, and SharedArrayBuffer",
        );
      }
      const prepared = await prepareManagedDisk(
        { oxidevm: current.oxidevm, workspace: current.root, workspaceId: current.workspaceId, bases: managedBases },
        request.manifestUrl,
        request.trustedKeyId === undefined || request.trustedPublicKey === undefined
          ? undefined
          : {
              keyId: request.trustedKeyId,
              publicKey: new Uint8Array(request.trustedPublicKey),
            },
        request.boot ?? "live",
        // The control worker quiesced the disk; the new generation may be the one it holds open.
        () => {
          const live = managedDisk;
          managedDisk = undefined;
          live?.close();
        },
        { ...(request.manifestSHA256 === undefined ? {} : { manifestSHA256: request.manifestSHA256 }),
          signal: active.get(request.id)?.controller.signal ?? AbortSignal.abort(),
          ...(request.cachedOnly === undefined ? {} : { cachedOnly: request.cachedOnly }),
          ...(request.imagePreparation === undefined ? {} : { imagePreparation: request.imagePreparation }) },
      );
      managedDisk = prepared.disk;
      systemImageTrust=request.trustedKeyId===undefined||request.trustedPublicKey===undefined?undefined:{keyId:request.trustedKeyId,publicKey:new Uint8Array(request.trustedPublicKey)};
      systemRequestedImage=prepared.image.update??{id:prepared.image.id,version:prepared.image.version};
      preparedImage = {
        id: prepared.image.id,
        workspaceBaseSha256: prepared.image.workspaceBaseSha256,
        ref: prepared.disk.image,
        snapshots: prepared.snapshots,
        ...(prepared.image.identity === undefined ? {} : {manifestSHA256:prepared.image.identity.manifestSHA256}),
      };
      // A reset erases /workspace too: the store goes back to the fresh image's own, so neither the
      // cold boot nor Userspace brings the erased files back.
      if (request.boot === "fresh-image" && prepared.image.workspaceBaseSha256 !== undefined) {
        await workspaceStore?.reset(prepared.image.workspaceBaseSha256);
      }
      return prepared.image;
    }
    case "snapshot-list":
      return requireSnapshotStore().list();
    case "snapshot-rename":
      return requireSnapshotStore().rename(request.snapshot, request.label);
    case "snapshot-delete":
      await requireSnapshotStore().delete(request.snapshot);
      // What the deletion freed goes to the guest's disk reserve first.
      await managedDisk?.holdReserve();
      await workspaceReserve?.hold();
      return undefined;
    case "snapshot-usage":
      return requireSnapshotStore().usage();
    case "snapshot-resume-candidates":
      return requireSnapshotStore().resumeCandidates();
    case "snapshot-export":
      try {
        const target = request.destination === undefined
          ? { kind: "staged" as const, directory: await stagedExports() }
          : { kind: "handle" as const, handle: request.destination };
        return await exportBackup(requireSnapshotStore(), request.snapshot, target, archiveRun(request.id, request.progress));
      } finally {
        request.progress.close();
      }
    case "snapshot-import":
      try {
        return await importBackup(requireSnapshotStore(), request.file, archiveRun(request.id, request.progress));
      } finally {
        request.progress.close();
      }
    case "snapshot-inspect":
      return inspectBackup(requireSnapshotStore(), request.file, Date.now(),active.get(request.id)?.controller.signal);
    case "snapshot-install-shipped":
      try {
        const image=preparedUserspace!==undefined
          ? {mode:"userspace" as const,id:preparedUserspace.id,version:preparedUserspace.version,identity:preparedUserspace.rootTreeSha256,
              ...(preparedUserspace.identity===undefined?{}:{manifestSHA256:preparedUserspace.identity.manifestSHA256}),
              snapshots:(preparedUserspace.snapshots??[]).map(entry=>({...entry,manifest:{...entry.manifest,url:new URL(entry.manifest.url)}}))}
          : preparedImage===undefined?undefined:{...preparedImage.ref,mode:"system" as const,snapshots:preparedImage.snapshots,...(preparedImage.manifestSHA256===undefined?{}:{manifestSHA256:preparedImage.manifestSHA256})};
        if(image===undefined)throw shippedError("unavailable","No verified image is prepared");
        const resolved=resolveShippedSource(request.source??{kind:"listed",name:request.name},image,{keyId:request.trustedKeyId,publicKey:new Uint8Array(request.trustedPublicKey)});
        const run = archiveRun(request.id, request.progress), images = rootfsStore;
        return await installShipped(
          requireSnapshotStore(),
          resolved.listing,
          resolved.expectation,
          { ...run, fetchBytes: fetchBounded, backoff: (attempt) => new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 2))),
            ...(images===undefined?{}:{readImageFile:(sha256:string,bytes:number)=>images.readImageFile(sha256,bytes)}) },
          resolved.identity,
        );
      } finally {
        request.progress.close();
      }
    case "prepare-userspace-rootfs": {
      const store = rootfsStore;
      if (store === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "managed Userspace rootfs requires OPFS and a network worker");
      const selection=request.cachedOnly===true||storage.kind!=="opfs"||request.boot==="fresh-image"||request.boot==="update-image"?null:await inspectStoredNativeStart(await navigator.storage.getDirectory(),{
        workspaceId:storage.workspaceId,mode:"userspace",resume:request.boot==="pre-resume"?"pre-resume":"latest",
        manifestUrl:request.manifestUrl,manifestSHA256:request.manifestSHA256??"0".repeat(64),trustedKeyId:request.trustedKeyId,trustedPublicKey:request.trustedPublicKey,
      },active.get(request.id)?.controller.signal??AbortSignal.abort());
      if(selection!==null)await store.inspectRequestedImage(request.manifestUrl,{keyId:request.trustedKeyId,publicKey:new Uint8Array(request.trustedPublicKey)},request.manifestSHA256,active.get(request.id)?.controller.signal,true);
      const installed = selection === null && request.imagePreparation === "before-ready" && request.boot !== "fresh-image" && request.boot !== "update-image"
        ? await store.inspectCachedImage(request.manifestUrl, { keyId: request.trustedKeyId, publicKey: new Uint8Array(request.trustedPublicKey) }, request.manifestSHA256) : undefined;
      const activeRootfs = await store.prepare(selection?.manifestUrl??request.manifestUrl, {
        keyId: request.trustedKeyId,
        publicKey: new Uint8Array(request.trustedPublicKey),
      }, selection?.manifestSHA256??installed?.manifestSHA256??request.manifestSHA256, selection!==null||installed!==undefined||request.cachedOnly===true,active.get(request.id)?.controller.signal,request.imagePreparation);
      const prepared=activeRootfs;
      preparedUserspace = prepared;
      return prepared;
    }
    case "check-system-update": {
      if (managedDisk === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "No managed image is active");
      const signal = active.get(request.id)?.controller.signal;
      return checkManagedImageUpdate(request.manifestUrl, managedDisk.image, {
        ...(signal === undefined ? {} : { signal }), ...(request.manifestSHA256 === undefined ? {} : { manifestSHA256: request.manifestSHA256 }),
        ...(request.trustedKeyId === undefined || request.trustedPublicKey === undefined ? {} : { trusted: { keyId: request.trustedKeyId, publicKey: request.trustedPublicKey } }) });
    }
    case "check-userspace-update": {
      const store=rootfsStore;
      if(store===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","No managed rootfs is active");
      return store.checkForUpdate(request.manifestUrl,{keyId:request.trustedKeyId,publicKey:request.trustedPublicKey.slice()},request.manifestSHA256,active.get(request.id)?.controller.signal);
    }
    case "read-rootfs-file": {
      const store = rootfsStore;
      if (store === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "no managed Userspace rootfs is active");
      return store.read(request.path);
    }
    case "read-file":
      return readFile(request.path);
    case "write-file":
      await writeFile(request.path, request.data);
      return undefined;
    case "list":
      return list(request.path);
    case "remove":
      await remove(request.path, request.recursive);
      return undefined;
    case "commit-workspace-streams":
      return workspacePublications.commit(workspaceStore, request.publication,
        active.get(request.id)?.controller.signal ?? AbortSignal.abort());
    case "commit-workspace-snapshot": {
      const store = workspaceStore;
      if (store === undefined) throw new VMError("STORAGE_ERROR", "workspace overlay store is unavailable");
      return store.commit(request.workspaceBaseSha256, new Uint8Array(request.data), undefined, active.get(request.id)?.controller.signal);
    }
    case "commit-workspace-delta": {
      const store = workspaceStore;
      if (store === undefined) throw new VMError("STORAGE_ERROR", "workspace overlay store is unavailable");
      return store.commitDelta(request.workspaceBaseSha256, new Uint8Array(request.data), active.get(request.id)?.controller.signal);
    }
    case "read-workspace-snapshot": {
      const store = workspaceStore;
      if (store === undefined) throw new VMError("STORAGE_ERROR", "workspace overlay store is unavailable");
      return store.read(request.workspaceBaseSha256, active.get(request.id)?.controller.signal);
    }
    case "read-workspace-delta": {
      const store = workspaceStore;
      if (store === undefined) throw new VMError("STORAGE_ERROR", "workspace overlay store is unavailable");
      return store.readDelta(request.workspaceBaseSha256, active.get(request.id)?.controller.signal);
    }
    case "dispose":
      await closeSnapshotChannel();
      await closeUserspaceStorageChannel();
      if (storage.kind === "indexeddb-fallback") {
        (await storage.database).close();
        (await storage.overlayDatabase).close();
      }
      rootfsStore?.close();
      rootfsStore = undefined;
      workspaceStore = undefined;
      try {
        // OPFS forbids removing a directory while its disk SyncAccessHandle is
        // open. Retire the bridge after draining its channels, before deletion.
        closeDiskBridge();
        if (ephemeralWorkspaceId !== undefined) await removeEphemeralWorkspace(ephemeralWorkspaceId, storage);
      } finally {
        ephemeralWorkspaceId = undefined;
        releaseWorkspaceLock?.();
        releaseWorkspaceLock = undefined;
      }
      storage = { kind: "uninitialized" };
      await releaseLocalDataLock?.();
      releaseLocalDataLock = undefined;
      return undefined;
  }
}

async function initialize(request: Extract<StorageRequest, { readonly type: "initialize" }>): Promise<void> {
  const {
    workspaceId,
    snapshotPort: nextSnapshotPort,
    rootfsNetworkPort,
    userspaceStoragePort: nextUserspaceStoragePort,
    diskBridge: bridgeBuffer,
    diskPort: bridgePort,
  } = request;
  validateWorkspaceId(workspaceId);
  releaseLocalDataLock ??= await acquireLocalDataLock("shared");
  await closeSnapshotChannel();
  await closeUserspaceStorageChannel();
  releaseWorkspaceLock?.();
  releaseWorkspaceLock = undefined;
  await acquireWorkspaceLock(workspaceId);
  ephemeralWorkspaceId = request.ephemeral === true ? workspaceId : undefined;
  closeDiskBridge();
  rootfsStore?.close();
  rootfsStore = undefined;
  preparedUserspace = undefined;
  workspaceStore = undefined;
  workspaceSelections = undefined;
  initialStart=undefined;
  storage = { kind: "uninitialized" };
  try {
    const origin = await navigator.storage.getDirectory();
    const oxidevm = await origin.getDirectoryHandle("oxidevm", { create: true });
    const workspaces = await oxidevm.getDirectoryHandle("workspaces", {
      create: true,
    });
    const overlays = await oxidevm.getDirectoryHandle("workspace-overlays", {
      create: true,
    });
    storage = {
      kind: "opfs",
      workspaceId,
      root: await workspaces.getDirectoryHandle(workspaceId, { create: true }),
      oxidevm,
      overlayRoot: await overlays.getDirectoryHandle(workspaceId, { create: true }),
    };
  } catch (error) {
    if (error instanceof TypeError) {
      bridgePort?.close();
      const overlayDatabase = openWorkspaceOverlayDatabase(workspaceId);
      storage = {
        kind: "indexeddb-fallback",
        database: openWorkspaceDatabase(workspaceId),
        overlayDatabase,
      };
      workspaceSelections = new WorkspaceSelections(indexedDbWorkspaceStoreBackend(overlayDatabase));
      const backend = workspaceSelections.backend;
      workspaceStore = new WorkspaceStore(backend);
      userspaceRootStorage = new UserspaceRootStorage(backend);
      if (rootfsNetworkPort !== undefined) {
        rootfsStore = RootfsStore.indexedDb(new RootfsNetworkClient(rootfsNetworkPort));
      }
      openSnapshotChannel(nextSnapshotPort);
      if (nextUserspaceStoragePort !== undefined) openUserspaceStorageChannel(nextUserspaceStoragePort);
      return;
    }
    throw error;
  }
  const rawWorkspace=opfsWorkspaceStoreBackend(storage.overlayRoot);
  initialStart=await InitialStart.open(storage.root,rawWorkspace);
  workspaceSelections = new WorkspaceSelections(rawWorkspace);
  if (nextUserspaceStoragePort !== undefined) workspaceReserve = await SpaceReserve.open(storage.overlayRoot, DISK_RESERVE_BYTES);
  const backend = reserveWorkspaceWrites(workspaceSelections.backend, workspaceReserve);
  workspaceStore = new WorkspaceStore(backend);
  userspaceRootStorage = new UserspaceRootStorage(backend);
  if (rootfsNetworkPort !== undefined) {
    rootfsStore = RootfsStore.opfs(storage.oxidevm, new RootfsNetworkClient(rootfsNetworkPort));
  }
  const nativeRoots = rootfsStore;
  snapshotStore = await SnapshotStore.open(storage.root, {
    images: await storage.oxidevm.getDirectoryHandle("managed-images", { create: true }),
    bases: managedBases,
    workspaceId,
    clock: SYSTEM_CLOCK,
    workspace: {
      base: () => preparedImage?.workspaceBaseSha256,
      read: (base) => workspaceStore === undefined ? Promise.resolve(undefined) : workspaceStore.readGeneration(base),
    },
    ...(request.machine === undefined ? {} : { machine: request.machine }),
    image: () => request.machine?.mode === "userspace" ? preparedUserspace : preparedImage,
    quota: () => readBrowserQuota(navigator.storage),
    ...(nextUserspaceStoragePort === undefined || nativeRoots === undefined ? {} : { native: {
      rootfs: nativeRoots, selections: workspaceSelections, cachedImages: availableRoot => nativeRoots.cachedCheckpointIdentities(availableRoot),
    } }),
  });
  scheduleSnapshotMaintenance(snapshotStore);
  // A staged backup lives until the next export or session.
  await clearStagedExports(await stagedExports());
  openSnapshotChannel(nextSnapshotPort);
  if (nextUserspaceStoragePort !== undefined) openUserspaceStorageChannel(nextUserspaceStoragePort);
  if (bridgeBuffer !== undefined && bridgePort !== undefined) {
    diskBridge = new StorageDiskBridge(
      bridgeBuffer,
      bridgePort,
      () => managedDisk,
    );
  }
}

async function removeEphemeralWorkspace(id: string, current: StorageState): Promise<void> {
  if (current.kind === "opfs") {
    for (const directory of ["workspaces", "workspace-overlays"]) {
      const parent = await current.oxidevm.getDirectoryHandle(directory);
      await parent.removeEntry(id, { recursive: true });
    }
  } else if (current.kind === "indexeddb-fallback") {
    for (const name of [`oxidevm-workspace-${id}`, `oxidevm-workspace-overlay-${id}`]) {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(new VMError("STORAGE_ERROR", "ephemeral workspace deletion failed"));
        request.onblocked = () => reject(new VMError("STORAGE_ERROR", "ephemeral workspace deletion is blocked"));
      });
    }
  }
}

async function acquireWorkspaceLock(workspaceId: string): Promise<void> {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const acquired = new Promise<boolean>((resolve, reject) => {
    void navigator.locks.request(
      workspaceLockName(workspaceId),
      { ifAvailable: true, mode: "exclusive" },
      async (lock) => {
        resolve(lock !== null);
        if (lock !== null) await held;
      },
    ).catch(reject);
  });
  if (!await acquired) {
    throw new VMError("STORAGE_ERROR", "workspace is already active in another runtime", {
      reason: "workspace-in-use",
    });
  }
  releaseWorkspaceLock = release;
}

function openUserspaceStorageChannel(port: MessagePort): void {
  userspaceStorage = serveUserspaceStorage(port, handleUserspaceStorage);
}

async function handleUserspaceStorage(request: UserspaceStorageRequest, signal: AbortSignal): Promise<UserspaceStorageValue> {
  if (request.type !== "open-root-overlay" && request.type !== "read-root-overlay"
    && request.type !== "close-root-overlay" && request.type !== "commit-root-overlay" && request.type !== "workspace") workspacePublications.assertActive();
  switch (request.type) {
    case "workspace": {
      if(request.request.type==="inspect-workspace-base"){
        if(rootfsStore===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","Verified workspace base is unavailable");return rootfsStore.workspaceBaseMetadata(request.request.workspaceBaseSha256);
      }
      return workspacePublications.handle(workspaceStore,request.request,signal,(selection,base,signal)=>checkpointWorkspaceRead(rootfsStore,workspaceSelections,selection.kind==="retained"?{...selection,id:requireSnapshotStore().retainedNativeReadId(selection.id)}:selection,base,signal));
    }
    case "open-root-overlay":
    case "read-root-overlay":
    case "close-root-overlay":
    case "commit-root-overlay":
      if (userspaceRootStorage === undefined) {
        if (request.type === "commit-root-overlay") await retireWorkspaceTransfer(request.input);
        throw new VMError("STORAGE_ERROR", "Persistent Userspace root storage is unavailable");
      }
      return userspaceRootStorage.handle(request, signal);
    case "read-rootfs": {
      const store = rootfsStore;
      if (store === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "no managed Userspace rootfs is active");
      return store.read(request.path);
    }
    case "read-workspace":
      return new Uint8Array(await readFile(request.path));
    case "write-workspace":
      await writeFile(request.path, request.data);
      return undefined;
    case "read-acceleration-knowledge": {
      const backend = knowledgeBackend();
      return backend === undefined ? undefined : await readAccelerationKnowledge(backend, request.namespace);
    }
    case "write-acceleration-knowledge": {
      const backend = knowledgeBackend();
      if (backend === undefined) throw new VMError("STORAGE_ERROR", "Acceleration knowledge needs durable storage");
      await writeAccelerationKnowledge(backend, request.namespace, request.data);
      return undefined;
    }
    case "read-workspace-snapshot": {
      const store = workspaceStore;
      if (store === undefined) throw new VMError("STORAGE_ERROR", "workspace overlay store is unavailable");
      return store.read(request.workspaceBaseSha256, signal);
    }
    case "read-workspace-delta": {
      const store = workspaceStore;
      if (store === undefined) throw new VMError("STORAGE_ERROR", "workspace overlay store is unavailable");
      return store.readDelta(request.workspaceBaseSha256, signal);
    }
    case "commit-workspace-snapshot": {
      const store = workspaceStore;
      const roots = rootfsStore;
      if (store === undefined) throw new VMError("STORAGE_ERROR", "workspace overlay store is unavailable");
      if (roots === undefined) throw new VMError("STORAGE_ERROR", "rootfs store is unavailable");
      const delta = await roots.buildWorkspaceDelta(request.data);
      return store.commit(request.workspaceBaseSha256, request.data, delta, signal);
    }
  }
}

let knowledgeDatabase: Promise<IDBDatabase> | undefined;
/** OPFS `/oxidevm` or the IndexedDB fallback; both are removed by local-data cleanup. */
function knowledgeBackend(): AccelerationKnowledgeBackend | undefined {
  if (storage.kind === "opfs") return { kind: "opfs", root: storage.oxidevm };
  if (storage.kind === "indexeddb-fallback") return { kind: "indexeddb", database: knowledgeDatabase ??= openAccelerationKnowledgeDatabase() };
  return undefined;
}

async function closeUserspaceStorageChannel(): Promise<void> {
  await userspaceStorage?.close();
  userspaceStorage = undefined;
  await workspacePublications.closeRead();
  await userspaceRootStorage?.close();
  userspaceRootStorage = undefined;
  workspaceReserve?.close();
  workspaceReserve = undefined;
}

function openSnapshotChannel(port: MessagePort): void {
  snapshotChannel = serveSnapshotStorage(port, (request, signal, progress) => {
    // Prepared immutable streams own their leases; they must not hold the metadata queue.
    if (request.type === "stream-native-restore" || request.type === "prepare-native-image") return handleSnapshot(request, signal, progress);
    return enqueue(() => {
    if (signal.aborted && request.type !== "commit-workspace-streams" && request.type !== "stage-workspace-streams" && request.type !== "stage-native-cold-workspace" && request.type !== "stage-native-workspace" && request.type !== "open-workspace-read") throw new VMError("ABORTED", "snapshot storage request canceled");
    return handleSnapshot(request, signal, progress);
    });
  }, () => workspacePublications.close());
}

async function handleSnapshot(request: SnapshotStorageRequest, signal: AbortSignal, progress: (progress: SnapshotStorageProgress) => void): Promise<unknown> {
  if((request.type==="prepare-restore"||request.type==="prepare-native-restore")&&request.initialStart!==undefined) {
    if(initialStart===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","Initial publication requires durable snapshot storage");
    initialStart.requirePending(request.initialStart);
  }
  if (request.type === "read-build-policy" || request.type === "commit-build-policy") {
    workspacePublications.assertActive();
    if (workspaceStore === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Build approval storage is unavailable");
    return request.type === "read-build-policy" ? workspaceStore.readBuildPolicy(request.workspaceBaseSha256, signal)
      : workspaceStore.commitBuildPolicy(request.workspaceBaseSha256, request.decisions, signal);
  }
  if (request.type === "stage-workspace-streams") return workspacePublications.stage(workspaceStore, request.publication, signal);
  if (request.type === "finish-workspace-stage") return workspacePublications.finishStage(request.identity, request.decision);
  if (request.type === "commit-workspace-streams" || request.type === "open-workspace-read" || request.type === "read-workspace-frame"
    || request.type === "retire-workspace-source" || request.type === "retire-workspace-read") return workspacePublications.handle(workspaceStore,request,signal,(selection,base,signal)=>checkpointWorkspaceRead(rootfsStore,workspaceSelections,selection.kind==="retained"?{...selection,id:requireSnapshotStore().retainedNativeReadId(selection.id)}:selection,base,signal));
  if (request.type === "cancel-workspace-operation") throw new VMError("PROTOCOL_ERROR", "workspace cancellation must bypass the storage queue");
  if (request.type !== "abort") workspacePublications.assertActive();
  const store = requireSnapshotStore();
  switch (request.type) {
    case "inspect-workspace-base":
      if(rootfsStore===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","Verified workspace base is unavailable");return rootfsStore.workspaceBaseMetadata(request.workspaceBaseSha256);
    case "native-payload-round-open":
    case "native-payload-round-put":
    case "native-payload-round-seal":
    case "native-live-index-put":
    case "native-live-index-seal":
    case "native-payload-consolidate":
    case "open-native-capture":
    case "seal-native-capture":
    case "put-native-chunk":
    case "commit-native-capture":
    case "stage-native-cold-workspace":
    case "publish-native-cold":
    case "complete-native-cold":
    case "stage-native-workspace":
    case "prepare-native-restore":
    case "stream-native-restore":
    case "prepare-native-image":
    case "reclaim-native-cache":
    case "read-native-restore":
    case "publish-native-restore":
    case "complete-native-restore":
    case "native-session":
    case "retire-native-recovery": {
      const result = await store.handleNative(request, signal, progress);
      if(request.type==="complete-native-cold")rootfsStore?.retireWorkspaceBase();
      if(request.type==="complete-native-restore"&&rootfsStore!==undefined)preparedUserspace=rootfsStore.currentRootfs();
      if (request.type === "complete-native-cold" || request.type === "commit-native-capture" || request.type === "complete-native-restore" || request.type === "retire-native-recovery") scheduleSnapshotMaintenance(store);
      return result;
    }
    case "remember-boot":
      await store.rememberBoot(request, managedDisk);
      return undefined;
    case "open-capture":
      await store.openCapture(request, managedDisk);
      return undefined;
    case "seal-capture":
      await store.sealCapture(request, managedDisk);
      return undefined;
    case "put-capture-chunk":
      await store.putCaptureChunk(request.area, request.index, request.data);
      return undefined;
    case "commit-capture": {
      const committed = await store.commitCapture();
      scheduleSnapshotMaintenance(store);
      return committed;
    }
    case "prepare-restore": {
      const prepared=await store.prepareRestore(request.snapshot,diskBridge!==undefined,managedDisk,request.initialStart);
      const ref=store.preparedManagedImage();
      if(ref===undefined||storage.kind!=="opfs")return prepared;
      const systemImage=await currentSystemImage(await storage.oxidevm.getDirectoryHandle("managed-images"),ref,systemImageTrust,systemRequestedImage);
      return {...prepared,systemImage};
    }
    case "plan-workspace":
      return store.planWorkspace(request.snapshot);
    case "stream-restore":
      return serveRestoreStream(request.port, store.restoreChunks(), signal);
    case "commit-restore-disk": {
      const next = await store.commitRestoreDisk();
      if (next !== undefined) {
        managedDisk?.close();
        managedDisk = next;
      }
      return undefined;
    }
    case "complete-restore":
      store.completeRestore();
      return undefined;
    case "abort":
      try {await store.abort();}
      finally {rootfsStore?.retireWorkspaceBase();}
      return undefined;
    case "collect":
      await store.maintain();
      // What the collection freed goes to the guest's disk reserve first.
      await managedDisk?.holdReserve();
      await workspaceReserve?.hold();
      return undefined;
  }
}

/**
 * Thins and collects restore points after the request in progress, serialized with every other
 * storage operation and outside the capture's VM pause. A failed pass leaves only reclaimable
 * objects, which the store's usage reports and the next pass retries.
 */
/** How backup job `id` runs: its cancel, the storage queue, the origin's space and its progress port. */
function archiveRun(id: number, progress: MessagePort): ArchiveRun {
  return {
    enqueue,
    signal: active.get(id)?.controller.signal ?? AbortSignal.abort(),
    now: () => Date.now(),
    progress: (completedBytes, totalBytes) => {
      progress.postMessage({ version: PROTOCOL_VERSION, completedBytes, totalBytes });
    },
  };
}

/** Where a backup export without a picked file is staged for download: one file at a time. */
async function stagedExports(): Promise<FileSystemDirectoryHandle> {
  if (storage.kind !== "opfs") throw new VMError("FEATURE_NOT_AVAILABLE", "backups require OPFS");
  return storage.root.getDirectoryHandle("exports", { create: true });
}

function requireSnapshotStore(): SnapshotStore {
  if (snapshotStore === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "snapshots require OPFS");
  return snapshotStore;
}

function scheduleSnapshotMaintenance(store: SnapshotStore): void {
  queue = queue
    .then(async () => {
      if (snapshotStore !== store) return;
      await store.maintain();
      await managedDisk?.holdReserve();
      await workspaceReserve?.hold();
    })
    .catch(() => undefined);
}

async function closeSnapshotChannel(): Promise<void> {
  await snapshotChannel?.close();
  await workspacePublications.close();
  snapshotChannel = undefined;
  await snapshotStore?.abort();
  snapshotStore = undefined;
}

function closeDiskBridge(): void {
  let failure: unknown;
  try {
    managedDisk?.close();
  } catch (error) {
    failure = error;
  } finally {
    managedDisk = undefined;
    diskBridge?.close();
    diskBridge = undefined;
  }
  if (failure instanceof Error) throw failure;
  if (failure !== undefined) throw normalizeStorageError(failure);
}

async function readFile(path: string): Promise<Uint8Array> {
  const segments = normalizeWorkspacePath(path);
  const current = requireStorage();
  if (current.kind === "indexeddb-fallback") {
    const data = await indexedDbRead(await current.database, key(segments));
    if (data === undefined) {
      throw new VMError("STORAGE_NOT_FOUND", `file does not exist: ${path}`);
    }
    return data;
  }

  const { directory, name } = await parentDirectory(
    current.root,
    segments,
    false,
  );
  const file = await (await directory.getFileHandle(name)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function writeFile(path: string, data: Uint8Array): Promise<void> {
  const segments = normalizeWorkspacePath(path);
  if (segments.length === 0) {
    throw new VMError("INVALID_ARGUMENT", "cannot write the workspace root");
  }
  const current = requireStorage();
  if (current.kind === "indexeddb-fallback") {
    await indexedDbWrite(await current.database, key(segments), new Uint8Array(data));
    return;
  }

  const { directory, name } = await parentDirectory(
    current.root,
    segments,
    true,
  );
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  try {
    await writable.write(copy);
    await writable.close();
  } catch (error) {
    await writable.abort(error);
    throw error;
  }
}

async function list(path: string): Promise<WorkspaceEntry[]> {
  const segments = normalizeWorkspacePath(path);
  const current = requireStorage();
  if (current.kind === "indexeddb-fallback") {
    const prefix = key(segments);
    const names = new Map<string, WorkspaceEntry>();
    for (const stored of await indexedDbKeys(await current.database)) {
      if (prefix !== "" && !stored.startsWith(`${prefix}/`)) continue;
      const remainder = prefix === "" ? stored : stored.slice(prefix.length + 1);
      const [name, ...rest] = remainder.split("/");
      if (name === undefined || name === "") continue;
      names.set(name, {
        name,
        path: `/${[...segments, name].join("/")}`,
        kind: rest.length === 0 ? "file" : "directory",
      });
    }
    return [...names.values()].sort(compareEntries);
  }

  const directory = await descend(current.root, segments, false);
  const entries: WorkspaceEntry[] = [];
  for await (const [name, handle] of directory.entries()) {
    entries.push({
      name,
      path: `/${[...segments, name].join("/")}`,
      kind: handle.kind,
    });
  }
  return entries.sort(compareEntries);
}

async function remove(path: string, recursive: boolean): Promise<void> {
  const segments = normalizeWorkspacePath(path);
  if (segments.length === 0) {
    throw new VMError("INVALID_ARGUMENT", "cannot remove the workspace root");
  }
  const current = requireStorage();
  if (current.kind === "indexeddb-fallback") {
    const target = key(segments);
    const database = await current.database;
    for (const stored of await indexedDbKeys(database)) {
      if (stored === target || (recursive && stored.startsWith(`${target}/`))) {
        await indexedDbRemove(database, stored);
      }
    }
    return;
  }
  const { directory, name } = await parentDirectory(
    current.root,
    segments,
    false,
  );
  await directory.removeEntry(name, { recursive });
}


function requireStorage(): Exclude<
  StorageState,
  { readonly kind: "uninitialized" }
> {
  if (storage.kind === "uninitialized") {
    throw new VMError("STORAGE_ERROR", "workspace storage is uninitialized");
  }
  return storage;
}

function abortIfCanceled(requestId: number): void {
  if (active.get(requestId)?.controller.signal.aborted === true) {
    throw new VMError("ABORTED", "operation was aborted");
  }
}

function key(segments: string[]): string {
  return segments.join("/");
}

function openWorkspaceDatabase(workspaceId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`oxidevm-workspace-${workspaceId}`, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new VMError("STORAGE_ERROR", "workspace IndexedDB open failed"));
  });
}

function openWorkspaceOverlayDatabase(workspaceId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`oxidevm-workspace-overlay-${workspaceId}`, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new VMError("STORAGE_ERROR", "workspace overlay IndexedDB open failed"));
  });
}


function compareEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
  return (
    left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)
  );
}

function postFailure(id: number, error: unknown): void {
  const response: WorkerResponse = {
    id,
    version: PROTOCOL_VERSION,
    ok: false,
    error: serializeUnknownError(error),
  };
  self.postMessage(response);
}
