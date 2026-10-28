import type {ShippedInstallIdentity} from "../../protocol.js";
import { serializeUnknownError, VMError } from "../../errors.js";
import {
  type ControlRequest,
  type RestoredSnapshot,
  type SnapshotEventRecord,
  type SnapshotKind,
  type SnapshotRef,
  validateAppData,
} from "../../protocol.js";
import type { PreparedSnapshotRestore, SnapshotStorageClient } from "../snapshot-channel.js";
import { type AgentResumeState, decodeAgentResumeState } from "./agent-resume-state.js";
import { assertStatus, callNumber, type Core, stage } from "./core.js";
import { captureSystemSnapshot, type CaptureOutcome } from "./snapshot-capture.js";
import {
  finishRestorePaused,
  openRestoreStream,
  rememberSnapshotBootAssets,
  type RestoreShape,
  type RestoreStream,
  SNAPSHOT_CHUNK_BYTES,
  splitU64,
  takeRestoreChunk,
  validatePreparedRestore,
  validateRestoreRecord,
} from "./snapshot.js";

type BootRequest = Extract<ControlRequest, { type: "boot-system" | "run-system-probe" }>;

/** The machine a snapshot session captures and restores; the control worker owns its lifecycle. */
export interface SnapshotMachine {
  /** The loaded core; throws when none is loaded. */
  readonly core: () => Core;
  /** The snapshot storage channel; throws when the storage worker provided none. */
  readonly storage: () => SnapshotStorageClient;
  /** Throws unless a system is booted. */
  readonly requireBooted: () => void;
  readonly memoryBytes: () => number;
  readonly shape: () => RestoreShape;
  /** Quiesces the guest agent, pauses guest execution and quiesces disks; returns the resume. */
  readonly freeze: () => Promise<() => unknown>;
  /** Whether the guest keeps running while a capture copies RAM ahead of its freeze. */
  readonly precopy: () => boolean;
  /** Stops execution and quiesces disks before a restore replaces the machine. */
  readonly stop: () => Promise<void>;
  /**
   * Runs the restored machine: fresh JIT and console state, execution and clock, and the guest
   * agent session `agent` recorded with the snapshot (a fresh session without one). `disk` is
   * how the restored machine reaches its disk: a managed host disk gets the network link.
   */
  readonly restarted: (
    memoryBytes: number,
    agent: AgentResumeState | undefined,
    disk: "none" | "core" | "host",
  ) => void;
  /** The guest-agent session (OXHA) at the capture's cut, called while the VM is frozen. */
  readonly agentState: () => Uint8Array<ArrayBuffer> | undefined;
  /** Asks the guest to write its cached file data to its disks; resolves when it has. */
  readonly syncFilesystems: () => Promise<void>;
  /** Tells the pages following this VM's restore points what happened. */
  readonly notify: (event: SnapshotEventRecord) => void;
  /** A monotonic clock in milliseconds. */
  readonly now: () => number;
  /** Leaves the machine stopped after a restore failed part-way through. */
  readonly lost: () => void;
}

/** A committed save: its restore point, the guest's pause and the whole save's duration. */
export interface SaveOutcome extends CaptureOutcome {
  readonly durationMilliseconds: number;
}

/** Restore progress goes to the pages at most this often. */
const PROGRESS_INTERVAL_MILLISECONDS = 100;

/**
 * The control worker's snapshot lineage and its capture and restore transactions. A capture
 * continues incrementally from the snapshot this machine last committed or restored.
 */
export class SnapshotSession {
  readonly #machine: SnapshotMachine;
  #parentId: string | undefined;
  #bootError: VMError | undefined;
  #busy: Promise<unknown> = Promise.resolve();
  /** Advances when the machine is reset or booted again, which starts a new lineage. */
  #lineage = 0;
  /** The page data later restore points carry; a restore brings back the one saved with it. */
  #appData: Uint8Array | undefined;

  constructor(machine: SnapshotMachine) {
    this.#machine = machine;
  }

  /** Forgets the lineage, as a reinitialized or disposed machine has none. */
  reset(): void {
    this.#appData = undefined;
    this.#lineage += 1;
    this.#parentId = undefined;
    this.#bootError = undefined;
  }

