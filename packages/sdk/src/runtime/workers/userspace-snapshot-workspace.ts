import { workspacePublicationTransfers } from "../protocol/workspace-publication.js";
import { deserializeError } from "../errors.js";
import { decodeWorkspacePublicationResult } from "../protocol/workspace-publication.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import type { CandidateWorkspaceExport } from "./userspace-checkpoint.js";
import type { SnapshotStorageClient } from "./snapshot-channel.js";
import { publishWorkspaceCaptures } from "./workspace-publication-client.js";

/** The private generation is staged here. The restore transaction alone selects and acknowledges it. */
export async function stageCandidateWorkspace(storage: Pick<SnapshotStorageClient, "request">,
  exported: CandidateWorkspaceExport, base: string, preservedId: string | undefined,
  signal = new AbortController().signal, coldSourceId?: string): Promise<void> {
  const result = await publishWorkspaceCaptures(async (publication, cancellation) => {
    const sources = workspacePublicationTransfers(publication);
    return decodeWorkspacePublicationResult(await storage.request(coldSourceId === undefined ? { type: "stage-native-workspace", publication,
      ...(preservedId === undefined ? {} : { preservedId }) } : {type:"stage-native-cold-workspace",sourceId:coldSourceId,publication,preserve:preservedId!==undefined},
      sources.flatMap(source => [source.stream, source.retirementPort]), cancellation));
  }, { binding: { session: crypto.randomUUID(), generation: 1 }, workspaceBaseSha256: base,
    snapshot: exported.snapshot, delta: exported.delta }, new AssistanceTraffic(7), signal);
  if (result.outcome.kind === "failed") throw deserializeError(result.outcome.error);
}
