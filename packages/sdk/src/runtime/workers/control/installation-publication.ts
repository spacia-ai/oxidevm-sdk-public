import { VMError, serializeUnknownError } from "../../errors.js";
import type { WorkspacePublication, WorkspacePublicationResult } from "../../protocol/workspace-publication.js";
import type { SnapshotStorageClient } from "../snapshot-channel.js";
import type { GuestAgent } from "./guest-agent.js";

export interface InstallationActivation {
  readonly agent: Pick<GuestAgent, "cancel">;
  readonly requestId: number;
}

/** The guest's own materialized tree becomes the committed generation under
 * the identity storage assigned to its captured bytes. */
export interface LocalActivation extends InstallationActivation {
  readonly activate: (identity: { readonly generation: string; readonly inputsSha256: string }) => Promise<void>;
}

/** Staging owns the storage grant until Linux activates its materialized tree
 * and storage confirms finalization. An uncertain native change fences
 * admission even when storage can safely return its grant. Reopen restores
 * the durable selection. */
export async function activateInstallationPublication(storage: SnapshotStorageClient, publication: WorkspacePublication,
  activation: LocalActivation, signal: AbortSignal): Promise<WorkspacePublicationResult> {
  const staged = await storage.stageWorkspace(publication, signal);
  if (staged.kind === "finished") return staged.result;
  const identity = { session: publication.credit.session, generation: publication.credit.generation, transfer: publication.credit.reservation };
  let activated = false;
  let finalizing = false;
  const cancelled = (): boolean => signal.aborted;
  const cancel = (): void => activation.agent.cancel(activation.requestId);
  const abortStage = async (): Promise<WorkspacePublicationResult> => {
    const result = await storage.finishWorkspaceStage(identity, "abort");
    return { ...result, outcome: result.outcome.kind === "failed" ? result.outcome : { kind: "failed", error: { code: "ABORTED", message: "Dependency activation abandoned" } } };
  };
  try {
    if (!Number.isSafeInteger(activation.requestId) || activation.requestId < 1) {
      throw new VMError("PROTOCOL_ERROR", "Dependency activation requires a nonzero request identity");
    }
    const dependencies = staged.selection.dependencies;
    if (dependencies === undefined || publication.dependencies === undefined
      || dependencies.inputsSha256 !== publication.dependencies.inputsSha256) {
      throw new VMError("PROTOCOL_ERROR", "Staged dependency input identity does not match installation");
    }
    if (cancelled()) throw new VMError("ABORTED", "Dependency activation cancelled");
    signal.addEventListener("abort", cancel, { once: true });
    activated = true;
    try { await activation.activate({ generation: dependencies.generation, inputsSha256: dependencies.inputsSha256 }); }
    finally { signal.removeEventListener("abort", cancel); }
    if (cancelled()) throw new VMError("ABORTED", "Dependency activation cancelled");
    finalizing = true;
    const result = await storage.finishWorkspaceStage(identity, "commit");
    if (result.outcome.kind === "failed") return { ...result, outcome: { kind: "failed",
      error: { ...result.outcome.error, detail: { ...result.outcome.error.detail, activationUncertain: true } } } };
    if (result.outcome.generation !== staged.selection.generation || result.outcome.dependencyGeneration !== dependencies.generation) {
      return { ...result, outcome: { kind: "failed", error: { code: "PROTOCOL_ERROR",
        message: "Published dependency identity differs from native activation", detail: { committed: true, activationUncertain: true } } } };
    }
    return result;
  } catch (error) {
    const failure = serializeUnknownError(error);
    try {
      // Once commit begins, neither an abort nor a lost reply proves rollback.
      if (finalizing) throw error;
      const result = await abortStage();
      return { ...result, outcome: { kind: "failed", error: { ...failure, detail: {
        ...failure.detail, ...(result.outcome.kind === "failed" ? result.outcome.error.detail : {}),
        ...(activated ? { activationUncertain: true } : {}),
      } } } };
    } catch {
      throw new VMError(failure.code, failure.message, { ...failure.detail, cleanupFailed: true,
        ...(activated ? { activationUncertain: true } : {}) });
    }
  }
}