  /** Persists a new boot's assets; a new boot starts a new lineage. */
  async rememberBoot(request: BootRequest): Promise<void> {
    this.#lineage += 1;
    this.#parentId = undefined;
    try {
      await rememberSnapshotBootAssets(this.#machine.storage(), request);
      this.#bootError = undefined;
    } catch (error) {
      this.#bootError =
        error instanceof VMError
          ? error
          : new VMError("STORAGE_ERROR", String(error));
    }
  }

  /** Sets the page data (at most 1 MiB) that later restore points carry; null for none. */
  setAppData(data: Uint8Array | null): void {
    this.#appData = validateAppData(data)?.slice();
  }

  /** Saves the machine; the pages following its restore points hear the save start and end. */
  capture(request: { readonly kind: SnapshotKind; readonly label?: string }): Promise<SaveOutcome> {
    return this.#exclusive(async () => {
      this.#machine.requireBooted();
      if (this.#bootError !== undefined) throw this.#bootError;
      const kind = request.kind;
      this.#machine.notify({ type: "save-started", kind });
      const startedAt = this.#machine.now();
      try {
        const outcome = await this.#save(request);
        const durationMilliseconds = this.#machine.now() - startedAt;
        this.#machine.notify({ type: "save-finished", kind, ...outcome, durationMilliseconds });
        return { ...outcome, durationMilliseconds };
      } catch (error) {
        this.#machine.notify({ type: "save-failed", kind, error: serializeUnknownError(error) });
        throw error;
      }
    });
  }

  async #save(request: { readonly kind: SnapshotKind; readonly label?: string }): Promise<CaptureOutcome> {
    const lineage = this.#lineage;
    // A save's disk then holds the files the guest wrote, so a cold boot of it (a restart
    // from the newest files) finds them too; a guest that cannot sync is saved as it is.
    await this.#machine.syncFilesystems().catch(() => undefined);
    const result = await captureSystemSnapshot(
      this.#machine.core(),
      this.#machine.storage(),
      {
        memoryBytes: this.#machine.memoryBytes(),
        vcpus: this.#machine.shape().vcpus,
        parentId: this.#parentId,
        kind: request.kind,
        label: request.label,
        appData: this.#appData,
      },
      { freeze: this.#machine.freeze, agentState: this.#machine.agentState, precopy: this.#machine.precopy(), now: this.#machine.now },
    );
    // A machine reset or booted during the capture no longer continues from it.
    if (this.#lineage === lineage) this.#parentId = result.snapshot.id;
    return result;
  }

  /**
   * Restores `snapshot` over this machine. Its chunks stream from the storage owner in the
   * prepared order: a core disk's base before the machine stops, then RAM and the core disk's
   * changes into the core. A chunk that fails verification stops the restore before it
   * finishes.
   */
  restore(snapshot: SnapshotRef, checkCancelled: () => void = () => {},initialStart?:ShippedInstallIdentity): Promise<RestoredSnapshot> {
    return this.#exclusive(() => this.#restore(snapshot, checkCancelled,initialStart));
  }

  /**
   * Reports restored bytes to the pages, at most every 100 ms; the last chunk reports the total.
   */
  #progress(totalBytes: number): (bytes: number) => void {
    let completedBytes = 0;
    let reportedAt = this.#machine.now();
    return (bytes) => {
      completedBytes += bytes;
      const now = this.#machine.now();
      if (completedBytes < totalBytes && now - reportedAt < PROGRESS_INTERVAL_MILLISECONDS) return;
      reportedAt = now;
      this.#machine.notify({ type: "restore-progress", completedBytes, totalBytes });
    };
  }

  /**
   * Runs `operation` while no capture or restore runs: it waits for the one under way, and the
   * next waits for it. A workspace flush streams through the guest agent and storage, which a
   * save would pause and compete for.
   */
  exclusively<T>(operation: () => Promise<T>): Promise<T> {
    return this.#exclusive(operation);
  }

