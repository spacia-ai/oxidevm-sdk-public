import { RestoreStreamReader } from "./snapshot-restore-stream.js";
import type {ShippedInstallIdentity} from "../protocol.js";
import { stageCandidateWorkspace } from "./userspace-snapshot-workspace.js";
import { boolean, exactKeys, record } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeBytes } from "../protocol/decoders.js";
import { decodePreparedUserspaceRootfs, type PreparedUserspaceRootfs } from "../protocol/storage.js";
import { decodeSnapshotRef, validateAppData, type RestoredSnapshot, type SnapshotEventRecord, type SnapshotKind, type SnapshotRef } from "../protocol/snapshots.js";
import type { UserspaceCapture, UserspaceRestore, CheckpointInput, NativeWorkspaceReconciled, CandidateWorkspaceExport } from "./userspace-checkpoint.js";
import { decodeNativeAttachments, type NativeAttachments } from "./userspace-attachments.js";
import { decodeSnapshotManifest, USERSPACE_SNAPSHOT_SCHEMA, type UserspaceSnapshotManifest, type SnapshotStream } from "./snapshot-manifest.js";
import type { SnapshotStorageClient } from "./snapshot-channel.js";
import type { RootfsCheckpointDestination } from "./rootfs-store.js";
import { transferNativeCheckpoint, type NativeCheckpointTransferRuntime } from "./userspace-snapshot-transfer.js";

type Capture = Pick<UserspaceCapture, "finish" | "abort">;
type Restore = Pick<UserspaceRestore, "read" | "complete" | "abort" | "recoveryRequired" | "validateAttachment" | "prepare" | "beginReconcile" | "exportWorkspace" | "discardStartup">;
interface SaveRequest { readonly kind: SnapshotKind; readonly label?: string; readonly signal?: AbortSignal }
interface HeldSave { readonly snapshot: SnapshotRef; readonly capture: Capture; readonly pauseStartedAt: number; readonly appGeneration: number }
interface Prepared { readonly newerFiles:{readonly workspace:boolean;readonly root:boolean}; readonly rootfs: PreparedUserspaceRootfs; readonly manifest: UserspaceSnapshotManifest; readonly attachments: NativeAttachments; readonly appData: Uint8Array | null }

/** Native execution owns this cut; control owns request ordering and automatic-save scheduling. */
export interface NativeSnapshotRuntime extends NativeCheckpointTransferRuntime {
  readonly memoryBytes: number;
  readonly rootPersistence: "ephemeral" | "persistent";
  readonly workspaceBaseSha256: string;
  readonly image: string;
  readonly destination: RootfsCheckpointDestination;
  readonly baseline: bigint;
  dirty(): boolean;
  /** Refuses a capture before storage preparation can outlast non-capturable work. */
  assertCheckpointAdmission(): void;
  /** Stops guest/input admission, drains finite mutations/durability, then holds host delivery. */
  freeze(signal?: AbortSignal): Promise<void>;
  resume(): void;
  attachments(): Uint8Array;
  beginRestore(image: string): Restore;
  beginRecovery(): Restore;
  discardStartup(candidate?:Restore):Promise<void>;
  reconcile(candidate: Restore, selection: {readonly snapshotId:string;readonly retainedId:string;readonly workspaceBaseSha256:string;readonly rootfs:PreparedUserspaceRootfs}, signal?:AbortSignal):Promise<NativeWorkspaceReconciled>;
  /** Allocates and validates replacement handles without changing the currently visible maps. */
  prepareAttachments(state: NativeAttachments, recovering: boolean, candidate: Restore,
    image: { readonly rootTreeSha256: string; readonly workspaceBaseSha256: string }): { readonly attachments: NativeAttachments; publish(): void };
}

/** The storage commit and native publication form one transaction. A private recovery point
 * keeps the old session recoverable after native admission releases its heap. */
