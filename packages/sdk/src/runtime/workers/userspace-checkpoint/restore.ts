import { UserspaceCandidateWorkspace, type CandidateWorkspaceExport } from "./workspace-export.js";
import { UserspaceReconcile } from "./reconcile.js";
import { decodeCheckpointDeclaration } from "./framing.js";
import { integer } from "../../decode.js";
import type { NativeAttachment } from "../userspace-attachments.js";
import { VMError } from "../../errors.js";
import type { CheckpointRaw } from "./raw.js";
import { active, checkHeader, FRAME_BYTES, invalid, StreamReader, type CheckpointInput } from "./stream.js";

export class UserspaceRestore {
  readonly #raw: CheckpointRaw; readonly #token: bigint; readonly #ended: () => void; readonly #beforePublish: () => void;
  #state: "open" | "reading" | "ready" | "failed" | "ended" = "open";
  #destructive = false;
  #prepared=false;
  constructor(raw: CheckpointRaw, token: bigint, ended: () => void, beforePublish: () => void, destructive = false) {
    this.#raw = raw; this.#token = token; this.#ended = ended; this.#beforePublish = beforePublish; this.#destructive = destructive;
  }
  get canRecover(): boolean { return this.#destructive && this.#state !== "reading" && this.#state !== "ended"; }
  get recoveryRequired(): boolean { return this.#destructive && this.#state !== "ended"; }
  async read(graph: CheckpointInput, payloads: CheckpointInput, signal?: AbortSignal): Promise<void> {
    if (this.#state !== "open") invalid("Checkpoint restore is not open");
    this.#state = "reading";
    let retirement: Promise<void> | undefined;
    const retire = (): Promise<void> => retirement ??= (async () => {
      const results = await Promise.allSettled([Promise.resolve().then(() => graph.retire()), Promise.resolve().then(() => payloads.retire())]);
      if (results.some(result => result.status === "rejected")) throw new VMError("STORAGE_ERROR", "Checkpoint producers did not retire");
    })();
    const cancel = () => { void retire().catch(() => {}); };
    signal?.addEventListener("abort", cancel, { once: true });
    let failure: { readonly error: unknown } | undefined;
    try {
      active(signal);
      const payloadReader = new StreamReader(payloads, signal);
      const count = await this.#payloadHeader(payloadReader);
      await this.#graph(new StreamReader(graph, signal), signal);
      active(signal);
      // The native phase is set before its first allocation after dropping the old heap.
      try { this.#raw.ok("metadata_complete", this.#token); }
      finally {
        const phase = this.#raw.u32("restore_phase", this.#token);
        if (phase < 1 || phase > 4) invalid("Native checkpoint restore phase is invalid");
        this.#destructive ||= phase >= 2;
      }
      await this.#payloads(payloadReader, count, signal);
      this.#state = "ready";
    } catch (error) { failure = { error }; }
    finally { signal?.removeEventListener("abort", cancel); }
    try { await retire(); } catch (error) { failure ??= { error }; }
    if (failure !== undefined) { this.#state = "failed"; throw this.#failure(failure.error); }
  }
  /** Initial startup may discard its unpublished candidate; native origin admission
   * refuses this for a restore begun from a caller-owned live session. */
  discardStartup():void {
    if(this.#state === "reading" || this.#state === "ended")invalid("Startup candidate cannot be discarded in this phase");
    this.#beforePublish();this.#raw.ok("restore_discard",this.#token);
    this.#state="ended";this.#destructive=false;this.#ended();
  }
  prepare():void {
    if(this.#state!=="ready")invalid("Checkpoint candidate requires every imported frame");
    if(this.#prepared)return;
    try{this.#raw.ok("restore_prepare",this.#token);this.#prepared=true;}
    catch(error){this.#state="failed";throw this.#failure(error);}
  }
  beginReconcile(snapshot:string,preservedId?:string):UserspaceReconcile {
    if(this.#state!=="ready" || !this.#prepared)invalid("Workspace reconciliation requires a prepared unpublished candidate");
    return new UserspaceReconcile(this.#raw,this.#token,snapshot,preservedId);
  }
  exportWorkspace(): CandidateWorkspaceExport {
    if(this.#state!=="ready" || !this.#prepared)invalid("Workspace export requires a prepared unpublished candidate");
    return new UserspaceCandidateWorkspace(this.#raw,this.#token);
  }
  validateAttachment(attachment: Pick<NativeAttachment, "pid" | "terminal" | "pending">): NativeAttachment["terminal"] {
    if (this.#state !== "ready") invalid("Checkpoint attachment requires a complete unpublished candidate");
    const pid = integer(attachment.pid, "checkpoint attachment PID", 1, 0x7fff_ffff);
    const count = attachment.pending === undefined ? 0n : BigInt(integer(attachment.pending.count, "checkpoint pending bytes", 1, Number.MAX_SAFE_INTEGER));
    this.#raw.ok("attachment_validate", this.#token, pid, attachment.terminal === undefined ? 0 : 1,
      attachment.pending?.stream === "stdout" ? count : 0n, attachment.pending?.stream === "stderr" ? count : 0n);
    if (attachment.terminal === undefined) return undefined;
    this.#raw.ok("attachment_terminal", this.#token, pid);
    const bytes = this.#raw.frame();
    if (bytes.length === 0) return undefined;
    if (bytes.length !== 16) invalid("Native checkpoint terminal geometry is malformed");
    const view = new DataView(bytes.buffer);
    for (let offset = 0; offset < 16; offset += 4) integer(view.getUint32(offset, true), "native terminal geometry", 0, 65535);
    return { columns: view.getUint32(0, true), rows: view.getUint32(4, true) };
  }
  complete(): void {
    if (this.#state !== "ready") invalid("Checkpoint restore has not received every frame");
    try { this.#beforePublish(); this.#raw.ok("restore_complete", this.#token); }
    catch (error) { throw this.#failure(error); }
    this.#state = "ended"; this.#ended();
  }
  abort(): void {
    if (this.#state === "ended") return;
    if (this.#state === "reading") invalid("Cancel the checkpoint read and await it before aborting");
    try { this.#raw.ok("abort", this.#token); } catch (error) { throw this.#failure(error); }
    this.#state = "ended"; this.#ended();
    if (this.#destructive) throw new VMError("STORAGE_ERROR", "Checkpoint restore requires the committed recovery point", { reason: "checkpoint-recovery-required", recoveryRequired: true });
  }
  #failure(error: unknown): unknown {
    return this.#destructive ? new VMError("STORAGE_ERROR", "Checkpoint restore requires the committed recovery point", { reason: "checkpoint-recovery-required", recoveryRequired: true }) : error;
  }
  async #graph(input: StreamReader, signal?: AbortSignal): Promise<void> {
    const envelope = await input.read(12); checkHeader(envelope, "OXUG");
    const count = new DataView(envelope.buffer).getUint32(8, true);
    if (count < 2 || count > 4097 || input.remaining < count * 9) invalid("Checkpoint graph frame count is invalid");
    for (let index = 0; index < count; index++) {
      const framing = await input.read(8), view = new DataView(framing.buffer), length = view.getUint32(4, true);
      if (view.getUint32(0, true) !== index || length === 0 || length > FRAME_BYTES || index === 0 && length !== 49) invalid("Checkpoint graph frame sequence is invalid");
      const bytes = await input.read(length);
      if (index < 2) checkHeader(bytes, index === 0 ? "OXWA" : "OXUC");
      active(signal); this.#raw.stage(bytes); this.#raw.ok("metadata_push", this.#token, index, length);
    }
    await input.finish();
  }
  async #payloadHeader(input: StreamReader): Promise<bigint> {
    const envelope = await input.read(16); checkHeader(envelope, "OXUP");
    const count = new DataView(envelope.buffer).getBigUint64(8, true);
    if (count > 8n * 1024n * 1024n || count * 24n > BigInt(input.remaining)) invalid("Checkpoint payload count is invalid");
    return count;
  }
  async #payloads(input: StreamReader, count: bigint, signal?: AbortSignal): Promise<void> {
    let previous = 0n;
    for (let index = 0n; index < count; index++) {
      const { reference, length } = decodeCheckpointDeclaration(await input.read(24), previous);
      if (length > BigInt(input.remaining)) invalid("Checkpoint payload exceeds remaining bytes");
      previous = reference;
      for (let offset = 0n; offset < length;) {
        const remaining = length - offset;
        const bytes = await input.read(remaining > BigInt(FRAME_BYTES) ? FRAME_BYTES : Number(remaining));
        active(signal); this.#raw.stage(bytes); this.#raw.ok("payload_push", this.#token, reference, offset, bytes.length); offset += BigInt(bytes.length);
      }
    }
    await input.finish();
  }
}
