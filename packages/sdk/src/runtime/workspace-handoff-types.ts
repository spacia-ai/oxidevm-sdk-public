import type {VMError} from "./errors.js";

/** What asking for a workspace came to: the other tab let it go, or no tab answered in time. */
export type WorkspaceHandoffResult = "released" | "no-response";

export interface WorkspaceHandoffOptions {
  readonly signal?: AbortSignal;
  /** How long to wait for the tab that holds the workspace to answer (default 10 s). */
  readonly timeoutMs?: number;
}

/** What a VM that handed its workspace to another tab reports. */
export interface WorkspaceMovedAway {
  /** Whether the running VM was saved first, so the other tab resumes it. */
  readonly saved: boolean;
  /** Legacy failure detail; failed saves now reject the requester without moving this VM. */
  readonly error?: VMError;
}
