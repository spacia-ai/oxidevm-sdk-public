import { VMError } from "../../errors.js";
import { WORKSPACE_PUBLICATION_BYTES } from "../../protocol/workspace-publication.js";
import type { WorkspaceReadLease } from "../workspace-read.js";
import type { AssistanceBinding } from "../../protocol/assistance.js";
import type { SnapshotStorageClient } from "../snapshot-channel.js";
import { openWorkspaceRead } from "../workspace-read-client.js";
import type { AssistanceTraffic } from "./assistance-traffic.js";
import type { GuestAgent } from "./guest-agent.js";

export async function restoreStoredWorkspace(agent: Pick<GuestAgent, "supportsStreamedRestore" | "applyWorkspaceStream">,
  storage: SnapshotStorageClient, traffic: AssistanceTraffic,
  options: { readonly binding: AssistanceBinding; readonly base: string; readonly requestId: number; readonly signal: AbortSignal }): Promise<boolean> {
  if (!agent.supportsStreamedRestore) return false;
  const credit = traffic.grant({ ...options.binding, producer: "storage", process: null,
    pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
  let read: Awaited<ReturnType<typeof openWorkspaceRead>>;
  try { read = await openWorkspaceRead(storage, { workspaceBaseSha256: options.base, credit }, options.signal); }
  catch (error) {
    if (error instanceof VMError && error.detail?.["readRetired"] === true) traffic.returnCredit({ ...credit, kind: "return" });
    throw error;
  }
  try {
    if (options.signal.aborted) throw new VMError("ABORTED", "Workspace restoration cancelled");
    const delta = read.selection?.delta;
    const snapshot = read.selection?.snapshot;
    if (snapshot !== undefined) await agent.applyWorkspaceStream(options.requestId, "snapshot", snapshot);
    if (delta !== undefined) await agent.applyWorkspaceStream(options.requestId, "delta", delta);
    const dependencies = read.selection?.dependencies;
    if (dependencies !== undefined) await restoreDependencyStream(agent, options.requestId, dependencies);
    return true;
  } finally { traffic.returnCredit(await read.retire()); }
}

export function restoreDependencyStream(agent: Pick<GuestAgent, "applyWorkspaceStream">, requestId: number,
  dependencies: NonNullable<WorkspaceReadLease["dependencies"]>): Promise<void> {
  return agent.applyWorkspaceStream(requestId,
    { kind: "dependencies", generation: digestBytes(dependencies.generation), inputs: digestBytes(dependencies.inputsSha256) }, dependencies.tree);
}

export function digestBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new VMError("PROTOCOL_ERROR", "Invalid restored dependency identity");
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}
