import { workspacePublicationTransfers } from "../protocol/workspace-publication.js";
import type {WorkspaceReadLease} from "./workspace-read.js";
import { normalizeStorageError, serializeUnknownError, VMError } from "../errors.js";
import type { WorkspacePublication, WorkspacePublicationResult, WorkspaceTransferDescriptor } from "../protocol/workspace-publication.js";
import type { WorkspaceStore, WorkspaceStagedPublication } from "./workspace-store.js";
import type { WorkspaceStageResult } from "../protocol/workspace-stage.js";
import { openWorkspaceStreams } from "./workspace-stream.js";
import { receiveWorkspaceStream, retireWorkspaceTransfer } from "./workspace-transfer.js";
import { WorkspaceReadSession } from "./workspace-read-session.js";
import type { WorkspaceReadIdentity, WorkspaceReadKind, WorkspaceReadRequest, WorkspaceReadSelection } from "../protocol/workspace-read.js";
import type { AssistanceCredit } from "../protocol/assistance-credit.js";
import type { WorkspaceStorageRequest } from "./snapshot-channel.js";

export type WorkspaceStorageValue = WorkspaceReadSelection<number> | WorkspacePublicationResult | AssistanceCredit | Uint8Array<ArrayBuffer> | undefined;

/** One storage worker serves one VM. Sequence state belongs to this consumer,
 * not to individual transferred streams. Uncertain cleanup fences all writes. */
export class WorkspacePublications {
  #last: WorkspacePublication["credit"] | undefined;
  #failure: VMError | undefined;
  #read: { credit: AssistanceCredit; session: WorkspaceReadSession } | undefined;
  #staged: { credit: AssistanceCredit; stage: WorkspaceStagedPublication; session: WorkspaceReadSession; selection: WorkspaceReadSelection<number> } | undefined;

