import { VMError } from "../../errors.js";
import { CaptureFrames } from "./capture-frames.js";
import type { CheckpointRaw } from "./raw.js";
import { active, invalid, type CheckpointSink } from "./stream.js";
export type CheckpointPayloadSink = (index: number, bytes: Uint8Array<ArrayBuffer>) => Promise<void>;

/** Dirty round bytes remain speculative until their storage stream is sealed and committed. */
export class UserspacePrecopy {
  readonly #raw: CheckpointRaw; readonly #token: bigint; readonly #ended: () => void;
  #round = 1;
  #state: "ready" | "transferring" | "received" | "committed" | "final" | "failed" | "ended" = "ready";
  constructor(raw: CheckpointRaw, token: bigint, ended: () => void) { this.#raw = raw; this.#token = token; this.#ended = ended; }

  async transferRound(sink: CheckpointPayloadSink, signal?: AbortSignal): Promise<{ readonly round: number; readonly payloadBytes: number }> {
    if (this.#state !== "ready" && this.#state !== "committed" || this.#state === "committed" && this.#round >= 3) invalid("Checkpoint precopy cannot start another round");
    active(signal); const advance = this.#state === "committed"; this.#state = "transferring";
    try {
      if (advance) {
        const round = this.#raw.u32("precopy_round", this.#token); this.#raw.ok("status");
        if (round !== this.#round + 1) invalid("Native precopy round sequence is invalid");
        this.#round = round;
      }
      const payloadBytes = await new CaptureFrames(this.#raw, this.#token, this.#round).payloads((_area, index, bytes) => sink(index, bytes), signal);
      this.#state = "received"; return { round: this.#round - 1, payloadBytes };
    } catch (error) { throw this.#failed(error); }
  }
  /** Call only after this round's complete storage stream has been durably sealed. */
  commitRound(): void {
    if (this.#state !== "received") invalid("Checkpoint precopy round has not been transferred");
    try { this.#raw.ok("precopy_commit_round", this.#token, this.#round); }
    catch (error) { throw this.#failed(error); }
    this.#state = "committed";
  }
  async finalize(sink: CheckpointSink, liveIndex: CheckpointPayloadSink, signal?: AbortSignal): Promise<{
    readonly round: number; readonly graphBytes: number; readonly payloadBytes: number; readonly liveIndexBytes: number;
  }> {
    if (this.#state !== "committed") invalid("Checkpoint precopy requires a committed round before final freeze");
    active(signal); this.#state = "transferring";
    try {
      this.#raw.ok("precopy_finalize", this.#token); this.#round++;
      const frames = new CaptureFrames(this.#raw, this.#token, this.#round);
      const graphBytes = await frames.graph(sink, signal), payloadBytes = await frames.payloads(sink, signal);
      const liveIndexBytes = await frames.liveIndex(liveIndex, signal);
      this.#state = "final"; return { round: this.#round - 1, graphBytes, payloadBytes, liveIndexBytes };
    } catch (error) { throw this.#failed(error); }
  }
  finish(committed: boolean): void {
    if (this.#state !== "final") invalid("Checkpoint precopy has not completed its final transfer");
    this.#raw.ok("capture_finish", this.#token, committed ? 1 : 0);
    this.#state = "ended"; this.#ended();
  }
  abort(): void {
    if (this.#state === "ended") return;
    if (this.#state === "transferring") invalid("Cancel and await the precopy transfer before aborting");
    this.#raw.ok("abort", this.#token); this.#state = "ended"; this.#ended();
  }
  #failed(error: unknown): unknown {
    this.#state = "failed";
    if (error instanceof VMError && error.code !== "PROTOCOL_ERROR") return error;
    return new VMError("STORAGE_ERROR", "Precopy source changed before its round completed; discard all rounds before a fresh frozen capture", {
      reason: "checkpoint-precopy-failed", discardRounds: true,
    });
  }
}
