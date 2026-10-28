import { decodeUserspaceWorkspaceExport } from "../../userspace-persistence-abi.js";
import { workspaceBytesInput, type WorkspaceStreamInput } from "../workspace-stream.js";
import type { CheckpointRaw } from "./raw.js";
import { active, invalid } from "./stream.js";

export interface CandidateWorkspaceExport {
  readonly snapshot: WorkspaceStreamInput;
  readonly delta: WorkspaceStreamInput;
  complete(committed: boolean): void;
}

/** Export retirement releases the producer; only the durable selection acknowledges its revision. */
export class UserspaceCandidateWorkspace implements CandidateWorkspaceExport {
  readonly snapshot: WorkspaceStreamInput;
  readonly delta = workspaceBytesInput(new Uint8Array([79, 88, 87, 68, 3, 0, 0, 0, 0, 0, 0, 0]));
  readonly #raw: Pick<CheckpointRaw, "ok" | "frame">;
  readonly #token: bigint;
  readonly #id: bigint;
  #opened = false;
  #retired = false;
  #drained = false;
  #ended = false;
  constructor(raw: Pick<CheckpointRaw, "ok" | "frame">, token: bigint) {
    this.#raw = raw; this.#token = token;
    raw.ok("workspace_export_begin", token);
    const descriptor = decodeUserspaceWorkspaceExport(raw.frame());
    this.#id = descriptor.id;
    this.snapshot = { bytes: descriptor.bytes, source: signal => {
      if (this.#opened || this.#ended) invalid("Candidate workspace export is already consumed");
      this.#opened = true;
      return { frames: this.#frames(descriptor.bytes, signal), retire: () => {
        this.#retire(); return Promise.resolve();
      } };
    } };
  }
  async *#frames(expected: number, signal: AbortSignal): AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown> {
    let received = 0;
    for (;;) {
      active(signal);
      if (this.#retired || this.#ended) invalid("Candidate workspace producer is retired");
      this.#raw.ok("workspace_export_next", this.#token, this.#id);
      const frame = this.#raw.frame();
      if (frame.length === 0) {
        if (received !== expected) invalid("Candidate workspace ended before its declared length");
        this.#drained = true; return;
      }
      if (frame.length > 65536 || frame.length > expected - received) invalid("Candidate workspace frame exceeds its declared bound");
      received += frame.length;
      yield await Promise.resolve(frame);
    }
  }
  #retire(): void {
    if (!this.#retired) {
      this.#raw.ok("workspace_export_retire", this.#token, this.#id);
      this.#retired = true;
    }
  }
  complete(committed: boolean): void {
    if (this.#ended) return;
    if (committed && (!this.#drained || !this.#retired)) invalid("Candidate workspace publication requires a drained retired producer");
    this.#retire();
    this.#raw.ok("workspace_publication_complete", this.#token, this.#id, committed ? 1 : 0);
    this.#ended = true;
  }
}
