import { VMError, serializeUnknownError } from "../errors.js";
import { WORKSPACE_PUBLICATION_BYTES, type WorkspacePublication, type WorkspacePublicationResult } from "../protocol/workspace-publication.js";
import type { AssistanceBinding } from "../protocol/assistance.js";
import type { AssistanceTraffic } from "./control/assistance-traffic.js";
import type { WorkspaceStreamInput, WorkspaceStreams } from "./workspace-stream.js";
import { transferWorkspaceStream, receiveWorkspaceStream } from "./workspace-transfer.js";

/** Shared publication transport for installation and stop-and-flush. Storage
 * remains the sole durable manifest owner; omitted dependencies retain its
 * current immutable generation. */
export async function publishWorkspaceCaptures(publish: (publication: WorkspacePublication, signal: AbortSignal) => Promise<WorkspacePublicationResult>,
  input: { readonly binding: AssistanceBinding; readonly workspaceBaseSha256: string;
    readonly snapshot: WorkspaceStreams["snapshot"]; readonly delta: WorkspaceStreamInput;
    readonly dependencies?: { readonly inputsSha256: string; readonly tree: WorkspaceStreamInput } },
  traffic: AssistanceTraffic, signal: AbortSignal,
): Promise<WorkspacePublicationResult> {
  const { binding, workspaceBaseSha256 } = input;
  const credit = traffic.grant({ ...binding, producer: "storage", process: null,
    pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
  const transfers: ReturnType<typeof transferWorkspaceStream>[] = [];
  let dispatched = false;
  let returned = false;
  try {
    if (credit.reservation > Math.floor((0xffff_ffff - 2) / 3)) throw new VMError("QUOTA_EXCEEDED", "Publication transfer identity exhausted");
    const reuse = "reuse" in input.snapshot ? input.snapshot : undefined;
    const sources = [...("reuse" in input.snapshot ? [] : [input.snapshot]), input.delta, ...(input.dependencies === undefined ? [] : [input.dependencies.tree])];
    for (const [index, source] of sources.entries()) transfers.push(transferWorkspaceStream(source, binding, credit.reservation * 3 + index, traffic));
    const snapshot = reuse ?? transfers[0]?.descriptor;
    const delta = transfers[reuse === undefined ? 1 : 0];
    const tree = transfers[reuse === undefined ? 2 : 1];
    if (snapshot === undefined || delta === undefined || (input.dependencies !== undefined && tree === undefined)) {
      throw new VMError("PROTOCOL_ERROR", "Missing publication capture");
    }
    const publication = { workspaceBaseSha256, credit, snapshot, delta: delta.descriptor,
      ...(input.dependencies === undefined || tree === undefined ? {} : { dependencies: { inputsSha256: input.dependencies.inputsSha256, tree: tree.descriptor } }) };
    dispatched = true;
    const result = await publish(publication, signal);
    if (!result.retired) throw new VMError("STORAGE_ERROR", "Publication retirement is uncertain");
    await Promise.all(transfers.map(transfer => transfer.finished));
    traffic.returnCredit(result.credit);
    returned = true;
    if (input.dependencies !== undefined && result.outcome.kind === "committed" && result.outcome.dependencyGeneration === undefined) {
      throw new VMError("PROTOCOL_ERROR", "Committed dependency identity is missing", { committed: true });
    }
    const detail = result.outcome.kind === "failed" ? result.outcome.error.detail : undefined;
    if (detail?.["activationUncertain"] === true || detail?.["cleanupFailed"] === true || detail?.["committed"] === true || detail?.["reason"] === "workspace-publication-uncertain") {
      throw new VMError("STORAGE_ERROR", "Publication outcome requires recovery", detail);
    }
    return result;
  } catch (error) {
    if (!dispatched) {
      try {
        await Promise.all(transfers.map(transfer => receiveWorkspaceStream(transfer.descriptor, binding,
          transfer.descriptor.transfer).source(signal).retire()));
        await Promise.all(transfers.map(transfer => transfer.finished));
        traffic.returnCredit({ ...credit, kind: "return" });
        returned = true;
      } catch { /* Unconfirmed ownership remains reserved and fences below. */ }
    }
    if (dispatched || !returned) {
      const failure = serializeUnknownError(error);
      throw new VMError(failure.code, failure.message, { ...failure.detail, cleanupFailed: true });
    }
    throw error;
  }
}
