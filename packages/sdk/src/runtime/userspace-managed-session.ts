import type {ShippedInstallIdentity} from "./protocol.js";
import type { UserspaceWorkspaceStart } from "./protocol/workspace-start.js";
import { VMError } from "./errors.js";
import { managedImageUrl } from "./managed-image.js";
import { decodeManagedResume, progressReport, startManaged,prepareInitialStart,referenceIdentity, type ResumedSession } from "./managed-start.js";
import {bootShippedSource} from "./protocol/shipped-source.js";
import { withProgressPort } from "./progress-port.js";
import { decodeSnapshotRef, type ControlOperations, type PreparedUserspaceRootfs, type RestoredSnapshot, type SnapshotInfo, type SnapshotRef, type StorageOperations } from "./protocol.js";
import type { SnapshotEvent, StartProgress } from "./snapshot-types.js";
import type { ManagedImageBootOptions, ManagedImageInfo, ProcessHandle } from "./vm-types.js";
import type { WorkerClient } from "./worker-client.js";
import { decodeImagePreparationReport, type ImageAcquisitionReason } from "./protocol/image-preparation.js";

interface NativeManagedHost {
  readonly control: WorkerClient<ControlOperations>;
  readonly storage: WorkerClient<StorageOperations>;
  readonly rootPersistence: "ephemeral" | "persistent";
  observe(listener: (event: SnapshotEvent) => void, signal: AbortSignal): Promise<void>;
  attachProcess(key: number, terminal: boolean, tail: Uint8Array, signal?: AbortSignal): Promise<ProcessHandle>;
  /** Retires browser preview/watch bindings after native publication. */
  restored(): Promise<void>;
}