  /**
   * Runs one capture or restore at a time: a capture's pre-copy keeps it open while the guest
   * runs, and a restore must not replace the machine underneath it.
   */
  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#busy.then(operation);
    this.#busy = result.catch(() => undefined);
    return result;
  }

  async #restore(snapshot: SnapshotRef, checkCancelled: () => void,initialStart?:ShippedInstallIdentity): Promise<RestoredSnapshot> {
    checkCancelled();
    const lineage = this.#lineage;
    const loaded = this.#machine.core();
    const storage = this.#machine.storage();
    let destructive = false;
    let stream: RestoreStream | undefined;
    try {
      const prepared = validatePreparedRestore(
        await storage.request({ type: "prepare-restore", snapshot,...(initialStart===undefined?{}:{initialStart}) }),
        snapshot,
      );
      checkCancelled();
      validateRestoreRecord(loaded, prepared.machineRecord, this.#machine.shape());
      const agent = prepared.agentState === undefined ? undefined : decodeAgentResumeState(prepared.agentState);
      const progress = this.#progress(restoreBytes(prepared));
      stream = openRestoreStream(storage);
      const { reader } = stream;
      let base = new Uint8Array();
      if (prepared.disk.mode === "core") {
        base = new Uint8Array(prepared.disk.bytes);
        for (const index of prepared.disk.baseChunks) {
          const chunk = await takeRestoreChunk(reader, "disk-base", index, prepared.disk.bytes);
          checkCancelled();
          base.set(chunk, index * SNAPSHOT_CHUNK_BYTES);
          progress(chunk.byteLength);
        }
      }
      // The machine stops only once storage is streaming the chunks that replace it.
      await reader.ready();
      checkCancelled();
      await this.#machine.stop();
      checkCancelled();
      stage(loaded, base);
      const diskKind = prepared.disk.mode === "none" ? 0 : prepared.disk.mode === "host" ? 1 : 2;
      const [diskLow, diskHigh] = splitU64(prepared.disk.bytes);
      destructive = true;
      assertStatus(
        callNumber(loaded, "oxidevm_system_restore_begin", [
          diskKind,
          diskLow,
          diskHigh,
          base.byteLength,
        ]),
      );
      for (const index of prepared.ramChunks) {
        const data = await takeRestoreChunk(reader, "ram", index, prepared.memoryBytes);
        progress(data.byteLength);
        stage(loaded, data);
        const [low, high] = splitU64(index);
        assertStatus(
          callNumber(loaded, "oxidevm_system_restore_ram_chunk", [
            low,
            high,
            data.byteLength,
          ]),
        );
      }
      if (prepared.disk.mode === "core") {
        for (const index of prepared.disk.overlayChunks) {
          const data = await takeRestoreChunk(reader, "disk-overlay", index, prepared.disk.bytes);
          progress(data.byteLength);
          stage(loaded, data);
          const [low, high] = splitU64(index);
          assertStatus(
            callNumber(loaded, "oxidevm_system_restore_disk_chunk", [
              low,
              high,
              data.byteLength,
            ]),
          );
        }
      }
      if ((await reader.next()) !== undefined) {
        throw new VMError("PROTOCOL_ERROR", "the restore stream sent more chunks than the restore needs");
      }
      await stream.done;
      finishRestorePaused(loaded, Date.now());
      await storage.request({ type: "commit-restore-disk" });
      await storage.request({ type: "complete-restore" });
      if (this.#lineage === lineage) this.#parentId = snapshot.id;
      this.#bootError = undefined;
      this.#appData = prepared.appData?.slice();
      this.#machine.restarted(prepared.memoryBytes, agent, prepared.disk.mode);
      return {
        ...(prepared.systemImage===undefined?{}:{systemImage:prepared.systemImage}),
        newerFilesDropped: prepared.newerFiles,
        appData: prepared.appData?.slice() ?? null,
        consoleTail: agent?.consoleTail.slice() ?? new Uint8Array(),
        processes: (agent?.processes ?? []).map(({ agentRequestId, command, terminal, tail }) => ({
          agentRequestId,
          command,
          terminal,
          tail: tail.slice(),
        })),
      };
    } catch (error) {
      stream?.reader.cancel();
      await storage.request({ type: "abort" }).catch(() => undefined);
      if (!destructive) {
        callNumber(loaded, "oxidevm_system_restore_abort");
      } else {
        this.#machine.lost();
      }
      throw error;
    }
  }
}

/** The bytes a prepared restore streams: RAM and, for a core disk, its base and changes. */
function restoreBytes(prepared: PreparedSnapshotRestore): number {
  const length = (index: number, total: number) => Math.min(SNAPSHOT_CHUNK_BYTES, total - index * SNAPSHOT_CHUNK_BYTES);
  let bytes = 0;
  for (const index of prepared.ramChunks) bytes += length(index, prepared.memoryBytes);
  for (const index of [...prepared.disk.baseChunks, ...prepared.disk.overlayChunks]) bytes += length(index, prepared.disk.bytes);
  return bytes;
}
