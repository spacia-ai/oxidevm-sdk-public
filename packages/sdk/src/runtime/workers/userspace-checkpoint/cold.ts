import type { CheckpointRaw } from "./raw.js";
import { UserspaceReconcile } from "./reconcile.js";
import { invalid } from "./stream.js";
import { UserspaceCandidateWorkspace, type CandidateWorkspaceExport } from "./workspace-export.js";

/** A process-free mounted runtime remains unpublished until its durable files commit. */
export class UserspaceCold {
  readonly #raw: Pick<CheckpointRaw, "ok" | "stage" | "u64" | "frame">;
  readonly #token: bigint;
  readonly #ended: () => void;
  readonly #beforePublish: () => void;
  #state: "open" | "failed" | "ended" = "open";
  constructor(raw: Pick<CheckpointRaw, "ok" | "stage" | "u64" | "frame">, token: bigint, ended: () => void, beforePublish: () => void) {
    this.#raw = raw; this.#token = token; this.#ended = ended; this.#beforePublish = beforePublish;
  }
  beginReconcile(sourceId: string): UserspaceReconcile {
    this.#open(); return new UserspaceReconcile(this.#raw, this.#token, sourceId);
  }
  exportWorkspace(): CandidateWorkspaceExport {
    this.#open(); return new UserspaceCandidateWorkspace(this.#raw, this.#token);
  }
  complete(): void {
    this.#open();
    try { this.#beforePublish(); this.#raw.ok("cold_complete", this.#token); }
    catch (error) { this.#state = "failed"; throw error; }
    this.#state = "ended"; this.#ended();
  }
  /** Successful discard leaves no installed runtime. The caller must remount or dispose. */
  abort(): void {
    if (this.#state === "ended") return;
    this.#raw.ok("cold_abort", this.#token);
    this.#state = "ended"; this.#ended();
  }
  #open(): void { if (this.#state !== "open") invalid("Cold runtime candidate is not open"); }
}