/** Shared managed-start decisions, backed by native mounts, checkpoints and process attachments. */
export class UserspaceManagedSession {
  readonly #host: NativeManagedHost;
  #rootfs: PreparedUserspaceRootfs | undefined;
  #configured = false;
  #active = false;
  #requested: {readonly manifestUrl:string;readonly manifestSHA256?:string;readonly trustedKeyId:string;readonly trustedPublicKey:Uint8Array} | undefined;
  constructor(host: NativeManagedHost) { this.#host = host; }
  get rootfs(): PreparedUserspaceRootfs | undefined { return this.#rootfs; }
  get active(): boolean { return this.#active; }

  async boot(manifestUrl: string | URL, options: ManagedImageBootOptions = {}): Promise<ManagedImageInfo> {
    if (this.#configured) throw new VMError("INVALID_ARGUMENT", "Create a new VM before starting another native session");
    const resume = decodeManagedResume(options.resume ?? "none"), shipped = bootShippedSource(options.shipped,"userspace",globalThis.location.href);
    const report = progressReport(options.onProgress), signal = options.signal;
    if (options.trustedKeyId === undefined || options.trustedPublicKey === undefined) {
      throw new VMError("INVALID_ARGUMENT", "Userspace rootfs requires a trusted key ID and public key");
    }
    const href = managedImageUrl(manifestUrl, globalThis.location.href).href;
    const trusted = { keyId: options.trustedKeyId, publicKey: options.trustedPublicKey.slice() };
    this.#requested={manifestUrl:href,trustedKeyId:trusted.keyId,trustedPublicKey:trusted.publicKey,...(options.manifestSHA256===undefined?{}:{manifestSHA256:options.manifestSHA256})};
    const initial=await prepareInitialStart(shipped,resume,{
      state:()=>this.#host.storage.request("initial-start-state",undefined,{signal}),
      begin:source=>this.#host.storage.request("initial-start-begin",{source},{signal,cancellation:"settled"}),
    });
    const prepared = await this.#host.storage.request("prepare-userspace-rootfs", {
      manifestUrl: href, trustedKeyId: trusted.keyId, trustedPublicKey: trusted.publicKey,
      ...(options.manifestSHA256 === undefined ? {} : { manifestSHA256: options.manifestSHA256 }),
      ...(options.cachedOnly === undefined ? {} : { cachedOnly: options.cachedOnly }),
      ...(options.imagePreparation === undefined ? {} : { imagePreparation: options.imagePreparation }),
      boot: resume === "pre-resume" || resume === "fresh-image" || resume === "update-image" ? resume : "live",
    }, { signal });
    this.#rootfs = prepared;
    const configure = async () => {
      if (this.#configured) return;
      const rootfs = prepared.metadata.slice();
      await this.#host.control.request("configure-userspace-checkpoints", {
        mount: { rootTreeSha256: prepared.rootTreeSha256, workspaceBaseSha256: prepared.workspaceBaseSha256 ?? prepared.rootTreeSha256,
          cpuProfile: prepared.cpuProfile, rootfs },
        destination: { manifestUrl: href, trusted },
      }, { signal, transfer: [rootfs.buffer] });
      this.#configured = true;
    };
    if (options.imagePreparation === "before-ready") {
      await configure();
      await this.#install("first-install", signal, report);
    }
    let coldDetails: UserspaceWorkspaceStart | undefined;
    const start = await startManaged({
      initialStart:()=>Promise.resolve(initial),
      retireInitialStart:()=>this.#host.storage.request("initial-start-retire",undefined,{cancellation:"settled"}),
      candidates: wanted => wanted === "latest" ? this.#host.storage.request("snapshot-resume-candidates", undefined, { signal }) : this.#listed(wanted, signal).then(info => [info]),
      hasRestorePoints: async () => (await this.#host.storage.request("snapshot-list", undefined, { signal })).length !== 0,
      resume: async (snapshot,initialStart) => {
        await configure();
        return this.#restore(snapshot.ref, report, signal, initialStart===undefined&&resume === "latest" ? crypto.randomUUID() : undefined, true,initialStart);
      },
      coldBoot: async boot => {
        const selected = await this.#host.storage.request("select-userspace-files", { boot, rootTreeSha256: prepared.rootTreeSha256, rootPersistence: this.#host.rootPersistence }, { signal, cancellation:"settled" });
        try {
          report?.({ step: "boot" }); await configure();
          coldDetails = await this.#host.control.request("start-userspace-cold", {sourceId:selected.sourceId}, {signal, cancellation:"settled"});
        } catch(error) {
          await this.#host.storage.request("abort-userspace-files",{sourceId:selected.sourceId},{cancellation:"settled"});
          throw error;
        }
      },
      ...(shipped === undefined ? {} : { shipped: {
        ...(shipped.kind==="listed"?{kind:"listed" as const}:{kind:"reference" as const,source:referenceIdentity(shipped)}),
        install: () => withProgressPort(report === undefined ? undefined : progress => report({ step: "download", ...progress }),
        progress => this.#host.storage.request("snapshot-install-shipped", { name: shipped.kind === "listed" ? shipped.name : shipped.reference.name, source: shipped, trustedKeyId: trusted.keyId, trustedPublicKey: trusted.publicKey.slice(), progress },
          { signal, transfer: [progress] })) } }),
    }, resume);
    this.#active = true;
    const image = this.#rootfs;
    return { id: image.id, version: image.version, runtimes: image.runtimes,
      ...(image.identity === undefined ? {} : { identity: image.identity }),
      ...(image.update === undefined ? {} : { update: image.update }),
      start: { ...start, ...(start.kind !== "booted" || coldDetails === undefined ? {} : { workspaceDetails: coldDetails }) } };
  }

  async restore(snapshot: SnapshotRef, onProgress?: (progress: StartProgress) => void, signal?: AbortSignal): Promise<ResumedSession> {
    if (!this.#active) throw new VMError("INVALID_ARGUMENT", "Start a managed native session before restoring");
    return this.#restore(decodeSnapshotRef(snapshot), progressReport(onProgress), signal);
  }

  async checkForUpdate(signal?:AbortSignal):Promise<{readonly id:string;readonly version:string}|null> {
    if(!this.#active||this.#requested===undefined)throw new VMError("INVALID_ARGUMENT","Start the native session before checking for an update");
    const before=this.#rootfs,offer=await this.#host.storage.request("check-userspace-update",this.#requested,{signal});
    return before===this.#rootfs?offer:null;
  }

  async prepareImage(signal?: AbortSignal): Promise<void> {
    if (!this.#active) throw new VMError("INVALID_ARGUMENT", "Start the native session before preparing its image");
    await this.#install("repair", signal);
  }

  async #install(reason: ImageAcquisitionReason, signal?: AbortSignal, report?: (progress: StartProgress) => void): Promise<void> {
    const observing = new AbortController();
    let totalBytes = 0;
    try {
      if (report !== undefined) {
        report({ step: "prepare", stage: "verify", completedBytes: 0, totalBytes: 0 });
        await this.#host.observe(event => {
          if (event.type === "image-preparation-progress") {
            totalBytes = event.totalBytes;
            report({ step: "prepare", ...decodeImagePreparationReport({ ...event }) });
          }
        }, observing.signal);
      }
      await this.#host.control.request("prepare-image", { reason }, { signal, cancellation: "settled" });
      report?.({ step: "prepare", stage: "commit", completedBytes: totalBytes, totalBytes });
    } finally { observing.abort(); }
  }

  async #restore(snapshot: SnapshotRef, report: ((progress: StartProgress) => void) | undefined, signal?: AbortSignal, replacedId?: string, startup = false,initialStart?:ShippedInstallIdentity): Promise<ResumedSession> {
    const opening = new AbortController();
    try {
      if (report !== undefined) {
        report({ step: "open", completedBytes: 0, totalBytes: 0 });
        await this.#host.observe(event => {
          if (event.type === "restore-progress") report({ step: "open", completedBytes: event.completedBytes, totalBytes: event.totalBytes });
        }, opening.signal);
      }
      const restored = replacedId === undefined && !startup
        ? await this.#host.control.request("restore", { snapshot }, { signal, cancellation: "settled" })
        : await this.#host.control.request("restore-userspace-checkpoint", { snapshot, ...(replacedId===undefined?{}:{replacedId}), ...(startup?{startup:true}: {}),...(initialStart===undefined?{}:{initialStart}) }, { signal, cancellation: "settled" });
      report?.({ step: "wake" });
      // The native owner established the committed outcome; late cancellation cannot undo it.
      if (restored.nativeRootfs !== undefined) this.#rootfs = restored.nativeRootfs;
      await this.#host.restored();
      report?.({ step: "reconnect" });
      return this.#session(restored);
    } finally { opening.abort(); }
  }

  #session(restored: RestoredSnapshot): ResumedSession {
    return { appData: restored.appData, newerFilesDropped: restored.newerFilesDropped, workspace: restored.workspace?.workspace ?? "in-sync",
      ...(restored.nativeRootfs?.update === undefined ? {} : { update: restored.nativeRootfs.update }),
      ...(restored.workspaceDetails === undefined ? {} : { workspaceDetails: restored.workspaceDetails }),
      terminals: restored.processes.map(process => {
        if (process.mode !== "userspace") throw new VMError("PROTOCOL_ERROR", "A native restore returned a system process attachment");
        return { source: "process", key: `process:${String(process.terminalKey)}`, command: process.command, screenTail: process.tail,
          attach: options => this.#host.attachProcess(process.attachmentKey, process.terminal, process.tail, options?.signal) };
      }) };
  }

  async #listed(ref: SnapshotRef, signal?: AbortSignal): Promise<SnapshotInfo> {
    const listed = (await this.#host.storage.request("snapshot-list", undefined, { signal }))
      .find(info => info.ref.id === ref.id && info.ref.createdAt === ref.createdAt);
    if (listed === undefined) throw new VMError("STORAGE_NOT_FOUND", "The restore point was not found");
    return listed;
  }
}
