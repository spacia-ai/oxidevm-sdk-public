import type {ShippedInstallIdentity} from "./protocol.js";
import { VMError } from "./errors.js";
import { managedImageUrl } from "./managed-image.js";
import { type ResumedSession, startManaged, progressReport, decodeManagedResume,prepareInitialStart,referenceIdentity } from "./managed-start.js";
import {bootShippedSource, type ShippedSource} from "./protocol/shipped-source.js";
import { withProgressPort } from "./progress-port.js";
import {
  type ControlOperations,
  decodeSnapshotRef,
  type ManagedBoot,
  type PreparedManagedImage,
  type PreparedImageIdentity,
  type RestoredSnapshot,
  type SnapshotInfo,
  type SnapshotRef,
  type StorageOperations,
  validateSystemBootInput,
} from "./protocol.js";
import type {
  ResumedTerminal,
  ResumedWorkspaceState,
  SnapshotEvent,
  StartProgress,
} from "./snapshot-types.js";
import type { SystemExecution } from "./system-execution.js";
import type { ManagedImageBootOptions, ManagedImageInfo, ProcessHandle } from "./vm-types.js";
import type { WorkerClient } from "./worker-client.js";

/** How long a restored guest agent may take to answer its first greeting. */
const RESTORED_AGENT_TIMEOUT_MILLISECONDS = 60_000;

/** Tells the page the step a resume or restore has reached. */
type ProgressReport = (progress: StartProgress) => void;

/** What a managed session uses of the system VM that owns it. */
export interface ManagedSessionHost {
  readonly control: WorkerClient<ControlOperations>;
  readonly storage: WorkerClient<StorageOperations>;
  readonly memoryMiB: number;
  readonly vcpus: number;
  /** Runs the booted machine as the VM's active execution. */
  readonly startExecution: (signal: AbortSignal | undefined) => Promise<SystemExecution>;
  /** Stops the VM's active execution, if any. */
  readonly stopExecution: () => Promise<void>;
  /** True while an execution, the page's or the session's, runs the machine. */
  readonly executionRunning: () => boolean;
  /** Asks the running guest to write what it holds in memory to its disk ("sync"). */
  readonly syncGuestDisk: () => Promise<void>;
  /** Gives the page a guest process a restore brought back. */
  readonly attachProcess: (agentRequestId: number, signal: AbortSignal | undefined) => Promise<ProcessHandle>;
  /** Calls `listener` with each restore point event until `signal` aborts; resolves once events flow. */
  readonly observe: (listener: (event: SnapshotEvent) => void, signal: AbortSignal) => Promise<void>;
  /** Starts the VM's network link (ADR 0015) once; every managed boot and resume needs it. */
  readonly connectNetworkLink: (signal: AbortSignal | undefined) => Promise<void>;
}

/**
 * The managed image a system VM runs: booting it, the guest's workspace identity, the execution
 * kept running for it, and restoring it in session. Once its execution fails, guest operations
 * fail with that failure until the next boot or restore.
 */
export class ManagedSession {
  readonly #host: ManagedSessionHost;
  #active = false;
  #workspaceBaseSha256: string | undefined;
  /** Whether the running disk runs an older image than its boot asked for, which an update moves from. */
  #updateOffered = false;
  #failure: VMError | undefined;
  #imageIdentity: PreparedImageIdentity | undefined;
  #requested: StorageOperations["check-system-update"]["request"] | undefined;

  constructor(host: ManagedSessionHost) {
    this.#host = host;
  }

  /** Whether a managed image is booted (or restored) and its guest is in use. */
  get active(): boolean {
    return this.#active;
  }

  /** The cross-mode workspace identity of the managed image last booted. */
  get workspaceBaseSha256(): string | undefined {
    return this.#workspaceBaseSha256;
  }