  assertActive(): void { if (this.#failure !== undefined) throw this.#failure; }

  handle(store: WorkspaceStore | undefined, request: WorkspaceStorageRequest, signal: AbortSignal,selected?: (selection:NonNullable<WorkspaceReadRequest["selection"]>,base:string,signal:AbortSignal)=>Promise<WorkspaceReadLease|undefined>): Promise<WorkspaceStorageValue> {
    switch (request.type) {
      case "open-workspace-read": return this.openRead(store, request.input, signal,selected);
      case "read-workspace-frame": return this.read(request.identity, request.source, request.offset, signal);
      case "retire-workspace-source": return this.retireReadSource(request.identity, request.source).then(() => undefined);
      case "retire-workspace-read": return this.retireRead(request.identity);
      case "commit-workspace-streams": return this.commit(store, request.publication, signal);
    }
  }

  #accept(credit: AssistanceCredit): void {
    this.assertActive();
    const last = this.#last;
    if (last !== undefined && (credit.session !== last.session || credit.generation < last.generation
      || (credit.generation === last.generation && (credit.sequence <= last.sequence || credit.reservation <= last.reservation)))) {
      this.#failure = new VMError("PROTOCOL_ERROR", "Stale workspace publication credit; reopen the VM", { cleanupFailed: true });
      throw this.#failure;
    }
    this.#last = credit;
  }

  async #acceptPublication(input: WorkspacePublication): Promise<void> {
    try { this.#accept(input.credit); }
    catch (error) {
      const transfers = workspacePublicationTransfers(input);
      const retired = await Promise.allSettled(transfers.map(retireWorkspaceTransfer));
      if (retired.some(result => result.status === "rejected")) {
        this.#failure = new VMError("STORAGE_ERROR", "Rejected workspace producers did not retire; reopen the VM", { cleanupFailed: true });
        throw this.#failure;
      }
      throw error;
    }
  }

  async openRead(store: WorkspaceStore | undefined, input: WorkspaceReadRequest, signal: AbortSignal,selected?: (selection:NonNullable<WorkspaceReadRequest["selection"]>,base:string,signal:AbortSignal)=>Promise<WorkspaceReadLease|undefined>): Promise<WorkspaceReadSelection<number> | undefined> {
    if (this.#read !== undefined) throw new VMError("PROTOCOL_ERROR", "Workspace read already owns a generation");
    this.#accept(input.credit);
    const session = new WorkspaceReadSession(signal => {
      if(input.selection!==undefined) {
        if(selected===undefined)throw new VMError("FEATURE_NOT_AVAILABLE","Retained workspace selection is unavailable");
        return selected(input.selection,input.workspaceBaseSha256,signal);
      }
      if (store === undefined) throw new VMError("STORAGE_ERROR", "Workspace overlay store is unavailable");
      return store.openRead(input.workspaceBaseSha256, signal);
    }, signal);
    this.#read = { credit: input.credit, session };
    return session.selection();
  }

  read(identity: WorkspaceReadIdentity, kind: WorkspaceReadKind, offset: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
    this.assertActive();
    return this.#requireRead(identity).session.read(kind, offset, signal);
  }

  async retireRead(identity: WorkspaceReadIdentity): Promise<AssistanceCredit> {
    if (this.#staged !== undefined && matches(this.#staged.credit, identity)) throw new VMError("PROTOCOL_ERROR", "Staged reads require publication finalization");
    const read = this.#requireRead(identity);
    await this.closeRead();
    return { ...read.credit, kind: "return" };
  }

  retireReadSource(identity: WorkspaceReadIdentity, kind: WorkspaceReadKind): Promise<void> {
    return this.#requireRead(identity).session.retireSource(kind);
  }

  async closeRead(): Promise<void> {
    const read = this.#read;
    if (read === undefined) return;
    try { await read.session.retire(); }
    catch {
      this.#failure = new VMError("STORAGE_ERROR", "Workspace read retirement is uncertain; reopen the VM", { cleanupFailed: true });
      throw this.#failure;
    }
    if (this.#read === read) this.#read = undefined;
  }

  #requireRead(identity: WorkspaceReadIdentity): { readonly credit: AssistanceCredit; readonly session: WorkspaceReadSession } {
    if (this.#staged !== undefined && matches(this.#staged.credit, identity)) return this.#staged;
    const read = this.#read;
    if (read === undefined || read.credit.session !== identity.session || read.credit.generation !== identity.generation
      || read.credit.reservation !== identity.transfer) throw new VMError("PROTOCOL_ERROR", "Stale workspace read identity");
    return read;
  }

  async stage(store: WorkspaceStore | undefined, input: WorkspacePublication, signal: AbortSignal): Promise<WorkspaceStageResult> {
    await this.#acceptPublication(input);
    let opened: Awaited<ReturnType<typeof openWorkspaceStreams>> | undefined;
    let stage: WorkspaceStagedPublication | undefined;
    let session: WorkspaceReadSession | undefined;
    try {
      opened = await receivePublication(input, signal);
      if (signal.aborted) throw new VMError("ABORTED", "Workspace staging cancelled before admission");
      if (this.#staged !== undefined) throw new VMError("PROTOCOL_ERROR", "Workspace already has a staged publication");
      if (store === undefined) throw new VMError("STORAGE_ERROR", "Workspace overlay store is unavailable");
      stage = await store.stageStreams(input.workspaceBaseSha256, opened.streams, signal);
      await opened.retire();
      const candidate = stage;
      session = new WorkspaceReadSession(signal => candidate.openRead(signal), signal);
      const selection = await session.selection();
      if (selection === undefined) throw new VMError("PROTOCOL_ERROR", "Staged workspace selection missing");
      this.#staged = { credit: input.credit, stage, session, selection };
      return { kind: "staged", selection };
    } catch (error) {
      let retired = false;
      let cause: unknown = error;
      try {
        await session?.retire();
        await stage?.abort();
        if (opened !== undefined) { await opened.retire(); retired = true; }
      } catch (cleanup) { cause = cleanup; }
      const failure = serializeUnknownError(normalizeStorageError(cause));
      if (!retired || failure.detail?.["cleanupFailed"] === true) {
        this.#failure = new VMError("STORAGE_ERROR", "Workspace staging retirement is uncertain; reopen the VM", { cleanupFailed: true });
        return { kind: "finished", result: { retired: false, outcome: { kind: "failed", error: serializeUnknownError(this.#failure) } } };
      }
      return { kind: "finished", result: { retired: true, credit: { ...input.credit, kind: "return" }, outcome: { kind: "failed", error: failure } } };
    }
  }

  async finishStage(identity: WorkspaceReadIdentity, decision: "commit" | "abort"): Promise<WorkspacePublicationResult> {
    const staged = this.#staged;
    if (staged === undefined || !matches(staged.credit, identity)) throw new VMError("PROTOCOL_ERROR", "Stale workspace staging identity");
    try {
      await staged.session.retire();
      let outcome: WorkspacePublicationResult["outcome"];
      if (decision === "commit") {
        this.assertActive();
        const generation = await staged.stage.commit();
        outcome = { kind: "committed", generation, ...(staged.selection.dependencies === undefined ? {} : { dependencyGeneration: staged.selection.dependencies.generation }) };
      } else {
        await staged.stage.abort();
        outcome = { kind: "failed", error: serializeUnknownError(new VMError("ABORTED", "Staged workspace publication cancelled")) };
      }
      this.#staged = undefined;
      return { retired: true, credit: { ...staged.credit, kind: "return" }, outcome };
    } catch (error) {
      this.#failure = new VMError("STORAGE_ERROR", "Workspace staging finalization is uncertain; reopen the VM", {
        ...serializeUnknownError(normalizeStorageError(error)).detail, cleanupFailed: true,
      });
      return { retired: false, outcome: { kind: "failed", error: serializeUnknownError(this.#failure) } };
    }
  }

  async close(): Promise<void> {
    await this.closeRead();
    const staged = this.#staged;
    if (staged === undefined) return;
    const result = await this.finishStage({ session: staged.credit.session, generation: staged.credit.generation, transfer: staged.credit.reservation }, "abort");
    if (!result.retired) throw this.#failure ?? new VMError("STORAGE_ERROR", "Workspace staging cleanup is uncertain", { cleanupFailed: true });
  }

  async commit(store: WorkspaceStore | undefined, input: WorkspacePublication, signal: AbortSignal): Promise<WorkspacePublicationResult> {
    await this.#acceptPublication(input);
    const result = await commitTransferredWorkspace(store, input, signal);
    const detail = result.outcome.kind === "failed" ? result.outcome.error.detail : undefined;
    if (!result.retired || detail?.["cleanupFailed"] === true || detail?.["committed"] === true
      || detail?.["reason"] === "workspace-publication-uncertain") {
      this.#failure = new VMError("STORAGE_ERROR", "Workspace publication outcome or retirement is uncertain; reopen the VM", { cleanupFailed: true });
    }
    return result;
  }
}

/** The storage worker serializes calls. Retire transferred producers even when
 * cancellation or unavailable storage prevents entry into WorkspaceStore. */
async function commitTransferredWorkspace(store: WorkspaceStore | undefined, input: WorkspacePublication,
  signal: AbortSignal): Promise<WorkspacePublicationResult> {
  let opened: Awaited<ReturnType<typeof openWorkspaceStreams>> | undefined;
  let outcome: WorkspacePublicationResult["outcome"];
  let committed = false;
  try {
    opened = await receivePublication(input, signal);
    if (signal.aborted) throw new VMError("ABORTED", "Workspace publication cancelled before admission");
    if (store === undefined) throw new VMError("STORAGE_ERROR", "Workspace overlay store is unavailable");
    const generation = await store.commitStreams(input.workspaceBaseSha256, opened.streams, signal);
    committed = true;
    // Cancellation cannot undo a confirmed commit. Read its identity without
    // letting a late abort masquerade as rollback.
    const dependencyGeneration = await store.dependencyGeneration(input.workspaceBaseSha256, new AbortController().signal);
    outcome = { kind: "committed", generation,
      ...(dependencyGeneration === undefined ? {} : { dependencyGeneration }) };
  } catch (error) {
    const failure = serializeUnknownError(normalizeStorageError(error));
    committed ||= failure.detail?.["committed"] === true;
    outcome = { kind: "failed", error: committed
      ? { ...failure, detail: { ...failure.detail, committed: true } } : failure };
  }
  try {
    if (opened === undefined) return { retired: false, outcome };
    await opened.retire();
    return { retired: true, credit: { ...input.credit, kind: "return" }, outcome };
  } catch (error) {
    const failure = serializeUnknownError(normalizeStorageError(error));
    return { retired: false, outcome: { kind: "failed", error: {
      ...failure, detail: { ...failure.detail, cleanupFailed: true, ...(committed ? { committed: true } : {}) },
    } } };
  }
}

export function receivePublication(input: WorkspacePublication, signal: AbortSignal) {
  const receive = (transfer: WorkspaceTransferDescriptor) => receiveWorkspaceStream(transfer, { session: input.credit.session, generation: input.credit.generation }, transfer.transfer);
  return openWorkspaceStreams({ snapshot: "reuse" in input.snapshot ? input.snapshot : receive(input.snapshot), delta: receive(input.delta),
    ...(input.dependencies === undefined ? {} : { dependencies: { inputsSha256: input.dependencies.inputsSha256, tree: receive(input.dependencies.tree) } }) }, signal);
}

function matches(credit: AssistanceCredit, identity: WorkspaceReadIdentity): boolean {
  return credit.session === identity.session && credit.generation === identity.generation && credit.reservation === identity.transfer;
}
