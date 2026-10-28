import { VMError } from "../errors.js";
import { UserspaceCapture } from "./userspace-checkpoint/capture.js";
import { UserspacePrecopy } from "./userspace-checkpoint/precopy.js";
import { UserspaceRestore } from "./userspace-checkpoint/restore.js";
import { UserspaceCold } from "./userspace-checkpoint/cold.js";
import { CheckpointRaw, type CheckpointRuntime } from "./userspace-checkpoint/raw.js";
import { restoreSelection } from "./userspace-checkpoint/selection.js";
import { rejectBegin } from "./userspace-checkpoint/failure.js";
export type { CheckpointSink, CheckpointInput, CheckpointArea } from "./userspace-checkpoint/stream.js";
export { UserspaceCapture, UserspaceRestore, UserspacePrecopy, UserspaceCold };
export type { CheckpointPayloadSink } from "./userspace-checkpoint/precopy.js";

/** One raw transfer owns the instance until commit or confirmed cancellation. */
export class UserspaceCheckpoints {
  readonly #raw: CheckpointRaw; readonly #beforePublish: () => void;
  #busy = false;
  #quiesce: bigint | undefined;
  #failedBegin: { readonly token: bigint; readonly abort: "abort" | "cold_abort" } | undefined;
  #restore: UserspaceRestore | undefined;
  constructor(runtime: CheckpointRuntime, beforePublish: () => void) { this.#raw = new CheckpointRaw(runtime); this.#beforePublish = beforePublish; }
  get incarnation(): bigint { return this.#raw.u64("incarnation"); }
  get dirty(): bigint { return this.#raw.u64("dirty"); }
  get baseline(): bigint { return this.#raw.u64("baseline"); }
  get acknowledgedDirty(): bigint { return this.#raw.u64("dirty_acknowledged"); }
  /** Excludes asynchronous durability latency from native idle-clock accounting. */
  pauseClock(): void {
    if (this.#quiesce !== undefined) throw new VMError("PROTOCOL_ERROR", "Native clock is already quiesced");
    const token = this.#raw.u64("quiesce_begin");
    if (token === 0n) throw new VMError("PROTOCOL_ERROR", "Native clock could not quiesce");
    // Clock pause returns zero on every refusal; its token proves success. The
    // shared status getter describes the prior capture/round, not this operation.
    this.#quiesce = token;
  }
  resumeClock(): void {
    if (this.#quiesce === undefined) return;
    this.#raw.ok("quiesce_finish", this.#quiesce);
    this.#quiesce = undefined;
  }
  beginCapture(image: Uint8Array): UserspaceCapture {
    const token = this.#begin("capture", image);
    return new UserspaceCapture(this.#raw, token, () => { this.#busy = false; });
  }
  beginCold(image: Uint8Array): UserspaceCold {
    const token = this.#begin("cold", image);
    return new UserspaceCold(this.#raw, token, () => { this.#busy = false; }, this.#beforePublish);
  }
  beginPrecopy(image: Uint8Array, expectedBaseline?: bigint): UserspacePrecopy {
    if (expectedBaseline !== undefined && (expectedBaseline <= 0n || expectedBaseline > 0xffff_ffff_ffff_ffffn || expectedBaseline !== this.baseline)) {
      throw new VMError("PROTOCOL_ERROR", "Native checkpoint baseline is unavailable", { reason: "checkpoint-baseline-unavailable" });
    }
    const token = this.#begin("precopy", image, expectedBaseline);
    return new UserspacePrecopy(this.#raw, token, () => { this.#busy = false; });
  }
  beginPrecopyIncremental(image: Uint8Array, expectedBaseline: bigint): UserspacePrecopy { return this.beginPrecopy(image, expectedBaseline); }
  beginRestore(image: Uint8Array, recoveryImage?: Uint8Array, selectedRootIdentity?: Uint8Array | null): UserspaceRestore {
    const token = this.#begin("restore", restoreSelection(image, recoveryImage, selectedRootIdentity));
    const restore = new UserspaceRestore(this.#raw, token, () => { this.#busy = false; }, this.#beforePublish);
    this.#restore = restore; return restore;
  }
  beginRecovery(image: Uint8Array): UserspaceRestore {
    if (this.#restore?.canRecover !== true) throw new VMError("PROTOCOL_ERROR", "Checkpoint recovery requires a retired original runtime");
    const token = this.#begin("recovery", image);
    const restore = new UserspaceRestore(this.#raw, token, () => { this.#busy = false; }, this.#beforePublish, true);
    this.#restore = restore; return restore;
  }
  /** A failed native clock reattachment retains its token so cancellation can be retried. */
  retryAbort(): void {
    if (this.#failedBegin === undefined) return;
    this.#raw.ok(this.#failedBegin.abort, this.#failedBegin.token); this.#failedBegin = undefined; this.#busy = false;
  }
  #begin(kind: "capture" | "restore" | "recovery" | "precopy" | "cold", image: Uint8Array, baseline?: bigint): bigint {
    const validLength = kind === "restore" ? [32, 64, 105].includes(image.length) : image.length === 32;
    if (this.#busy && kind !== "recovery" || !validLength) throw new VMError("PROTOCOL_ERROR", "Checkpoint boundary is busy or image identity is invalid");
    this.#raw.stage(image);
    const token = baseline === undefined ? this.#raw.u64(`${kind}_begin`) : this.#raw.u64("precopy_begin_incremental", baseline);
    if (token === 0n) {
      if (kind === "capture" || kind === "precopy") rejectBegin(this.#raw, kind === "precopy");
      throw new VMError("PROTOCOL_ERROR", "Native checkpoint could not begin");
    }
    this.#busy = true;
    try { this.#raw.ok("status"); }
    catch (error) {
      this.#failedBegin = { token, abort: kind === "cold" ? "cold_abort" : "abort" };
      try { this.retryAbort(); }
      catch { throw new VMError("STORAGE_ERROR", "Native checkpoint begin could not confirm cancellation", {
        reason: "checkpoint-capture-cleanup-failed", cleanupFailed: true,
      }); }
      throw error;
    }
    this.#failedBegin = undefined;
    return token;
  }
}

// Storage consolidation consumes this same bounded framing authority.
export { StreamReader as CheckpointStreamReader, ChunkSink as CheckpointChunkSink,
  header as checkpointHeader, checkHeader as checkCheckpointHeader } from "./userspace-checkpoint/stream.js";
export { decodeCheckpointDeclaration, encodeCheckpointDeclaration, type CheckpointPayloadDeclaration } from "./userspace-checkpoint/framing.js";

export type {UserspaceReconcile,ReconcileSource,ReconcileHost,NativeWorkspaceReconciled} from "./userspace-checkpoint/reconcile.js";

export type { CandidateWorkspaceExport } from "./userspace-checkpoint/workspace-export.js";