  get imageIdentity(): PreparedImageIdentity | undefined { return this.#imageIdentity; }

  async checkForUpdate(signal?: AbortSignal): Promise<{ readonly id: string; readonly version: string } | null> {
    this.assertUsable();
    if (!this.#active || this.#requested === undefined) throw new VMError("INVALID_ARGUMENT", "Start a managed session before checking for an update");
    const before = this.#imageIdentity;
    const offer = await this.#host.storage.request("check-system-update", this.#requested, { signal });
    if (!this.active || before !== this.#imageIdentity) return null;
    this.#updateOffered = offer !== null;
    return offer;
  }

  /** Throws the managed execution's failure, if it failed. */
  assertUsable(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }

  /** A raw boot or probe replaces the managed image. */
  deactivate(): void {
    this.#active = false;
    this.#workspaceBaseSha256 = undefined;
    this.#imageIdentity = undefined;
  }

  /** Boots or resumes `manifestUrl`'s image as `options.resume` asks; see `startManaged`. */
  async boot(manifestUrl: string | URL, options: ManagedImageBootOptions = {}): Promise<ManagedImageInfo> {
    if ((options.trustedKeyId === undefined) !== (options.trustedPublicKey === undefined)) {
      throw new VMError("INVALID_ARGUMENT", "system AOT trust requires both a key ID and public key");
    }
    const resume = decodeManagedResume(options.resume ?? "none");
    const shipped = bootShippedSource(options.shipped,"system",globalThis.location.href);
    const report = progressReport(options.onProgress);
    const signal = options.signal;
    const initial=await prepareInitialStart(shipped,resume,{
      state:()=>this.#host.storage.request("initial-start-state",undefined,{signal}),
      begin:source=>this.#host.storage.request("initial-start-begin",{source},{signal,cancellation:"settled"}),
    });
    await this.#host.connectNetworkLink(signal);
    // An update to another image boots a fresh disk of it, whose /workspace comes from the
    // workspace store: the running guest writes its files there first. An update boot that keeps
    // the image the disk runs (today's IDE reboots that way) moves nothing, so writes nothing out.
    if (resume === "update-image" && this.#updateOffered) await this.synchronize();
    // A restart boots the guest again from its disk, so it writes what it holds in memory there
    // first. A guest that cannot (a hung one, which a restart recovers) restarts all the same.
    if ((resume === "none" || resume === "pre-resume") && this.#active) await this.#host.syncGuestDisk().catch(() => undefined);
    this.#active = false;
    this.#workspaceBaseSha256 = undefined;
    const href = managedImageUrl(manifestUrl, globalThis.location.href).href;
    this.#requested = { manifestUrl: href, ...(options.manifestSHA256 === undefined ? {} : { manifestSHA256: options.manifestSHA256 }),
      ...(options.trustedKeyId === undefined || options.trustedPublicKey === undefined ? {} : { trustedKeyId: options.trustedKeyId, trustedPublicKey: options.trustedPublicKey.slice() }) };
    let boot: ManagedBoot = resume === "pre-resume" || resume === "fresh-image" || resume === "update-image" ? resume : "live";
    let prepared = await this.#prepare(href, options, boot);
    // Whether this boot tried a resume, and whether one restored its disk before it failed: that
    // disk replaced the one the user last had, which then boots instead.
    let attempted = false;
    let restoredDisk = false;
    let restoredImage: RestoredSnapshot["systemImage"];
    const start = await startManaged({
      initialStart:()=>Promise.resolve(initial),
      retireInitialStart:()=>this.#host.storage.request("initial-start-retire",undefined,{cancellation:"settled"}),
      candidates: async (wanted) => wanted === "latest"
        ? this.#host.storage.request("snapshot-resume-candidates", undefined, { signal })
        : [await this.#listed(wanted, signal)],
      hasRestorePoints: async () => (await this.#host.storage.request("snapshot-list", undefined, { signal })).length !== 0,
      resume: (snapshot,initialStart) => {
        attempted = true;
        return this.#resumeAtBoot(snapshot, signal, report, restored => {
          restoredDisk = true;
          restoredImage = restored.systemImage;
        },initialStart);
      },
      coldBoot: async (wanted) => {
        const next = wanted === "live" && restoredDisk ? "pre-resume" : wanted;
        if (next !== boot || attempted) {
          prepared = await this.#prepare(href, options, next);
          boot = next;
        }
        report?.({ step: "boot" });
        await this.#coldBoot(prepared, signal);
      },
      ...(shipped === undefined ? {} : { shipped: {
        ...(shipped.kind==="listed"?{kind:"listed" as const}:{kind:"reference" as const,source:referenceIdentity(shipped)}),
        install:()=>this.#installShipped(shipped,options,report,signal),
      } }),
    }, resume);
    const running = start.kind === "resumed" ? restoredImage ?? prepared : prepared;
    this.#active = true;
    this.#workspaceBaseSha256 = running.workspaceBaseSha256;
    this.#imageIdentity = running.identity;
    this.#updateOffered = running.update !== undefined;
    return {
      id: running.id,
      version: running.version,
      runtimes: running.runtimes,
      ...(running.identity === undefined ? {} : { identity: running.identity }),
      start,
      ...(running.update === undefined ? {} : { update: running.update }),
    };
  }

  /** Stops what runs, then prepares the image's disk generation `boot` selects and its AOT. */
  async #prepare(href: string, options: ManagedImageBootOptions, boot: ManagedBoot): Promise<PreparedManagedImage> {
    const signal = options.signal;
    await this.#host.stopExecution();
    await this.#host.control.request("quiesce-disk", undefined, { signal });
    const prepared = await this.#host.storage.request(
      "prepare-managed-image",
      {
        manifestUrl: href,
        ...(options.manifestSHA256 === undefined ? {} : { manifestSHA256: options.manifestSHA256 }),
        ...(options.cachedOnly === undefined ? {} : { cachedOnly: options.cachedOnly }),
        ...(options.imagePreparation === undefined ? {} : { imagePreparation: options.imagePreparation }),
        ...(options.trustedKeyId === undefined || options.trustedPublicKey === undefined
          ? {}
          : { trustedKeyId: options.trustedKeyId, trustedPublicKey: options.trustedPublicKey.slice() }),
        boot,
      },
      { signal },
    );
    if (prepared.memoryMiB !== this.#host.memoryMiB) {
      throw new VMError(
        "INVALID_ARGUMENT",
        `managed image requires ${prepared.memoryMiB} MiB, VM has ${this.#host.memoryMiB} MiB`,
      );
    }
    if (prepared.vcpus !== this.#host.vcpus) {
      throw new VMError(
        "INVALID_ARGUMENT",
        `managed image requires ${prepared.vcpus} vCPUs, VM has ${this.#host.vcpus}`,
      );
    }
    validateSystemBootInput(
      this.#host.memoryMiB,
      prepared.kernel.byteLength,
      prepared.initrd?.byteLength ?? 0,
      0,
      prepared.commandLine,
    );
    const aot = prepared.aot.kind === "ready" ? { ...prepared.aot, index: prepared.aot.index.slice() } : prepared.aot;
    await this.#host.control.request(
      "configure-system-aot",
      { configuration: aot },
      { signal, transfer: aot.kind === "ready" ? [aot.index.buffer] : [] },
    );
    return prepared;
  }

  /** Boots the prepared image's kernel and brings the guest's /workspace up to the store's. */
  async #coldBoot(prepared: PreparedManagedImage, signal: AbortSignal | undefined): Promise<void> {
    const kernel = prepared.kernel.slice();
    const initrd = prepared.initrd?.slice();
    await this.#host.control.request(
      "boot-system",
      {
        memoryMiB: this.#host.memoryMiB,
        kernel,
        commandLine: prepared.commandLine,
        hostDiskBytes: prepared.diskBytes,
        ...(initrd === undefined ? {} : { initrd }),
      },
      { signal, transfer: [kernel.buffer, ...(initrd === undefined ? [] : [initrd.buffer])] },
    );
    await this.#host.control.request("wait-agent", { timeoutMilliseconds: 180_000 }, { signal });
    await this.#startExecution(signal);
    if (prepared.workspaceBaseSha256 === undefined) return;
    const streamed = await this.#host.control.request("agent-restore-workspace",
      { workspaceBaseSha256: prepared.workspaceBaseSha256 }, { signal });
    if (streamed) return;
    const workspaceDelta = await this.#host.storage.request(
      "read-workspace-delta",
      { workspaceBaseSha256: prepared.workspaceBaseSha256 },
      { signal },
    );
    if (workspaceDelta !== undefined) {
      await this.#host.control.request(
        "agent-apply-workspace-delta",
        { data: workspaceDelta },
        { signal, transfer: [workspaceDelta.buffer] },
      );
    }
  }

  /**
   * Restores `snapshot` where no machine runs yet, then greets the restored agent, steps the
   * guest's clock and carries the workspace store's later changes in. An agent that does not
   * answer fails the resume with reason agent-unavailable.
   */
  async #resumeAtBoot(
    snapshot: SnapshotInfo,
    signal: AbortSignal | undefined,
    report: ProgressReport | undefined,
    diskRestored: (restored: RestoredSnapshot) => void,
    initialStart?:ShippedInstallIdentity,
  ): Promise<ResumedSession> {
    const restored = await this.#opening(report, () =>
      this.#host.control.request("restore", { snapshot: snapshot.ref,...(initialStart===undefined?{}:{initialStart}) }, { signal,cancellation:"settled" }));
    diskRestored(restored);
    report?.({ step: "wake" });
    await this.#startExecution(signal);
    report?.({ step: "reconnect" });
    try {
      await this.#host.control.request("wait-agent", { timeoutMilliseconds: RESTORED_AGENT_TIMEOUT_MILLISECONDS }, { signal });
      await this.#host.control.request("agent-refresh-guest", undefined, { signal });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      throw new VMError("GUEST_CRASH", "the restored guest agent did not answer", { reason: "agent-unavailable" });
    }
    const { workspace } = await this.#host.control.request("agent-reconcile-workspace", { snapshot: snapshot.ref }, { signal });
    return this.#session(restored, workspace);
  }

  /**
   * Runs `restore` as the "open" step, reporting the bytes it reads from the restore point. Bytes
   * reported after `restore` settles belong to no step and are not reported.
   */
  async #opening(report: ProgressReport | undefined, restore: () => Promise<RestoredSnapshot>): Promise<RestoredSnapshot> {
    if (report === undefined) return restore();
    report({ step: "open", completedBytes: 0, totalBytes: 0 });
    const opening = new AbortController();
    try {
      await this.#host.observe((event) => {
        if (event.type === "restore-progress") {
          report({ step: "open", completedBytes: event.completedBytes, totalBytes: event.totalBytes });
        }
      }, opening.signal);
      return await restore();
    } finally {
      opening.abort();
    }
  }

  /**
   * Downloads and verifies the shipped restore point the prepared profile lists as `name`; it
   * needs the trusted key the profile's AOT catalog is checked with.
   */
  async #installShipped(
    source: ShippedSource,
    options: ManagedImageBootOptions,
    report: ProgressReport | undefined,
    signal: AbortSignal | undefined,
  ): Promise<SnapshotInfo> {
    const { trustedKeyId, trustedPublicKey } = options;
    if (trustedKeyId === undefined || trustedPublicKey === undefined) {
      throw new VMError("PERMISSION_DENIED", "a shipped restore point needs a trusted key", { reason: "shipped-untrusted" });
    }
    const publicKey = trustedPublicKey.slice();
    return withProgressPort(
      report === undefined ? undefined : (progress) => {
        report({ step: "download", ...progress });
      },
      (progress) => this.#host.storage.request(
        "snapshot-install-shipped",
        { name: source.kind === "listed" ? source.name : source.reference.name, ...(source.kind === "reference" ? {source} : {}), trustedKeyId, trustedPublicKey: publicKey, progress },
        { signal, transfer: [progress, publicKey.buffer] },
      ),
    );
  }

  /** The restore point `ref` names, as the catalogue lists it. */
  async #listed(ref: SnapshotRef, signal: AbortSignal | undefined): Promise<SnapshotInfo> {
    const listed = (await this.#host.storage.request("snapshot-list", undefined, { signal }))
      .find((info) => info.ref.id === ref.id && info.ref.createdAt === ref.createdAt);
    if (listed === undefined) throw new VMError("STORAGE_NOT_FOUND", "the restore point was not found");
    return listed;
  }

  /** What a page needs from a completed restore: its data, terminals and workspace state. */
  #session(restored: RestoredSnapshot, workspace: ResumedWorkspaceState): ResumedSession {
    return {
      appData: restored.appData,
      terminals: [
        { source: "console", key: "console", screenTail: restored.consoleTail },
        ...restored.processes.map((process): ResumedTerminal => {
          if (process.mode === "userspace") throw new VMError("PROTOCOL_ERROR", "A system restore returned a native process attachment");
          return {
          source: "process",
          key: `process:${String(process.agentRequestId)}`,
          command: process.command,
          screenTail: process.tail,
          attach: (attachOptions) => this.#host.attachProcess(process.agentRequestId, attachOptions?.signal),
          };
        }),
      ],
      newerFilesDropped: restored.newerFilesDropped,
      workspace,
      ...(restored.systemImage?.update === undefined ? {} : { update: restored.systemImage.update }),
    };
  }

  /**
   * Writes the guest's /workspace to the workspace store, through the guest agent, which answers
   * only while the guest runs. Disposal runs the guest in an execution of its own (`"own"`),
   * which replaces any other: the page may have ended the one it ran, or stopped reading it (the
   * IDE shows the console in its own and stops it before a mode switch). A suspend keeps the
   * page's running execution (`"running"`), whose console the page still shows.
   */
  async synchronize(execution: "own" | "running" = "own"): Promise<void> {
    if (!this.#active) return;
    const workspaceBaseSha256 = this.#workspaceBaseSha256;
    if (workspaceBaseSha256 === undefined) {
      throw new VMError(
        "STORAGE_ERROR",
        "managed image does not declare a cross-mode workspace identity",
        { reason: "workspace-base-missing" },
      );
    }
    if (execution === "own" || !this.#host.executionRunning()) await this.#startExecution(undefined);
    if (await this.#host.control.request("agent-sync-workspace", { workspaceBaseSha256 })) return;
    const delta = await this.#host.control.request("agent-workspace-delta", undefined);
    await this.#host.storage.request(
      "commit-workspace-delta",
      { workspaceBaseSha256, data: delta },
      { transfer: [delta.buffer] },
    );
  }

  /**
   * Restores `snapshot` in session; the chosen point's files come back as they were, so the
   * workspace is not reconciled. A refused restore leaves the VM running as it was.
   */
  async restore(snapshot: SnapshotRef, onProgress?: (progress: StartProgress) => void, signal?: AbortSignal): Promise<ResumedSession> {
    const ref = decodeSnapshotRef(snapshot);
    if (signal?.aborted === true) throw new VMError("ABORTED", "Restore cancelled before replacement");
    const report = progressReport(onProgress);
    const managed = this.#active;
    await this.#host.stopExecution();
    let restored: RestoredSnapshot | undefined;
    let failure: VMError | undefined;
    try {
      restored = await this.#opening(report, () => this.#host.control.request("restore", { snapshot: ref }, { signal, cancellation: "settled" }));
    } catch (error) {
      failure = guestFailure(error);
    }
    if (managed) await this.#resumeExecution(failure, failure === undefined ? report : undefined);
    if (failure !== undefined || restored === undefined) throw failure ?? new VMError("PROTOCOL_ERROR", "restore returned nothing");
    if (managed && restored.systemImage !== undefined) {
      const running = restored.systemImage;
      this.#imageIdentity = running.identity;
      this.#workspaceBaseSha256 = running.workspaceBaseSha256;
      this.#updateOffered = running.update !== undefined;
    }
    return this.#session(restored, "in-sync");
  }

  /**
   * Runs a managed VM again after a restore: a completed restore replaced the machine and a
   * refused one left it as it was. A restore that failed part-way leaves no machine to run, so
   * the VM stops being managed and later calls fail with that restore's error.
   */
  async #resumeExecution(restoreFailure: VMError | undefined, report: ProgressReport | undefined): Promise<void> {
    report?.({ step: "wake" });
    try {
      await this.#startExecution(undefined);
    } catch (error) {
      this.#active = false;
      this.#workspaceBaseSha256 = undefined;
      this.#failure = guestFailure(restoreFailure ?? error);
      if (restoreFailure === undefined) throw error;
      return;
    }
    // A restored agent will not announce itself again: greet it now, without waiting for READY.
    // A completed restore then reseeds the guest's entropy and steps its paused clock.
    report?.({ step: "reconnect" });
    try {
      await this.#host.control.request("wait-agent", { timeoutMilliseconds: RESTORED_AGENT_TIMEOUT_MILLISECONDS });
      if (restoreFailure === undefined) await this.#host.control.request("agent-refresh-guest", undefined);
    } catch (error) {
      this.#failure = guestFailure(error);
      if (restoreFailure === undefined) throw this.#failure;
    }
  }

  async #startExecution(signal: AbortSignal | undefined): Promise<void> {
    const execution = await this.#host.startExecution(signal);
    this.#failure = undefined;
    void this.#drain(execution);
  }

  async #drain(execution: SystemExecution): Promise<void> {
    const reader = execution.events.getReader();
    try {
      while (!(await reader.read()).done) {
        // Console and telemetry are drained here so the worker keeps running.
      }
      await execution.exit;
    } catch (error) {
      this.#failure = guestFailure(error);
    } finally {
      reader.releaseLock();
    }
  }
}

/** A failure of the managed guest's execution as a stable SDK error. */
function guestFailure(error: unknown): VMError {
  return error instanceof VMError
    ? error
    : new VMError("GUEST_CRASH", error instanceof Error ? error.message : String(error));
}
