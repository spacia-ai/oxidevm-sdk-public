import type { CheckpointRaw } from "./raw.js";
import { active, invalid, type CheckpointSink } from "./stream.js";
import { CaptureFrames } from "./capture-frames.js";

export class UserspaceCapture {
  readonly #raw: CheckpointRaw; readonly #token: bigint; readonly #ended: () => void;
  #state: "open" | "transferring" | "transferred" | "ended" = "open";
  constructor(raw: CheckpointRaw, token: bigint, ended: () => void) { this.#raw = raw; this.#token = token; this.#ended = ended; }
  async transfer(sink: CheckpointSink, signal?: AbortSignal): Promise<{ readonly graphBytes: number; readonly payloadBytes: number }> {
    if (this.#state !== "open") invalid("Checkpoint capture is not open");
    active(signal); this.#state = "transferring";
    try {
      const frames = new CaptureFrames(this.#raw, this.#token);
      const graphBytes = await frames.graph(sink, signal);
      const payloadBytes = await frames.payloads(sink, signal);
      this.#state = "transferred";
      return { graphBytes, payloadBytes };
    } catch (error) { this.#state = "open"; throw error; }
  }
  finish(committed: boolean): void {
    if (this.#state === "ended" || this.#state === "transferring" || committed && this.#state !== "transferred") invalid("Checkpoint capture cannot finish in this phase");
    this.#raw.ok("capture_finish", this.#token, committed ? 1 : 0);
    this.#state = "ended"; this.#ended();
  }
  abort(): void {
    if (this.#state === "ended") return;
    if (this.#state === "transferring") invalid("Cancel the checkpoint transfer and await it before aborting");
    this.#raw.ok("abort", this.#token); this.#state = "ended"; this.#ended();
  }
}