export class UserspaceSnapshotSession {
  readonly #runtime: NativeSnapshotRuntime;
  readonly #storage: Pick<SnapshotStorageClient, "request">;
  readonly #notify: (event: SnapshotEventRecord) => void;
  #appData: Uint8Array | undefined;
  #last: SnapshotRef | undefined;
  #baseline: { readonly token: bigint; readonly snapshot: SnapshotRef } | undefined;
  #busy: Promise<unknown> = Promise.resolve();
  #lost = false;
  #appGeneration = 0;
  #savedAppGeneration = 0;

  constructor(runtime: NativeSnapshotRuntime, storage: Pick<SnapshotStorageClient, "request">, notify: (event: SnapshotEventRecord) => void = () => {}) {
    this.#runtime = runtime; this.#storage = storage; this.#notify = notify;
  }
  setAppData(data: Uint8Array | null): void { this.#appData = validateAppData(data)?.slice(); this.#appGeneration++; }
  dirty(): boolean { return !this.#lost && (this.#runtime.dirty() || this.#appGeneration !== this.#savedAppGeneration); }

  capture(request: SaveRequest): Promise<{ readonly snapshot: SnapshotRef; readonly pauseMilliseconds: number }> {
    try { this.#runtime.assertCheckpointAdmission(); }
    catch (error) { return Promise.reject(error instanceof Error ? error : new VMError("VM_FAULT", "Native checkpoint admission failed")); }
    return this.#exclusive(async () => {
      let held: HeldSave | undefined;
      try {
        held = await this.#save(request, false, false);
        held.capture.finish(true); this.#last = held.snapshot; this.#savedAppGeneration = held.appGeneration;
        this.#baseline = this.#runtime.baseline === 0n ? undefined : { token: this.#runtime.baseline, snapshot: held.snapshot };
        return { snapshot: held.snapshot, pauseMilliseconds: performance.now() - held.pauseStartedAt };
      } finally {
        if (held !== undefined) this.#abortCapture(held.capture);
        if (!this.#lost) this.#runtime.resume();
      }
    });
  }

  restore(snapshot: SnapshotRef, options: { readonly signal?: AbortSignal; readonly replacedId?: string; readonly startup?:true; readonly initialStart?:ShippedInstallIdentity } = {}): Promise<RestoredSnapshot> {
    decodeSnapshotRef(snapshot);
    return this.#exclusive(() => this.#restore(snapshot, options));
  }

  async #save(request: SaveRequest, recovery: boolean, frozen: boolean, precopy = !recovery): Promise<HeldSave> {
    const signal = request.signal;
    active(signal);
    const snapshot = { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    const baseline = precopy && this.#baseline?.token === this.#runtime.baseline ? this.#baseline : undefined;
    let capture: Capture | undefined;
    let committed = false,reportedAt=0;
    try {
      await this.#storage.request({ type: "open-native-capture", snapshot, kind: request.kind,
        memoryBytes: this.#runtime.memoryBytes, workspaceBaseSha256: this.#runtime.workspaceBaseSha256,
        rootPersistence: this.#runtime.rootPersistence, recovery,
        ...(this.#last === undefined ? {} : { parentId: this.#last.id }),
        ...(baseline === undefined ? {} : { baseline: baseline.snapshot }),
        ...(request.label === undefined ? {} : { label: request.label }) }, [], signal,progress=>{
          const now=performance.now();if(reportedAt===0||now-reportedAt>=100||progress.completedBytes===progress.totalBytes){reportedAt=now;this.#notify({type:"image-preparation-progress",...progress});}
        });
      const transfer = await transferNativeCheckpoint(this.#runtime, this.#storage,
        { ...(precopy ? { kind: "precopy", ...(baseline === undefined ? {} : { baseline: baseline.token }) } : { kind: "frozen", alreadyFrozen: frozen }), ...(signal === undefined ? {} : { signal }) });
      capture = transfer.capture;
      const attachment = this.#runtime.attachments();
      // Validate browser-owned identities before accepting any checkpoint manifest.
      decodeNativeAttachments(attachment);
      const capturedAtUnixMs = Date.now();
      const appGeneration = this.#appGeneration;
      await this.#storage.request({ type: "seal-native-capture", capturedAtUnixMs, graphBytes: transfer.graphBytes, payloadBytes: transfer.payloadBytes, attachment,
        ...(this.#appData === undefined ? {} : { appData: this.#appData }) }, [], signal);
      const saved = decodeSnapshotRef(await this.#storage.request({ type: "commit-native-capture" }, [], signal));
      if (saved.id !== snapshot.id || saved.createdAt !== snapshot.createdAt) throw new VMError("PROTOCOL_ERROR", "Checkpoint commit returned a different identity");
      committed = true;
      return { snapshot, capture, pauseStartedAt: transfer.pauseStartedAt, appGeneration };
    } catch (error) {
      if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) this.#lost = true;
      try { if (capture !== undefined) this.#abortCapture(capture); }
      finally { if (!committed) await this.#storage.request({ type: "abort" }); }
      if (baseline !== undefined && error instanceof VMError && error.detail?.["reason"] === "checkpoint-baseline-unavailable") {
        this.#baseline = undefined;
        return this.#save(request, recovery, frozen, precopy);
      }
      if (!this.#lost && precopy && error instanceof VMError && error.detail?.["discardRounds"] === true) {
        this.#runtime.resume();
        return this.#save(request, recovery, false, false);
      }
      throw error;
    }
  }

  async #restore(snapshot: SnapshotRef, options: { readonly signal?: AbortSignal; readonly replacedId?: string; readonly startup?:true; readonly initialStart?:ShippedInstallIdentity }): Promise<RestoredSnapshot> {
    const signal = options.signal;
    const initialStartup=(options.startup===true||options.replacedId!==undefined)&&this.#last===undefined;
    let held: HeldSave | undefined;
    let recovery: SnapshotRef | undefined;
    let candidate: Restore | undefined;
    let runtimePublished = false;
    let workspaceExport: CandidateWorkspaceExport | undefined;
    try {
      active(signal);
      await this.#runtime.freeze(signal);
      // Automatic startup has only a mounted placeholder. Keep its selected committed
      // source authoritative; a new empty recovery would replace its reachability root.
      if (initialStartup) recovery = snapshot;
      else if (this.#last !== undefined && !this.dirty()) recovery = this.#last;
      else { held = await this.#save({ kind: "safety", ...(signal === undefined ? {} : { signal }) }, true, true); recovery = held.snapshot; }
      const prepared = await this.#prepare(snapshot, recovery, signal, options.replacedId, options.initialStart);
      active(signal);
      // Keep native clock accounting frozen throughout recovery preparation, then transition
      // directly into the restore owner in the same execution-worker turn.
      held?.capture.finish(true); held = undefined;
      this.#baseline = undefined;
      candidate = this.#runtime.beginRestore(prepared.manifest.rootfs.rootTreeSha256);
      await this.#read(candidate, prepared.manifest, signal);
      candidate.prepare(); active(signal);
      const workspace=options.replacedId===undefined||!prepared.newerFiles.workspace?undefined:await this.#runtime.reconcile(candidate,{
        snapshotId:snapshot.id,retainedId:options.replacedId,
        workspaceBaseSha256:selectedImage(prepared).workspaceBaseSha256,rootfs:prepared.rootfs,
      },signal);
      active(signal);
      if (workspace !== undefined) {
        workspaceExport = candidate.exportWorkspace();
        await stageCandidateWorkspace(this.#storage, workspaceExport, selectedImage(prepared).workspaceBaseSha256,
          workspace.workspaceDetails.preserved?.id, signal);
      }
      active(signal);
      const replacement = this.#runtime.prepareAttachments(prepared.attachments, false, candidate, selectedImage(prepared));
      await this.#storage.request({ type: "publish-native-restore" }, [], signal);
      // Cancellation after durable selection waits for native publication to establish outcome.
      workspaceExport?.complete(true); workspaceExport = undefined;
      candidate.complete(); runtimePublished = true; replacement.publish();
      this.#appData = prepared.appData?.slice(); this.#last = snapshot;
      this.#savedAppGeneration = this.#appGeneration;
      // Publication is final. Failure to retire temporary pins cannot turn it into an abort.
      try {
        await this.#storage.request({ type: "complete-native-restore" });
        if (recovery.id !== this.#last.id) await this.#storage.request({ type: "retire-native-recovery", snapshot: recovery });
      } catch { /* Retained recovery pins remain reachable until later collection. */ }
      return result({ ...prepared, attachments: replacement.attachments }, workspace);
    } catch (error) {
      try { workspaceExport?.complete(false); }
      catch { /* The unpublished candidate is discarded by the committed recovery path below. */ }
      const needsRecovery = candidate?.recoveryRequired === true || runtimePublished;
      if (initialStartup && !runtimePublished) {
        try {
          await this.#storage.request({type:"abort"});
          await this.#runtime.discardStartup(candidate);
        } catch {
          this.#lost=true;
          throw new VMError("STORAGE_ERROR","Startup candidate could not be discarded safely",{cleanupFailed:true});
        }
      } else if (!needsRecovery) {
        candidate?.abort();
        await this.#storage.request({ type: "abort" });
      } else if (recovery !== undefined) {
        try { await this.#recover(recovery, !runtimePublished); }
        catch (failure) {
          this.#lost = true;
          throw new VMError("STORAGE_ERROR", "Restore failed and its committed recovery point could not be reopened", {
            reason: "checkpoint-recovery-failed", recovery: recovery.id,
            cause: failure instanceof VMError ? failure.code : "STORAGE_ERROR",
          });
        }
      }
      throw error;
    } finally {
      held?.capture.finish(true);
      if (!this.#lost) this.#runtime.resume();
    }
  }

  async #recover(snapshot: SnapshotRef, retired: boolean): Promise<void> {
    await this.#storage.request({ type: "abort" });
    const prepared = await this.#prepare(snapshot, snapshot);
    const recovery = retired ? this.#runtime.beginRecovery() : this.#runtime.beginRestore(prepared.manifest.rootfs.rootTreeSha256);
    await this.#read(recovery, prepared.manifest);
    recovery.prepare();
    const replacement = this.#runtime.prepareAttachments(prepared.attachments, true, recovery, selectedImage(prepared));
    await this.#storage.request({ type: "publish-native-restore" });
    recovery.complete(); replacement.publish();
    this.#appData = prepared.appData?.slice(); this.#last = snapshot;
    this.#savedAppGeneration = this.#appGeneration;
    try { await this.#storage.request({ type: "complete-native-restore" }); }
    catch { /* A committed recovered runtime remains usable; retain its recovery pins. */ }
  }

  async #prepare(snapshot: SnapshotRef, recovery: SnapshotRef, signal?: AbortSignal, replacedId?: string, initialStart?:ShippedInstallIdentity): Promise<Prepared> {
    const value = record(await this.#storage.request({ type: "prepare-native-restore", snapshot, recovery,
      rootPersistence: this.#runtime.rootPersistence, destination: this.#runtime.destination,
      ...(replacedId === undefined ? {} : { replacedId }),...(initialStart===undefined?{}:{initialStart}) }, [], signal), "native restore preparation");
    exactKeys(value, ["manifest", "rootfs", "newerFiles"], ["attachment", "appData"]);
    const differences=record(value["newerFiles"],"native file differences");exactKeys(differences,["workspace","root"]);
    const newerFiles={workspace:boolean(differences["workspace"],"workspace difference"),root:boolean(differences["root"],"root difference")};
    const manifest = decodeSnapshotManifest(value["manifest"]);
    const rootfs = decodePreparedUserspaceRootfs(value["rootfs"]);
    if (manifest.schema !== USERSPACE_SNAPSHOT_SCHEMA || manifest.id !== snapshot.id || manifest.createdAt !== snapshot.createdAt
      || rootfs.rootTreeSha256 !== manifest.rootfs.rootTreeSha256
      || manifest.compatibility.memoryBytes !== this.#runtime.memoryBytes) {
      throw new VMError("FEATURE_NOT_AVAILABLE", "Native checkpoint does not fit this runtime", { reason: "snapshot-incompatible" });
    }
    if (value["attachment"] === undefined) throw new VMError("PROTOCOL_ERROR", "Native checkpoint has no attachment record");
    return { manifest, rootfs, newerFiles, attachments: decodeNativeAttachments(decodeBytes(value["attachment"])),
      appData: value["appData"] === undefined ? null : validateAppData(value["appData"]) };
  }

  async #read(candidate: Restore, manifest: UserspaceSnapshotManifest, signal?: AbortSignal): Promise<void> {
    const totalBytes = manifest.graph.bytes + manifest.payloads.bytes;
    let completedBytes = 0;
    const progress = (bytes: number) => { completedBytes += bytes; this.#notify({ type: "restore-progress", completedBytes, totalBytes }); };
    progress(0);
    await candidate.read(this.#input("graph", manifest.graph, progress, signal), this.#input("payloads", manifest.payloads, progress, signal), signal);
  }

  #input(area: "graph" | "payloads", stream: SnapshotStream, progress: (bytes: number) => void, signal?: AbortSignal): CheckpointInput {
    const channel = new MessageChannel(), reader = new RestoreStreamReader(channel.port1, 4);
    const done = this.#storage.request({ type: "stream-native-restore", area, port: channel.port2 }, [channel.port2], signal).then(() => undefined);
    void done.catch((error: unknown) => reader.cancel(error instanceof VMError ? error : new VMError("STORAGE_ERROR", "Native restore source failed")));
    let finished = false, retired = false;
    const isRetired = () => retired;
    const cancel = () => reader.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    return { bytes: stream.bytes, frames: (async function* () {
      for (const expected of stream.chunks) {
        const chunk = await reader.next();
        if (isRetired() || chunk?.area !== `native-${area}` || chunk.index !== expected.index || chunk.data.length !== expected.bytes) {
          throw new VMError("PROTOCOL_ERROR", "Native restore source is out of sequence or has a different length");
        }
        yield chunk.data;
        progress(chunk.data.length);
      }
      if (await reader.next() !== undefined) throw new VMError("PROTOCOL_ERROR", "Native restore source has extra chunks");
      finished = true;
    })(), retire: async () => {
      retired = true; if (!finished) reader.cancel();
      try { await done; }
      catch (error) { if (!(error instanceof VMError) || error.code !== "ABORTED" || finished) throw error; }
      finally { signal?.removeEventListener("abort", cancel); channel.port1.close(); }
    } };
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#busy.then(() => { if (this.#lost) throw new VMError("STORAGE_ERROR", "Native runtime requires recovery", { reason: "checkpoint-recovery-failed" }); return operation(); });
    this.#busy = result.catch(() => {}); return result;
  }
  #abortCapture(capture: Capture): void {
    try { capture.abort(); }
    catch (error) { this.#lost = true; throw error; }
  }
}

function selectedImage({ manifest, rootfs }: Prepared) {
  return { rootTreeSha256: manifest.rootfs.rootTreeSha256,
    workspaceBaseSha256: manifest.durable?.workspace?.baseSha256 ?? rootfs.workspaceBaseSha256 ?? manifest.rootfs.rootTreeSha256 };
}

function result(prepared: Prepared, workspace:NativeWorkspaceReconciled|undefined): RestoredSnapshot {
  return { nativeRootfs: prepared.rootfs, newerFilesDropped:prepared.newerFiles.root||(workspace===undefined&&prepared.newerFiles.workspace), ...(workspace===undefined?{}:workspace), appData: prepared.appData, consoleTail: new Uint8Array(),
    processes: prepared.attachments.processes.map(process => ({ mode: "userspace", attachmentKey: process.key, terminalKey: process.identityKey,
      pid: process.pid, command: process.command, terminal: process.terminal !== undefined, tail: process.tail })) };
}
function active(signal?: AbortSignal): void { if (signal?.aborted === true) throw new VMError("ABORTED", "Native checkpoint operation cancelled"); }
